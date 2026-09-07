import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CandlesService } from '../candles/candles.service';
import { RealMarketStreamerService } from '../market-data/real-market-streamer.service';
import { TrailingEngine } from '@quant/trading-engine';
import {
  Direction,
  MarketDataUnavailableError,
  OrderState,
  PositionState,
  RiskRejectionReason,
  StaleMarketDataError,
  TradingMode,
  WS_EVENTS,
} from '@quant/shared';
import { Decimal } from '@prisma/client/runtime/library';
import {
  IExecutionProvider,
  IPaperOrderRequest,
  IPaperPosition,
  IPaperTradeHistory,
  IPaperPortfolio,
} from './execution-provider.interface';
import * as crypto from 'crypto';

export * from './execution-provider.interface';

@Injectable()
export class PaperTradingService implements IExecutionProvider {
  private readonly logger = new Logger(PaperTradingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly candlesService: CandlesService,
    @Optional() private readonly realMarketStreamer?: RealMarketStreamerService,
  ) {
    this.logger.log('Persistent Database-Backed Paper Trading Service Initialized.');
  }

  /**
   * Retrieves or initializes the primary PaperAccount from PostgreSQL.
   */
  async getOrCreateAccount(): Promise<any> {
    let account = await this.prisma.paperAccount.findFirst({
      where: { isActive: true },
    });

    if (!account) {
      account = await this.prisma.paperAccount.create({
        data: {
          name: 'Primary Paper Account',
          currency: 'INR',
          initialCapital: new Decimal(1000000.0),
          cashBalance: new Decimal(1000000.0),
          usedMargin: new Decimal(0.0),
          realizedPnL: new Decimal(0.0),
          totalChargesPaid: new Decimal(0.0),
          tradingMode: TradingMode.PAPER,
          isActive: true,
        },
      });
      this.logger.log(
        `Created primary paper trading account '${account.id}' with ₹10,00,000 balance.`,
      );
    }

    return account;
  }

  /**
   * Retrieves system trading configuration or defaults.
   */
  async getSystemConfig(): Promise<any> {
    let config = await this.prisma.tradingSystemConfig.findUnique({
      where: { id: 'SYSTEM_DEFAULT' },
    });

    if (!config) {
      config = await this.prisma.tradingSystemConfig.create({
        data: {
          id: 'SYSTEM_DEFAULT',
          paperTradingEnabled: true,
          liveTradingEnabled: false,
          emergencyStop: false,
          maxDailyLossPercent: new Decimal(3.0),
          maxPositionRiskPercent: new Decimal(1.0),
          maxTotalExposurePercent: new Decimal(20.0),
          maxOpenPositions: 5,
          maxTradesPerDay: 20,
          maxConsecutiveLosses: 3,
          maxLeverage: new Decimal(5.0),
          maxSlippageBps: 50,
          maxMarketDataAgeSeconds: 5,
        },
      });
    }

    return config;
  }

  /**
   * Calculates realistic Indian stock & crypto transaction charges (Brokerage, STT, GST, Exchange turnover)
   */
  public calculateCharges(
    turnover: number,
    isCrypto: boolean,
  ): {
    brokerage: number;
    stt: number;
    exchangeTurnover: number;
    gst: number;
    sebiTurnover: number;
    totalCharges: number;
  } {
    if (isCrypto) {
      const brokerage = Number((turnover * 0.001).toFixed(2)); // 0.1% Binance maker/taker fee
      const totalCharges = brokerage;
      return {
        brokerage,
        stt: 0,
        exchangeTurnover: 0,
        gst: 0,
        sebiTurnover: 0,
        totalCharges,
      };
    }

    const brokerage = 20.0;
    const stt = Number((turnover * 0.000125).toFixed(2));
    const exchangeTurnover = Number((turnover * 0.0000345).toFixed(2));
    const gst = Number(((brokerage + exchangeTurnover) * 0.18).toFixed(2));
    const sebiTurnover = Number((turnover * 0.000001).toFixed(2));
    const totalCharges = Number(
      (brokerage + stt + exchangeTurnover + gst + sebiTurnover).toFixed(2),
    );

    return {
      brokerage,
      stt,
      exchangeTurnover,
      gst,
      sebiTurnover,
      totalCharges,
    };
  }

  private normalizeSymbol(symbol: string): string {
    return symbol.trim().toUpperCase();
  }

  private toSignalDirection(direction: 'BUY' | 'SELL'): Direction {
    return direction === 'BUY' ? Direction.BULLISH : Direction.BEARISH;
  }

  /**
   * Validates and fetches authoritative live market price without any hardcoded fallback.
   * Throws MarketDataUnavailableError if price is stale or missing.
   */
  public async getValidatedMarketPrice(
    symbol: string,
    maxAgeSeconds = 5,
  ): Promise<{ price: number; timestamp: Date }> {
    const sym = this.normalizeSymbol(symbol);

    // 1. Try real market streamer
    if (this.realMarketStreamer) {
      try {
        const ticker = this.realMarketStreamer.getValidatedTicker(sym, maxAgeSeconds);
        if (ticker && ticker.price > 0) {
          return { price: ticker.price, timestamp: new Date(ticker.lastUpdated) };
        }
      } catch (err) {
        // Streamer check failed or threw stale error
        if (err instanceof StaleMarketDataError || err instanceof MarketDataUnavailableError) {
          throw err;
        }
      }
    }

    // 2. Try latest candle from candles service
    try {
      const candle = await this.candlesService.getLatestCandle(sym, '15m');
      if (candle && candle.close && Number(candle.close) > 0) {
        const candleAgeSeconds = (Date.now() - new Date(candle.timestamp).getTime()) / 1000;
        // For candle data, allow up to timeframe duration (e.g. 15m) or reject if strictly stale
        if (candleAgeSeconds > 3600) {
          throw new StaleMarketDataError(sym, candleAgeSeconds, 3600, new Date(candle.timestamp));
        }
        return { price: Number(candle.close), timestamp: new Date(candle.timestamp) };
      }
    } catch (err: any) {
      if (err instanceof StaleMarketDataError) throw err;
      this.logger.warn(`Failed to resolve candle price for ${sym}: ${err?.message}`);
    }

    // Fail closed: Never return fallback/hardcoded prices
    throw new MarketDataUnavailableError(
      sym,
      `No fresh live exchange market data available for execution. Hardcoded prices are strictly prohibited.`,
    );
  }

  /**
   * Strictly Read-Only Portfolio Retrieval.
   * Does NOT modify positions or trigger exits on GET.
   */
  async getPortfolio(): Promise<IPaperPortfolio> {
    const account = await this.getOrCreateAccount();

    const [openPositions, tradeHistory] = await Promise.all([
      this.prisma.paperPosition.findMany({
        where: {
          accountId: account.id,
          status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED] },
        },
        orderBy: { openedAt: 'desc' },
      }),
      this.prisma.paperTrade.findMany({
        where: { accountId: account.id },
        orderBy: { exitTime: 'desc' },
        take: 50,
      }),
    ]);

    let totalUnrealized = 0.0;
    let totalUsedMargin = 0.0;
    const formattedPositions: IPaperPosition[] = [];

    for (const pos of openPositions) {
      let livePrice = Number(pos.currentPrice);
      try {
        const marketPriceObj = await this.getValidatedMarketPrice(pos.symbol, 30);
        livePrice = marketPriceObj.price;
      } catch {
        // keep pos.currentPrice if live price fetch fails on read-only view
      }

      const entryPrice = Number(pos.entryPrice);
      const quantity = Number(pos.quantity);
      const isBuy = pos.direction === Direction.BULLISH;
      const priceDiff = isBuy ? livePrice - entryPrice : entryPrice - livePrice;
      const charges = (pos.chargesJson as any) || { totalCharges: 0 };
      const unrealizedPnL = Number((priceDiff * quantity - charges.totalCharges).toFixed(2));

      const stopLoss = pos.stopLoss ? Number(pos.stopLoss) : undefined;
      const initialStopLoss = pos.initialStopLoss ? Number(pos.initialStopLoss) : stopLoss;
      const riskAnchor = initialStopLoss ?? stopLoss;
      const riskDistance = riskAnchor ? Math.abs(entryPrice - riskAnchor) : entryPrice * 0.005;
      const unrealizedR = riskDistance > 0 ? Number((priceDiff / riskDistance).toFixed(2)) : 0;
      const notionalValue = Number((livePrice * quantity).toFixed(2));
      const usedMargin = Number(pos.usedMargin);

      // Dynamic Trailing Stop calculation for UI badge only
      const tp1 = pos.initialTarget1
        ? Number(pos.initialTarget1)
        : isBuy
          ? entryPrice * 1.015
          : entryPrice * 0.985;
      const tp2 = pos.initialTarget2
        ? Number(pos.initialTarget2)
        : isBuy
          ? entryPrice * 1.025
          : entryPrice * 0.975;
      const initialSl = initialStopLoss ?? (isBuy ? entryPrice * 0.99 : entryPrice * 1.01);

      const trailing = TrailingEngine.evaluate(
        entryPrice,
        initialSl,
        tp1,
        tp2,
        livePrice,
        isBuy ? 'BULLISH' : 'BEARISH',
      );

      formattedPositions.push({
        id: pos.id,
        accountId: pos.accountId,
        symbol: pos.symbol,
        contractSymbol: pos.contractSymbol,
        instrumentType: pos.instrumentType as any,
        strike: pos.strike ? Number(pos.strike) : undefined,
        optionType: (pos.optionType as any) || undefined,
        direction: isBuy ? 'BUY' : 'SELL',
        quantity,
        entryPrice,
        entryTime: pos.entryTime.toISOString(),
        averageEntryPrice: entryPrice,
        currentPrice: livePrice,
        stopLoss,
        initialStopLoss,
        target1: pos.target1 ? Number(pos.target1) : undefined,
        target2: pos.target2 ? Number(pos.target2) : undefined,
        target3: pos.target3 ? Number(pos.target3) : undefined,
        initialTarget1: pos.initialTarget1 ? Number(pos.initialTarget1) : undefined,
        initialTarget2: pos.initialTarget2 ? Number(pos.initialTarget2) : undefined,
        initialTarget3: pos.initialTarget3 ? Number(pos.initialTarget3) : undefined,
        leverage: Number(pos.leverage),
        unrealizedPnL,
        unrealizedR,
        notionalValue,
        usedMargin,
        maxFavorableExcursion: Number(pos.maxFavorableExcursion),
        maxAdverseExcursion: Number(pos.maxAdverseExcursion),
        openedAt: pos.openedAt.toISOString(),
        status: pos.status as PositionState,
        trailingStopState: {
          stage: trailing.stage,
          stageBadge: trailing.stageBadge,
          currentStopLoss: trailing.currentStopLoss,
          isRiskFree: trailing.isRiskFree,
          partialBookedPercent: trailing.partialBookedPercent,
          recommendedAction: trailing.recommendedAction,
        },
        charges,
      });

      totalUnrealized += unrealizedPnL;
      totalUsedMargin += usedMargin;
    }

    const cashBalance = Number(account.cashBalance);
    const availableMargin = Number((cashBalance - totalUsedMargin).toFixed(2));
    const totalEquity = Number((cashBalance + totalUnrealized).toFixed(2));

    const formattedHistory: IPaperTradeHistory[] = tradeHistory.map((t) => {
      const charges = (t.chargesJson as any) || { totalCharges: 0 };
      return {
        id: t.id,
        accountId: t.accountId,
        positionId: t.positionId || undefined,
        symbol: t.symbol,
        contractSymbol: t.contractSymbol,
        instrumentType: t.instrumentType as any,
        strike: t.strike ? Number(t.strike) : undefined,
        optionType: (t.optionType as any) || undefined,
        direction: t.direction === Direction.BULLISH ? 'BUY' : 'SELL',
        quantity: Number(t.quantity),
        entryPrice: Number(t.entryPrice),
        exitPrice: Number(t.exitPrice),
        realizedPnL: Number(t.realizedPnL),
        realizedR: Number(t.realizedR),
        maxFavorableExcursion: Number(t.maxFavorableExcursion),
        maxAdverseExcursion: Number(t.maxAdverseExcursion),
        holdingDurationSeconds: t.holdingDurationSeconds,
        exitReason: t.exitReason,
        openedAt: t.entryTime.toISOString(),
        closedAt: t.exitTime.toISOString(),
        totalCharges: charges.totalCharges || 0,
        correlationId: t.correlationId,
      };
    });

    const totalTrades = formattedHistory.length;
    const winningTrades = formattedHistory.filter((t) => t.realizedPnL > 0).length;
    const losingTrades = formattedHistory.filter((t) => t.realizedPnL <= 0).length;
    const winRate =
      totalTrades > 0 ? Number(((winningTrades / totalTrades) * 100).toFixed(1)) : 0.0;

    const grossWins = formattedHistory
      .filter((t) => t.realizedPnL > 0)
      .reduce((acc, t) => acc + t.realizedPnL, 0);
    const grossLosses = Math.abs(
      formattedHistory.filter((t) => t.realizedPnL < 0).reduce((acc, t) => acc + t.realizedPnL, 0),
    );
    const profitFactor =
      grossLosses > 0 ? Number((grossWins / grossLosses).toFixed(2)) : grossWins > 0 ? 99.9 : 0.0;

    return {
      accountId: account.id,
      initialCapital: Number(account.initialCapital),
      cashBalance,
      usedMargin: Number(totalUsedMargin.toFixed(2)),
      availableMargin,
      totalEquity,
      realizedPnL: Number(account.realizedPnL),
      unrealizedPnL: Number(totalUnrealized.toFixed(2)),
      totalChargesPaid: Number(account.totalChargesPaid),
      winRate,
      profitFactor,
      totalTrades,
      winningTrades,
      losingTrades,
      tradingMode: account.tradingMode as TradingMode,
      openPositions: formattedPositions,
      tradeHistory: formattedHistory,
    };
  }

  /**
   * Places a paper trading order with deterministic state machine, database persistence, and risk limit checks.
   */
  async placeOrder(req: IPaperOrderRequest): Promise<IPaperPosition> {
    if (!req.symbol || !req.direction || !req.quantity || req.quantity <= 0) {
      throw new BadRequestException(
        'Invalid order parameters: symbol, direction, and positive quantity required',
      );
    }

    const symbol = this.normalizeSymbol(req.symbol);
    const isCrypto = symbol === 'BTCUSDT';
    const correlationId =
      req.correlationId || `corr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const instrumentType = req.instrumentType || (req.strike ? 'OPTION' : 'SPOT');
    const contractSymbol =
      req.contractSymbol ||
      (req.strike && req.optionType ? `${symbol} ${req.strike} ${req.optionType}` : symbol);

    const account = await this.getOrCreateAccount();
    const config = await this.getSystemConfig();

    // 1. Check Global Kill Switch
    if (config.emergencyStop) {
      await this.recordAudit(
        'EMERGENCY_STOP',
        'CONFIG',
        config.id,
        { reason: 'Order rejected due to emergency stop activation' },
        correlationId,
      );
      throw new BadRequestException('Trading is currently halted by Emergency Stop Kill Switch.');
    }

    // 2. Idempotency Check
    const idempotencyKey =
      req.idempotencyKey ||
      `${account.id}_${symbol}_${req.direction}_${req.quantity}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const existingOrder = await this.prisma.paperOrder.findUnique({
      where: { idempotencyKey },
      include: { positions: true },
    });

    if (existingOrder) {
      this.logger.warn(
        `[DUPLICATE ORDER DETECTED] Order with key '${idempotencyKey}' already processed.`,
      );
      if (existingOrder.status === OrderState.FILLED && existingOrder.positions.length > 0) {
        const pos = existingOrder.positions[0];
        return this.mapDbPositionToInterface(pos);
      }
      throw new BadRequestException(
        `Duplicate order detected with status: ${existingOrder.status}`,
      );
    }

    // 3. Resolve Real Validated Execution Price (NO fake fallbacks)
    let executionPrice = req.price;
    let sourceTimestamp = new Date();

    if (!executionPrice || executionPrice <= 0) {
      try {
        const marketPriceData = await this.getValidatedMarketPrice(
          symbol,
          config.maxMarketDataAgeSeconds || 5,
        );
        executionPrice = marketPriceData.price;
        sourceTimestamp = marketPriceData.timestamp;
      } catch (err: any) {
        // Record rejected order in database
        await this.prisma.paperOrder.create({
          data: {
            accountId: account.id,
            symbol,
            contractSymbol,
            instrumentType,
            direction: this.toSignalDirection(req.direction),
            orderType: req.orderType || 'MARKET',
            requestedQuantity: new Decimal(req.quantity),
            status: OrderState.REJECTED,
            rejectionReason: RiskRejectionReason.MARKET_DATA_UNAVAILABLE,
            rejectionDetails: err.message,
            idempotencyKey,
            correlationId,
          },
        });

        await this.recordAudit(
          'ORDER_REJECTED',
          'ORDER',
          idempotencyKey,
          { symbol, reason: err.message },
          correlationId,
        );

        throw new BadRequestException(`Order Rejected: ${err.message}`);
      }
    }

    // 4. Directional SL / TP Validation (P0-4: Never silently create or alter SL/TP)
    const isBuy = req.direction === 'BUY';
    const stopLoss = req.stopLoss;
    const target1 = req.target1;
    const target2 = req.target2;
    const target3 = req.target3;

    // Check Missing Stop Loss
    if (stopLoss === undefined || stopLoss === null || stopLoss <= 0) {
      await this.rejectOrder(
        account.id,
        symbol,
        contractSymbol,
        instrumentType,
        req.direction,
        req.orderType,
        req.quantity,
        RiskRejectionReason.MISSING_STOP_LOSS,
        'Stop loss is required for paper trade execution. Default/fallback SL is prohibited.',
        idempotencyKey,
        correlationId,
      );
      throw new BadRequestException('Order Rejected [MISSING_STOP_LOSS]: Stop loss is required.');
    }

    // Check Invalid Stop Loss
    if (isBuy && stopLoss >= executionPrice) {
      await this.rejectOrder(
        account.id,
        symbol,
        contractSymbol,
        instrumentType,
        req.direction,
        req.orderType,
        req.quantity,
        RiskRejectionReason.INVALID_STOP_LOSS,
        `Stop loss (${stopLoss}) must be strictly below execution price (${executionPrice}) for BUY order`,
        idempotencyKey,
        correlationId,
      );
      throw new BadRequestException(
        `Order Rejected [INVALID_STOP_LOSS]: Stop loss (${stopLoss}) must be below execution price (${executionPrice}) for BUY.`,
      );
    }

    if (!isBuy && stopLoss <= executionPrice) {
      await this.rejectOrder(
        account.id,
        symbol,
        contractSymbol,
        instrumentType,
        req.direction,
        req.orderType,
        req.quantity,
        RiskRejectionReason.INVALID_STOP_LOSS,
        `Stop loss (${stopLoss}) must be strictly above execution price (${executionPrice}) for SELL order`,
        idempotencyKey,
        correlationId,
      );
      throw new BadRequestException(
        `Order Rejected [INVALID_STOP_LOSS]: Stop loss (${stopLoss}) must be above execution price (${executionPrice}) for SELL.`,
      );
    }

    // Check Missing Take Profit (target1)
    if (target1 === undefined || target1 === null || target1 <= 0) {
      await this.rejectOrder(
        account.id,
        symbol,
        contractSymbol,
        instrumentType,
        req.direction,
        req.orderType,
        req.quantity,
        RiskRejectionReason.MISSING_TAKE_PROFIT,
        'Take profit (target1) is required for paper trade execution. Default/fallback TP is prohibited.',
        idempotencyKey,
        correlationId,
      );
      throw new BadRequestException(
        'Order Rejected [MISSING_TAKE_PROFIT]: Take profit is required.',
      );
    }

    // Check Invalid Take Profit (target1)
    if (isBuy && target1 <= executionPrice) {
      await this.rejectOrder(
        account.id,
        symbol,
        contractSymbol,
        instrumentType,
        req.direction,
        req.orderType,
        req.quantity,
        RiskRejectionReason.INVALID_TAKE_PROFIT,
        `Target 1 (${target1}) must be strictly above execution price (${executionPrice}) for BUY order`,
        idempotencyKey,
        correlationId,
      );
      throw new BadRequestException(
        `Order Rejected [INVALID_TAKE_PROFIT]: Target 1 (${target1}) must be above execution price (${executionPrice}) for BUY.`,
      );
    }

    if (!isBuy && target1 >= executionPrice) {
      await this.rejectOrder(
        account.id,
        symbol,
        contractSymbol,
        instrumentType,
        req.direction,
        req.orderType,
        req.quantity,
        RiskRejectionReason.INVALID_TAKE_PROFIT,
        `Target 1 (${target1}) must be strictly below execution price (${executionPrice}) for SELL order`,
        idempotencyKey,
        correlationId,
      );
      throw new BadRequestException(
        `Order Rejected [INVALID_TAKE_PROFIT]: Target 1 (${target1}) must be below execution price (${executionPrice}) for SELL.`,
      );
    }

    // Check optional target2 & target3 relative validity
    if (target2 !== undefined && target2 !== null) {
      if ((isBuy && target2 <= target1) || (!isBuy && target2 >= target1)) {
        await this.rejectOrder(
          account.id,
          symbol,
          contractSymbol,
          instrumentType,
          req.direction,
          req.orderType,
          req.quantity,
          RiskRejectionReason.INVALID_TAKE_PROFIT,
          `Target 2 (${target2}) is invalid relative to Target 1 (${target1})`,
          idempotencyKey,
          correlationId,
        );
        throw new BadRequestException(
          `Order Rejected [INVALID_TAKE_PROFIT]: Invalid Target 2 relative to Target 1.`,
        );
      }
    }

    // 5. Hard Risk Limits Check (P0-11)
    // 5.1 Max Open Positions Limit
    const openPositionsCount = await this.prisma.paperPosition.count({
      where: {
        accountId: account.id,
        status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED] },
      },
    });

    if (openPositionsCount >= config.maxOpenPositions) {
      await this.rejectOrder(
        account.id,
        symbol,
        contractSymbol,
        instrumentType,
        req.direction,
        req.orderType,
        req.quantity,
        RiskRejectionReason.MAX_OPEN_POSITIONS,
        `Maximum open positions limit reached (${openPositionsCount} >= ${config.maxOpenPositions})`,
        idempotencyKey,
        correlationId,
      );
      throw new BadRequestException(
        `Order Rejected [MAX_OPEN_POSITIONS]: Maximum open positions limit reached (${config.maxOpenPositions}).`,
      );
    }

    // 5.2 Max Trades Per Day Limit
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const todayOrderCount = await this.prisma.paperOrder.count({
      where: {
        accountId: account.id,
        createdAt: { gte: startOfDay },
        status: { in: [OrderState.FILLED, OrderState.SUBMITTED, OrderState.PARTIALLY_FILLED] },
      },
    });

    if (todayOrderCount >= config.maxTradesPerDay) {
      await this.rejectOrder(
        account.id,
        symbol,
        contractSymbol,
        instrumentType,
        req.direction,
        req.orderType,
        req.quantity,
        RiskRejectionReason.MAX_TRADES_PER_DAY,
        `Maximum trades per day limit reached (${todayOrderCount} >= ${config.maxTradesPerDay})`,
        idempotencyKey,
        correlationId,
      );
      throw new BadRequestException(
        `Order Rejected [MAX_TRADES_PER_DAY]: Maximum trades per day reached (${config.maxTradesPerDay}).`,
      );
    }

    // 5.3 Max Consecutive Losses Limit
    const recentTrades = await this.prisma.paperTrade.findMany({
      where: { accountId: account.id },
      orderBy: { exitTime: 'desc' },
      take: config.maxConsecutiveLosses,
    });

    if (
      recentTrades.length >= config.maxConsecutiveLosses &&
      recentTrades.every((t) => Number(t.realizedPnL) <= 0)
    ) {
      await this.rejectOrder(
        account.id,
        symbol,
        contractSymbol,
        instrumentType,
        req.direction,
        req.orderType,
        req.quantity,
        RiskRejectionReason.MAX_CONSECUTIVE_LOSSES,
        `Maximum consecutive losses limit reached (${config.maxConsecutiveLosses} consecutive losses)`,
        idempotencyKey,
        correlationId,
      );
      throw new BadRequestException(
        `Order Rejected [MAX_CONSECUTIVE_LOSSES]: Cool-off triggered after ${config.maxConsecutiveLosses} consecutive losses.`,
      );
    }

    // 5.4 Position Risk Limit
    const riskPerUnit = Math.abs(executionPrice - stopLoss);
    const totalPositionRisk = riskPerUnit * req.quantity;
    const initialCapital = Number(account.initialCapital);
    const maxAllowedRiskAmount = initialCapital * (Number(config.maxPositionRiskPercent) / 100);

    if (totalPositionRisk > maxAllowedRiskAmount) {
      await this.rejectOrder(
        account.id,
        symbol,
        contractSymbol,
        instrumentType,
        req.direction,
        req.orderType,
        req.quantity,
        RiskRejectionReason.POSITION_RISK_LIMIT,
        `Position risk amount ₹${totalPositionRisk.toFixed(2)} exceeds allowed limit ₹${maxAllowedRiskAmount.toFixed(2)} (${config.maxPositionRiskPercent}% of ₹${initialCapital})`,
        idempotencyKey,
        correlationId,
      );
      throw new BadRequestException(
        `Order Rejected [POSITION_RISK_LIMIT]: Risk ₹${totalPositionRisk.toFixed(2)} exceeds allowed limit ₹${maxAllowedRiskAmount.toFixed(2)}.`,
      );
    }

    // 5.5 Max Daily Loss Limit
    const todayTrades = await this.prisma.paperTrade.findMany({
      where: {
        accountId: account.id,
        exitTime: { gte: startOfDay },
      },
    });
    const todayRealizedPnL = todayTrades.reduce((acc, t) => acc + Number(t.realizedPnL), 0);
    const maxDailyLossAllowed = initialCapital * (Number(config.maxDailyLossPercent) / 100);

    if (todayRealizedPnL < -maxDailyLossAllowed) {
      await this.rejectOrder(
        account.id,
        symbol,
        contractSymbol,
        instrumentType,
        req.direction,
        req.orderType,
        req.quantity,
        RiskRejectionReason.DAILY_LOSS_LIMIT,
        `Daily loss limit breached: Realized ₹${todayRealizedPnL.toFixed(2)} exceeds max daily loss ₹${maxDailyLossAllowed.toFixed(2)} (${config.maxDailyLossPercent}%)`,
        idempotencyKey,
        correlationId,
      );
      throw new BadRequestException(
        `Order Rejected [DAILY_LOSS_LIMIT]: Daily loss limit breached (₹${todayRealizedPnL.toFixed(2)} / ₹${maxDailyLossAllowed.toFixed(2)}).`,
      );
    }

    // 5.6 Max Leverage Check
    if (req.leverage && req.leverage > Number(config.maxLeverage)) {
      await this.rejectOrder(
        account.id,
        symbol,
        contractSymbol,
        instrumentType,
        req.direction,
        req.orderType,
        req.quantity,
        RiskRejectionReason.MAX_LEVERAGE,
        `Requested leverage ${req.leverage}x exceeds maximum configured leverage ${config.maxLeverage}x`,
        idempotencyKey,
        correlationId,
      );
      throw new BadRequestException(
        `Order Rejected [MAX_LEVERAGE]: Requested leverage ${req.leverage}x exceeds limit ${config.maxLeverage}x.`,
      );
    }

    // 5.7 Total Exposure Check & Margin Availability
    const turnover = executionPrice * req.quantity;
    const charges = this.calculateCharges(turnover, isCrypto);
    const effLeverage = Math.max(1, Math.min(req.leverage || 5, Number(config.maxLeverage)));
    const requiredMargin = Number((turnover / effLeverage + charges.totalCharges).toFixed(2));
    const currentUsedMargin = Number(account.usedMargin);
    const currentCashBalance = Number(account.cashBalance);
    const totalExposureAfterOrder = currentUsedMargin + requiredMargin;
    const maxExposureAllowed = initialCapital * (Number(config.maxTotalExposurePercent) / 100);

    if (totalExposureAfterOrder > maxExposureAllowed) {
      await this.rejectOrder(
        account.id,
        symbol,
        contractSymbol,
        instrumentType,
        req.direction,
        req.orderType,
        req.quantity,
        RiskRejectionReason.TOTAL_EXPOSURE_LIMIT,
        `Total portfolio exposure ₹${totalExposureAfterOrder.toFixed(2)} exceeds maximum limit ₹${maxExposureAllowed.toFixed(2)} (${config.maxTotalExposurePercent}%)`,
        idempotencyKey,
        correlationId,
      );
      throw new BadRequestException(
        `Order Rejected [TOTAL_EXPOSURE_LIMIT]: Total exposure ₹${totalExposureAfterOrder.toFixed(2)} exceeds limit ₹${maxExposureAllowed.toFixed(2)}.`,
      );
    }

    const currentAvailableMargin = currentCashBalance - currentUsedMargin;
    if (currentAvailableMargin < requiredMargin) {
      await this.rejectOrder(
        account.id,
        symbol,
        contractSymbol,
        instrumentType,
        req.direction,
        req.orderType,
        req.quantity,
        RiskRejectionReason.INSUFFICIENT_MARGIN,
        `Required margin: ₹${requiredMargin.toFixed(2)}, Available margin: ₹${currentAvailableMargin.toFixed(2)}`,
        idempotencyKey,
        correlationId,
      );
      throw new BadRequestException(
        `Insufficient margin. Required: ₹${requiredMargin.toFixed(2)}, Available: ₹${currentAvailableMargin.toFixed(2)}`,
      );
    }

    // 6. Execute Order & Persist Position inside Atomic Database Transaction
    const entryTime = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      // Create PaperOrder (FILLED)
      const order = await tx.paperOrder.create({
        data: {
          accountId: account.id,
          symbol,
          contractSymbol,
          instrumentType,
          strike: req.strike ? new Decimal(req.strike) : null,
          optionType: req.optionType,
          direction: this.toSignalDirection(req.direction),
          orderType: req.orderType || 'MARKET',
          requestedQuantity: new Decimal(req.quantity),
          filledQuantity: new Decimal(req.quantity),
          price: new Decimal(executionPrice),
          stopLoss: new Decimal(stopLoss),
          target1: new Decimal(target1),
          target2: target2 ? new Decimal(target2) : null,
          target3: target3 ? new Decimal(target3) : null,
          leverage: new Decimal(effLeverage),
          status: OrderState.FILLED,
          idempotencyKey,
          signalId: req.signalId,
          correlationId,
          submittedAt: entryTime,
        },
      });

      // Create PaperFill
      const fill = await tx.paperFill.create({
        data: {
          orderId: order.id,
          fillPrice: new Decimal(executionPrice),
          fillQuantity: new Decimal(req.quantity),
          fee: new Decimal(charges.totalCharges),
          feeBreakdownJson: charges,
          slippage: new Decimal(0.0),
          liquidityType: 'TAKER',
          sourceTimestamp,
          fillTimestamp: entryTime,
          correlationId,
        },
      });

      // Create PaperPosition
      const position = await tx.paperPosition.create({
        data: {
          accountId: account.id,
          orderId: order.id,
          symbol,
          contractSymbol,
          instrumentType,
          strike: req.strike ? new Decimal(req.strike) : null,
          optionType: req.optionType,
          direction: this.toSignalDirection(req.direction),
          quantity: new Decimal(req.quantity),
          entryPrice: new Decimal(executionPrice),
          entryTime,
          currentPrice: new Decimal(executionPrice),
          stopLoss: new Decimal(stopLoss),
          initialStopLoss: new Decimal(stopLoss),
          target1: new Decimal(target1),
          target2: target2 ? new Decimal(target2) : null,
          target3: target3 ? new Decimal(target3) : null,
          initialTarget1: new Decimal(target1),
          initialTarget2: target2 ? new Decimal(target2) : null,
          initialTarget3: target3 ? new Decimal(target3) : null,
          leverage: new Decimal(effLeverage),
          usedMargin: new Decimal(requiredMargin),
          unrealizedPnL: new Decimal(-charges.totalCharges),
          unrealizedR: new Decimal(0.0),
          maxFavorableExcursion: new Decimal(0.0),
          maxAdverseExcursion: new Decimal(0.0),
          status: PositionState.OPEN,
          chargesJson: charges,
          openedAt: entryTime,
          correlationId,
        },
      });

      // Update PaperAccount
      await tx.paperAccount.update({
        where: { id: account.id },
        data: {
          cashBalance: { decrement: charges.totalCharges },
          usedMargin: { increment: requiredMargin },
          totalChargesPaid: { increment: charges.totalCharges },
        },
      });

      // Create Audit Events
      await tx.auditEvent.createMany({
        data: [
          {
            actor: 'SYSTEM',
            service: 'PAPER_TRADING',
            eventType: 'ORDER_FILLED',
            entityType: 'ORDER',
            entityId: order.id,
            payloadJson: {
              symbol,
              direction: req.direction,
              quantity: req.quantity,
              executionPrice,
            },
            correlationId,
          },
          {
            actor: 'SYSTEM',
            service: 'PAPER_TRADING',
            eventType: 'POSITION_OPENED',
            entityType: 'POSITION',
            entityId: position.id,
            payloadJson: { contractSymbol, entryPrice: executionPrice, requiredMargin },
            correlationId,
          },
        ],
      });

      return position;
    });

    this.logger.log(
      `✓ [PERSISTED PAPER POSITION OPENED] ${req.direction} ${req.quantity} ${contractSymbol} @ ₹${executionPrice.toFixed(2)} (${effLeverage}x) | Margin: ₹${requiredMargin.toFixed(2)} | Corr: ${correlationId}`,
    );

    return this.mapDbPositionToInterface(result);
  }

  /**
   * Closes an existing paper position, books realized P&L, deducts exit charges, and persists PaperTrade in PostgreSQL.
   */
  async closePosition(
    positionId: string,
    exitReason = 'Manual Exit',
    exitPriceOverride?: number,
    correlationIdOverride?: string,
  ): Promise<IPaperTradeHistory> {
    const pos = await this.prisma.paperPosition.findUnique({
      where: { id: positionId },
      include: { account: true },
    });

    if (!pos || pos.status === PositionState.CLOSED) {
      throw new NotFoundException(
        `Active position with ID '${positionId}' not found or already closed`,
      );
    }

    const correlationId = correlationIdOverride || pos.correlationId || `corr_${Date.now()}`;
    const symbol = pos.symbol;
    const isCrypto = symbol === 'BTCUSDT';

    // Resolve live exit price
    let exitPrice = exitPriceOverride;
    if (!exitPrice || exitPrice <= 0) {
      try {
        const marketPriceData = await this.getValidatedMarketPrice(symbol, 15);
        exitPrice = marketPriceData.price;
      } catch {
        exitPrice = Number(pos.currentPrice);
      }
    }

    const exitTime = new Date();
    const quantity = Number(pos.quantity);
    const entryPrice = Number(pos.entryPrice);
    const exitTurnover = exitPrice * quantity;
    const exitCharges = this.calculateCharges(exitTurnover, isCrypto);
    const entryCharges = (pos.chargesJson as any) || { totalCharges: 0 };
    const totalCharges = Number((entryCharges.totalCharges + exitCharges.totalCharges).toFixed(2));

    const isBuy = pos.direction === Direction.BULLISH;
    const priceDiff = isBuy ? exitPrice - entryPrice : entryPrice - exitPrice;
    const grossPnL = priceDiff * quantity;
    const realizedPnL = Number((grossPnL - totalCharges).toFixed(2));

    const stopLoss = pos.stopLoss ? Number(pos.stopLoss) : undefined;
    const initialStopLoss = pos.initialStopLoss ? Number(pos.initialStopLoss) : stopLoss;
    const riskAnchor = initialStopLoss ?? stopLoss;
    const riskDistance = riskAnchor ? Math.abs(entryPrice - riskAnchor) : entryPrice * 0.005;
    const realizedR = riskDistance > 0 ? Number((priceDiff / riskDistance).toFixed(2)) : 0;
    const holdingDurationSeconds = Math.max(
      0,
      Math.floor((exitTime.getTime() - pos.entryTime.getTime()) / 1000),
    );

    // Determine outcome classification
    let outcomeClassification = 'MANUAL';
    if (exitReason.includes('TP3')) outcomeClassification = 'WIN_TP3_RUNNER';
    else if (exitReason.includes('TP2')) outcomeClassification = 'WIN_TP2';
    else if (exitReason.includes('TP1')) outcomeClassification = 'WIN_TP1';
    else if (exitReason.includes('Breakeven')) outcomeClassification = 'BREAKEVEN';
    else if (exitReason.includes('Stop Loss') || exitReason.includes('SL'))
      outcomeClassification = 'LOSS_SL';

    // Atomic Database Transaction for Position Closure
    const trade = await this.prisma.$transaction(async (tx) => {
      // 1. Mark Position CLOSED
      await tx.paperPosition.update({
        where: { id: pos.id },
        data: {
          status: PositionState.CLOSED,
          closedAt: exitTime,
          currentPrice: new Decimal(exitPrice),
          unrealizedPnL: new Decimal(0.0),
          unrealizedR: new Decimal(0.0),
        },
      });

      // 2. Create PaperTrade Record
      const tradeRecord = await tx.paperTrade.create({
        data: {
          accountId: pos.accountId,
          positionId: pos.id,
          symbol: pos.symbol,
          contractSymbol: pos.contractSymbol,
          instrumentType: pos.instrumentType,
          strike: pos.strike,
          optionType: pos.optionType,
          direction: pos.direction,
          quantity: pos.quantity,
          entryPrice: pos.entryPrice,
          exitPrice: new Decimal(exitPrice),
          realizedPnL: new Decimal(realizedPnL),
          realizedR: new Decimal(realizedR),
          maxFavorableExcursion: pos.maxFavorableExcursion,
          maxAdverseExcursion: pos.maxAdverseExcursion,
          holdingDurationSeconds,
          entryTime: pos.entryTime,
          exitTime,
          exitReason,
          chargesJson: { entryCharges, exitCharges, totalCharges },
          outcomeClassification,
          correlationId,
        },
      });

      // 3. Update PaperAccount Balance & Release Margin
      await tx.paperAccount.update({
        where: { id: pos.accountId },
        data: {
          cashBalance: { increment: grossPnL - exitCharges.totalCharges },
          usedMargin: { decrement: Number(pos.usedMargin) },
          realizedPnL: { increment: realizedPnL },
          totalChargesPaid: { increment: exitCharges.totalCharges },
        },
      });

      // 4. Audit Log
      await tx.auditEvent.create({
        data: {
          actor: 'SYSTEM',
          service: 'PAPER_TRADING',
          eventType: 'POSITION_CLOSED',
          entityType: 'TRADE',
          entityId: tradeRecord.id,
          payloadJson: {
            contractSymbol: pos.contractSymbol,
            entryPrice,
            exitPrice,
            realizedPnL,
            realizedR,
            exitReason,
          },
          correlationId,
        },
      });

      return tradeRecord;
    });

    this.logger.log(
      `✓ [PERSISTED PAPER POSITION CLOSED] ${pos.contractSymbol} @ ₹${exitPrice.toFixed(2)} | Net PnL: ₹${realizedPnL.toFixed(2)} (${realizedR}R) [${exitReason}]`,
    );

    return {
      id: trade.id,
      accountId: trade.accountId,
      positionId: trade.positionId || undefined,
      symbol: trade.symbol,
      contractSymbol: trade.contractSymbol,
      instrumentType: trade.instrumentType as any,
      strike: trade.strike ? Number(trade.strike) : undefined,
      optionType: (trade.optionType as any) || undefined,
      direction: trade.direction === Direction.BULLISH ? 'BUY' : 'SELL',
      quantity,
      entryPrice,
      exitPrice,
      realizedPnL,
      realizedR,
      maxFavorableExcursion: Number(trade.maxFavorableExcursion),
      maxAdverseExcursion: Number(trade.maxAdverseExcursion),
      holdingDurationSeconds,
      exitReason,
      openedAt: pos.entryTime.toISOString(),
      closedAt: exitTime.toISOString(),
      totalCharges,
      correlationId,
    };
  }

  /**
   * Resets the entire paper trading account balance and closes all active positions.
   */
  async resetPortfolio(initialCapital = 1000000.0): Promise<IPaperPortfolio> {
    const account = await this.getOrCreateAccount();

    await this.prisma.$transaction(async (tx) => {
      // Close all open positions
      await tx.paperPosition.updateMany({
        where: {
          accountId: account.id,
          status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED] },
        },
        data: {
          status: PositionState.CLOSED,
          closedAt: new Date(),
        },
      });

      // Reset Account Balances
      await tx.paperAccount.update({
        where: { id: account.id },
        data: {
          initialCapital: new Decimal(initialCapital),
          cashBalance: new Decimal(initialCapital),
          usedMargin: new Decimal(0.0),
          realizedPnL: new Decimal(0.0),
          totalChargesPaid: new Decimal(0.0),
        },
      });

      // Audit Log
      await tx.auditEvent.create({
        data: {
          actor: 'USER',
          service: 'PAPER_TRADING',
          eventType: 'ACCOUNT_RESET',
          entityType: 'ACCOUNT',
          entityId: account.id,
          payloadJson: { initialCapital },
          correlationId: `reset_${Date.now()}`,
        },
      });
    });

    this.logger.log(
      `Paper Trading Account '${account.id}' reset to initial capital: ₹${initialCapital.toLocaleString()}`,
    );
    return this.getPortfolio();
  }

  private async rejectOrder(
    accountId: string,
    symbol: string,
    contractSymbol: string,
    instrumentType: string,
    direction: 'BUY' | 'SELL',
    orderType: string | undefined,
    quantity: number,
    rejectionReason: RiskRejectionReason,
    rejectionDetails: string,
    idempotencyKey: string,
    correlationId: string,
  ) {
    try {
      await this.prisma.paperOrder.create({
        data: {
          accountId,
          symbol,
          contractSymbol,
          instrumentType,
          direction: this.toSignalDirection(direction),
          orderType: orderType || 'MARKET',
          requestedQuantity: new Decimal(quantity),
          status: OrderState.REJECTED,
          rejectionReason,
          rejectionDetails,
          idempotencyKey,
          correlationId,
        },
      });

      await this.recordAudit(
        'ORDER_REJECTED',
        'ORDER',
        idempotencyKey,
        { symbol, rejectionReason, rejectionDetails },
        correlationId,
      );
    } catch (e: any) {
      this.logger.warn(`Failed to record rejected order record: ${e.message}`);
    }
  }

  private async recordAudit(
    eventType: string,
    entityType: string,
    entityId: string,
    payload: any,
    correlationId: string,
  ) {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actor: 'SYSTEM',
          service: 'PAPER_TRADING',
          eventType,
          entityType,
          entityId,
          payloadJson: payload,
          correlationId,
        },
      });
    } catch (e: any) {
      this.logger.warn(`Failed to write audit event: ${e.message}`);
    }
  }

  private mapDbPositionToInterface(pos: any): IPaperPosition {
    const charges = (pos.chargesJson as any) || { totalCharges: 0 };
    return {
      id: pos.id,
      accountId: pos.accountId,
      symbol: pos.symbol,
      contractSymbol: pos.contractSymbol,
      instrumentType: pos.instrumentType,
      strike: pos.strike ? Number(pos.strike) : undefined,
      optionType: pos.optionType || undefined,
      direction: pos.direction === Direction.BULLISH ? 'BUY' : 'SELL',
      quantity: Number(pos.quantity),
      entryPrice: Number(pos.entryPrice),
      entryTime:
        pos.entryTime instanceof Date ? pos.entryTime.toISOString() : String(pos.entryTime),
      averageEntryPrice: Number(pos.entryPrice),
      currentPrice: Number(pos.currentPrice),
      stopLoss: pos.stopLoss ? Number(pos.stopLoss) : undefined,
      initialStopLoss: pos.initialStopLoss ? Number(pos.initialStopLoss) : undefined,
      target1: pos.target1 ? Number(pos.target1) : undefined,
      target2: pos.target2 ? Number(pos.target2) : undefined,
      target3: pos.target3 ? Number(pos.target3) : undefined,
      initialTarget1: pos.initialTarget1 ? Number(pos.initialTarget1) : undefined,
      initialTarget2: pos.initialTarget2 ? Number(pos.initialTarget2) : undefined,
      initialTarget3: pos.initialTarget3 ? Number(pos.initialTarget3) : undefined,
      leverage: Number(pos.leverage),
      unrealizedPnL: Number(pos.unrealizedPnL),
      unrealizedR: Number(pos.unrealizedR),
      notionalValue: Number((Number(pos.currentPrice) * Number(pos.quantity)).toFixed(2)),
      usedMargin: Number(pos.usedMargin),
      maxFavorableExcursion: Number(pos.maxFavorableExcursion),
      maxAdverseExcursion: Number(pos.maxAdverseExcursion),
      openedAt: pos.openedAt instanceof Date ? pos.openedAt.toISOString() : String(pos.openedAt),
      status: pos.status as PositionState,
      charges,
    };
  }
}
