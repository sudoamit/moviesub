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
  ExecutionPriceResolver,
  ExecutionPriceSource,
  MarketDataUnavailableError,
  OrderState,
  PositionState,
  RiskRejectionReason,
  StaleMarketDataError,
  TradingMode,
  WS_EVENTS,
  buildAccountingSnapshot,
  getAuthoritativeInstrument,
  hasInstrument,
  PointInTimeCurrencyConverter,
  resolveMarginModel,
  ExecutionAggregator,
  IFillRecord,
} from '@quant/shared';
import { TradeAccountingEngine } from '@quant/risk-engine';
import { Decimal } from '@prisma/client/runtime/library';
import {
  IExecutionProvider,
  IPaperOrderRequest,
  IPaperPosition,
  IPaperTradeHistory,
  IPaperPortfolio,
  IClosePositionOptions,
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

    // Fail closed: Never return fallback/hardcoded prices or historical candle closes for live execution
    throw new MarketDataUnavailableError(
      sym,
      `No fresh live exchange market data available for execution. Hardcoded prices and historical candle fallbacks are strictly prohibited.`,
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
      const riskDistance = riskAnchor ? Math.abs(entryPrice - riskAnchor) : 0;
      const unrealizedR = riskDistance > 0 ? Number((priceDiff / riskDistance).toFixed(2)) : 0;
      const notionalValue = Number((livePrice * quantity).toFixed(2));
      const usedMargin = Number(pos.usedMargin);

      // Trailing Stop evaluation (ONLY if explicit targets and SL exist on the position)
      let trailingStopState: any = undefined;
      if (initialStopLoss && pos.initialTarget1 && pos.initialTarget2) {
        const trailing = TrailingEngine.evaluate(
          entryPrice,
          Number(initialStopLoss),
          Number(pos.initialTarget1),
          Number(pos.initialTarget2),
          livePrice,
          isBuy ? 'BULLISH' : 'BEARISH',
        );
        trailingStopState = {
          stage: trailing.stage,
          stageBadge: trailing.stageBadge,
          currentStopLoss: trailing.currentStopLoss,
          isRiskFree: trailing.isRiskFree,
          partialBookedPercent: trailing.partialBookedPercent,
          recommendedAction: trailing.recommendedAction,
        };
      }

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
        featureSnapshotJson: pos.featureSnapshotJson || undefined,
        trailingStopState,
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
        featureSnapshotJson: (t.featureSnapshotJson as any) || undefined,
        outcomeSnapshotJson: (t.outcomeSnapshotJson as any) || undefined,
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

    // 3. Resolve Real Validated Execution Price with Mode Separation & Slippage
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

    // 4. Directional SL / TP Validation (Never silently create or alter SL/TP)
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

    // 5. Hard Risk Limits Check
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

    // 5.7 Slippage Simulation & Margin Accounting
    const slippageResult = ExecutionPriceResolver.calculateSlippage(
      executionPrice,
      req.direction,
      config.maxSlippageBps || 50,
    );
    const finalFillPrice = slippageResult.fillPrice;
    const slippageAmount = slippageResult.slippageAmount;

    const turnover = finalFillPrice * req.quantity;
    const charges = this.calculateCharges(turnover, isCrypto);
    const effLeverage = Math.max(1, Math.min(req.leverage || 5, Number(config.maxLeverage)));
    const requiredMargin = Number((turnover / effLeverage + charges.totalCharges).toFixed(2));
    const maxExposureAllowed = initialCapital * (Number(config.maxTotalExposurePercent) / 100);

    // 6. Execute Order & Persist Position inside Atomic Concurrency-Safe Transaction
    const orderSubmittedAt = new Date();
    const fillExecutionTime = new Date();
    const openingInst = getAuthoritativeInstrument(symbol);
    const openingQuoteCurrency = openingInst.currency;
    const openingConverter = PointInTimeCurrencyConverter.getInstance();
    const openingFxRes = openingConverter.getRate(openingQuoteCurrency, 'INR', fillExecutionTime.getTime());
    const openingMarginModel = resolveMarginModel(openingInst, { requestedLeverage: effLeverage });

    const openingAccountingSnapshot = buildAccountingSnapshot({
      accountCurrency: 'INR',
      quoteCurrency: openingQuoteCurrency,
      fxResult: openingFxRes,
      contractSize: openingInst.contractSize ?? 1,
      lotSize: Number(req.quantity),
      resolvedMarginModel: openingMarginModel,
      calculatedAt: fillExecutionTime.getTime(),
    });

    const result = await this.prisma.$transaction(async (tx) => {
      // Concurrency Lock: Re-read account inside atomic transaction
      const txAccount = await tx.paperAccount.findUnique({
        where: { id: account.id },
      });
      if (!txAccount) {
        throw new BadRequestException('Trading account not found');
      }

      const txCash = Number(txAccount.cashBalance);
      const txUsedMargin = Number(txAccount.usedMargin);
      const txAvailable = txCash - txUsedMargin;

      if (txAvailable < requiredMargin) {
        throw new BadRequestException(
          `[INSUFFICIENT_MARGIN] Concurrency check failed. Required: ₹${requiredMargin.toFixed(2)}, Available: ₹${txAvailable.toFixed(2)}`,
        );
      }

      const totalExposureAfterOrder = txUsedMargin + requiredMargin;
      if (totalExposureAfterOrder > maxExposureAllowed) {
        throw new BadRequestException(
          `[TOTAL_EXPOSURE_LIMIT] Concurrency check failed. Total exposure ₹${totalExposureAfterOrder.toFixed(2)} exceeds limit ₹${maxExposureAllowed.toFixed(2)}`,
        );
      }

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
          price: new Decimal(finalFillPrice),
          stopLoss: new Decimal(stopLoss),
          target1: new Decimal(target1),
          target2: target2 ? new Decimal(target2) : null,
          target3: target3 ? new Decimal(target3) : null,
          leverage: new Decimal(effLeverage),
          status: OrderState.FILLED,
          idempotencyKey,
          signalId: req.signalId,
          correlationId,
          submittedAt: orderSubmittedAt,
        },
      });

      // Create PaperFill with slippage & executionPriceSource
      const fill = await tx.paperFill.create({
        data: {
          orderId: order.id,
          fillPrice: new Decimal(finalFillPrice),
          fillQuantity: new Decimal(req.quantity),
          fee: new Decimal(charges.totalCharges),
          feeBreakdownJson: charges,
          slippage: new Decimal(slippageAmount),
          executionPriceSource: ExecutionPriceSource.LIVE_TICK,
          liquidityType: 'TAKER',
          sourceTimestamp,
          fillTimestamp: fillExecutionTime,
          correlationId,
        },
      });

      // Create PaperPosition strictly bound to PaperFill execution timestamp
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
          entryPrice: new Decimal(finalFillPrice),
          entryTime: fill.fillTimestamp,
          currentPrice: new Decimal(finalFillPrice),
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
          featureSnapshotJson: (req.featureSnapshotJson as any) || undefined,
          executionEventsJson: {
            accountingSnapshot: openingAccountingSnapshot as any,
          } as any,
          openedAt: fill.fillTimestamp,
          correlationId,
        },
      });

      // Atomically update PaperAccount balance & usedMargin
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
              quantity: req.quantity,
              fillPrice: finalFillPrice,
              executionPriceSource: ExecutionPriceSource.LIVE_TICK,
              sourceTimestamp: sourceTimestamp.toISOString(),
            },
            correlationId,
          },
          {
            actor: 'SYSTEM',
            service: 'PAPER_TRADING',
            eventType: 'POSITION_OPENED',
            entityType: 'POSITION',
            entityId: position.id,
            payloadJson: {
              symbol,
              quantity: req.quantity,
              entryPrice: finalFillPrice,
              leverage: effLeverage,
              usedMargin: requiredMargin,
            },
            correlationId,
          },
        ],
      });

      return position;
    });

    this.logger.log(
      `✓ [PERSISTED PAPER POSITION OPENED] ${req.direction} ${req.quantity} ${contractSymbol} @ ₹${finalFillPrice.toFixed(2)} (slip: ₹${slippageAmount.toFixed(2)}) (${effLeverage}x) | Margin: ₹${requiredMargin.toFixed(2)} | Corr: ${correlationId}`,
    );

    return this.mapDbPositionToInterface(result);
  }

  private mapDbTradeToInterface(trade: any): IPaperTradeHistory {
    const charges = (trade.chargesJson as any) || { totalCharges: 0 };
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
      quantity: Number(trade.quantity),
      entryPrice: Number(trade.entryPrice),
      exitPrice: Number(trade.exitPrice),
      realizedPnL: Number(trade.realizedPnL),
      realizedR: Number(trade.realizedR),
      maxFavorableExcursion: trade.maxFavorableExcursion ? Number(trade.maxFavorableExcursion) : undefined,
      maxAdverseExcursion: trade.maxAdverseExcursion ? Number(trade.maxAdverseExcursion) : undefined,
      holdingDurationSeconds: trade.holdingDurationSeconds || 0,
      exitReason: trade.exitReason,
      openedAt: new Date(trade.entryTime).toISOString(),
      closedAt: new Date(trade.exitTime).toISOString(),
      totalCharges: Number(charges.totalCharges || 0),
      featureSnapshotJson: (trade.featureSnapshotJson as any) || undefined,
      outcomeSnapshotJson: (trade.outcomeSnapshotJson as any) || undefined,
      correlationId: trade.correlationId,
    };
  }

  /**
   * Closes an existing paper position, books realized P&L, deducts exit charges, and persists PaperTrade in PostgreSQL.
   */
  async closePosition(
    positionId: string,
    exitReason = 'Manual Exit',
    options?: IClosePositionOptions | number,
    correlationIdOverride?: string,
  ): Promise<IPaperTradeHistory> {
    let exitPriceOverride: number | undefined;
    let allowPriceOverride = false;
    let correlationIdOpt: string | undefined;

    if (typeof options === 'number') {
      exitPriceOverride = options;
    } else if (options && typeof options === 'object') {
      exitPriceOverride = options.exitPriceOverride;
      allowPriceOverride = options.allowPriceOverride === true;
      correlationIdOpt = options.correlationId;
    }

    const pos = await this.prisma.paperPosition.findUnique({
      where: { id: positionId },
      include: { account: true },
    });

    if (!pos) {
      throw new NotFoundException(
        `Active position with ID '${positionId}' not found`,
      );
    }

    if (pos.status === PositionState.CLOSED) {
      // Idempotent retry: recognize and return existing completed PaperTrade
      const existingTrade = await this.prisma.paperTrade.findFirst({
        where: { positionId: pos.id },
        orderBy: { exitTime: 'desc' },
      });
      if (existingTrade) {
        return this.mapDbTradeToInterface(existingTrade);
      }
      throw new NotFoundException(
        `Active position with ID '${positionId}' is already closed, but no trade record exists.`,
      );
    }

    if (pos.status === PositionState.CLOSING) {
      throw new BadRequestException(
        `Position '${positionId}' is currently being closed by another request.`,
      );
    }

    const correlationId = correlationIdOverride || correlationIdOpt || pos.correlationId || `corr_${Date.now()}`;
    const symbol = pos.symbol;
    const isCrypto = symbol === 'BTCUSDT';
    const isGold = symbol === 'XAUUSD' || symbol === 'GOLD';
    const config = await this.getSystemConfig();

    // Resolve live exit price with strict fail-closed validation & LIVE_TICK provenance
    let exitPrice: number;
    let sourceTimestamp = new Date();
    let priceSource = ExecutionPriceSource.LIVE_TICK;

    if (allowPriceOverride && exitPriceOverride && exitPriceOverride > 0) {
      exitPrice = exitPriceOverride;
      priceSource = ExecutionPriceSource.SIMULATED_FILL;
    } else {
      try {
        const marketPriceData = await this.getValidatedMarketPrice(
          symbol,
          config.maxMarketDataAgeSeconds || 5,
        );
        exitPrice = marketPriceData.price;
        sourceTimestamp = marketPriceData.timestamp;
      } catch (err: any) {
        this.logger.error(
          `[EXIT REJECTED] Cannot close position '${pos.id}' for '${symbol}': ${err.message}`,
        );
        await this.prisma.paperPosition.update({
          where: { id: pos.id },
          data: { status: PositionState.EXIT_PENDING },
        });
        throw new BadRequestException(
          `Cannot close position for ${symbol}: Real-time market data unavailable (${err.message}). Position marked EXIT_PENDING.`,
        );
      }
    }

    // Apply exit slippage simulation
    const exitSlippage = ExecutionPriceResolver.calculateSlippage(
      exitPrice,
      pos.direction === Direction.BULLISH ? 'SELL' : 'BUY',
      config.maxSlippageBps || 50,
    );
    const finalExitPrice = exitSlippage.fillPrice;

    const exitTime = new Date();
    const quantity = Number(pos.quantity);
    const exitTurnover = finalExitPrice * quantity;
    const exitCharges = this.calculateCharges(exitTurnover, isCrypto);
    const entryCharges = (pos.chargesJson as any) || { totalCharges: 0 };
    const totalCharges = Number((entryCharges.totalCharges + exitCharges.totalCharges).toFixed(2));
    const isBuy = pos.direction === Direction.BULLISH;

    // Determine outcome classification
    let outcomeClassification = 'MANUAL';
    if (exitReason.includes('TP3')) outcomeClassification = 'WIN_TP3_RUNNER';
    else if (exitReason.includes('TP2')) outcomeClassification = 'WIN_TP2';
    else if (exitReason.includes('TP1')) outcomeClassification = 'WIN_TP1';
    else if (exitReason.includes('Breakeven')) outcomeClassification = 'BREAKEVEN';
    else if (exitReason.includes('Stop Loss') || exitReason.includes('SL'))
      outcomeClassification = 'LOSS_SL';

    let canonicalRealizedPnLLog = 0;
    let canonicalRealizedRLog = 0;
    let hasAuthoritativeFillsLog = false;

    // Atomic Database Transaction for Position Closure (with Concurrency / Double-Close Guard)
    const trade = await this.prisma.$transaction(async (tx) => {
      // 1. Atomic state transition: OPEN/EXIT_PENDING/PARTIALLY_CLOSED -> CLOSING
      const updated = await tx.paperPosition.updateMany({
        where: {
          id: pos.id,
          status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED, PositionState.EXIT_PENDING] },
        },
        data: {
          status: PositionState.CLOSING,
        },
      });

      if (updated.count === 0) {
        // Concurrency check: another worker/thread already closed this position!
        const existingTrade = await tx.paperTrade.findFirst({
          where: { positionId: pos.id },
          orderBy: { exitTime: 'desc' },
        });
        if (existingTrade) {
          return existingTrade;
        }
        throw new BadRequestException(`Position '${pos.id}' was already closed.`);
      }

      // 2. Create Exit PaperOrder
      const exitOrder = await tx.paperOrder.create({
        data: {
          accountId: pos.accountId,
          symbol,
          contractSymbol: pos.contractSymbol,
          instrumentType: pos.instrumentType,
          strike: pos.strike,
          optionType: pos.optionType,
          direction: this.toSignalDirection(isBuy ? 'SELL' : 'BUY'),
          orderType: 'MARKET',
          requestedQuantity: pos.quantity,
          filledQuantity: pos.quantity,
          price: new Decimal(finalExitPrice),
          status: OrderState.FILLED,
          idempotencyKey: `exit_order_${pos.id}_${Date.now()}`,
          correlationId,
          submittedAt: exitTime,
        },
      });

      // 3. Create Exit PaperFill
      const exitFill = await tx.paperFill.create({
        data: {
          orderId: exitOrder.id,
          fillPrice: new Decimal(finalExitPrice),
          fillQuantity: pos.quantity,
          fee: new Decimal(exitCharges.totalCharges),
          feeBreakdownJson: exitCharges,
          slippage: new Decimal(exitSlippage.slippageAmount),
          executionPriceSource: priceSource,
          liquidityType: 'TAKER',
          sourceTimestamp,
          fillTimestamp: exitTime,
          correlationId,
        },
      });

      // 4. Retrieve Entry Fills for Execution Aggregation (Strict: No Fabricated Fills)
      let entryFills: IFillRecord[] = [];
      if (pos.orderId && tx.paperFill && typeof tx.paperFill.findMany === 'function') {
        const rawFills = await tx.paperFill.findMany({ where: { orderId: pos.orderId } });
        entryFills = (rawFills || []).map((f) => ({
          fillId: f.id,
          orderId: f.orderId,
          positionId: pos.id,
          executionRole: 'ENTRY' as const,
          fillPrice: Number(f.fillPrice),
          fillQuantity: Number(f.fillQuantity),
          fillTimestamp: f.fillTimestamp,
          fee: Number(f.fee),
          slippage: Number(f.slippage),
          executionPriceSource: f.executionPriceSource,
          sourceTimestamp: f.sourceTimestamp,
        }));
      }

      const exitFillRecord: IFillRecord = {
        fillId: exitFill.id,
        orderId: exitOrder.id,
        positionId: pos.id,
        executionRole: 'EXIT',
        fillPrice: finalExitPrice,
        fillQuantity: Number(pos.quantity),
        fillTimestamp: exitTime,
        fee: exitCharges.totalCharges,
        slippage: exitSlippage.slippageAmount,
        executionPriceSource: priceSource,
        sourceTimestamp,
      };

      const hasAuthoritativeEntryFills = entryFills.length > 0;
      hasAuthoritativeFillsLog = hasAuthoritativeEntryFills;
      let aggregated: {
        entry: any;
        exit: any;
        durationMs: number | null;
        durationMinutes: number | null;
      };
      let isLegacyExecutionData = false;
      let executionDataComplete = true;

      if (hasAuthoritativeEntryFills) {
        aggregated = ExecutionAggregator.aggregateTradeLifecycle(entryFills, [exitFillRecord]);
      } else {
        // STRICT: Zero fabricated fill records. Missing entry execution represented strictly as null.
        // Duration and authoritative entry price are unknown.
        isLegacyExecutionData = true;
        executionDataComplete = false;
        const exitLeg = ExecutionAggregator.aggregateLeg([exitFillRecord], 'EXIT');
        aggregated = {
          entry: null,
          exit: exitLeg,
          durationMs: null,
          durationMinutes: null,
        };
      }

      // 5. Immutable Opening Accounting Snapshot & Canonical P&L
      const inst = getAuthoritativeInstrument(symbol);
      const quoteCurrency = inst.currency;
      const openingSnapshot =
        (pos.executionEventsJson as any)?.accountingSnapshot ??
        (pos.featureSnapshotJson as any)?.accountingSnapshot as any;

      const snapshot = openingSnapshot ?? buildAccountingSnapshot({
        accountCurrency: 'INR',
        quoteCurrency,
        fxResult: PointInTimeCurrencyConverter.getInstance().getRate(quoteCurrency, 'INR', exitTime.getTime()),
        contractSize: inst.contractSize ?? 1,
        lotSize: Number(pos.quantity),
        resolvedMarginModel: resolveMarginModel(inst, { requestedLeverage: Number(pos.leverage) || 1 }),
        calculatedAt: exitTime.getTime(),
      });

      const effectiveExitPrice = aggregated.exit.weightedPrice;
      let effectiveEntryPrice = Number(pos.entryPrice);
      let canonicalRealizedPnL = 0.0;
      let canonicalRealizedR = 0.0;
      let pnlCalc: any = null;

      if (hasAuthoritativeEntryFills && aggregated.entry) {
        effectiveEntryPrice = aggregated.entry.weightedPrice;
        pnlCalc = TradeAccountingEngine.calculateTradePnl({
          entryPrice: effectiveEntryPrice,
          exitPrice: effectiveExitPrice,
          quantity: Number(pos.quantity),
          direction: isBuy ? Direction.BULLISH : Direction.BEARISH,
          accountingSnapshot: snapshot,
          fees: totalCharges,
        });

        const stopLoss = pos.stopLoss ? Number(pos.stopLoss) : undefined;
        const initialStopLoss = pos.initialStopLoss ? Number(pos.initialStopLoss) : stopLoss;
        const riskAnchor = initialStopLoss ?? stopLoss;
        const riskDistance = riskAnchor ? Math.abs(effectiveEntryPrice - riskAnchor) : 0;

        canonicalRealizedPnL = pnlCalc.netPnlAccount;
        canonicalRealizedR =
          riskDistance > 0
            ? Number(((isBuy ? effectiveExitPrice - effectiveEntryPrice : effectiveEntryPrice - effectiveExitPrice) / riskDistance).toFixed(2))
            : 0;
      }

      canonicalRealizedPnLLog = canonicalRealizedPnL;
      canonicalRealizedRLog = canonicalRealizedR;

      // 6. Mark Position CLOSED
      await tx.paperPosition.update({
        where: { id: pos.id },
        data: {
          status: PositionState.CLOSED,
          closedAt: new Date(aggregated.exit.latestFillTimestamp),
          currentPrice: new Decimal(effectiveExitPrice),
          unrealizedPnL: new Decimal(0.0),
          unrealizedR: new Decimal(0.0),
        },
      });

      // 7. Create PaperTrade Record with Canonical Execution Facts
      const posEntryDate = pos.entryTime ? (pos.entryTime instanceof Date ? pos.entryTime : new Date(pos.entryTime)) : ((pos as any).openedAt ? (new Date((pos as any).openedAt)) : new Date());
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
          entryPrice: new Decimal(effectiveEntryPrice),
          exitPrice: new Decimal(effectiveExitPrice),
          realizedPnL: new Decimal(canonicalRealizedPnL),
          realizedR: new Decimal(canonicalRealizedR),
          maxFavorableExcursion: pos.maxFavorableExcursion,
          maxAdverseExcursion: pos.maxAdverseExcursion,
          holdingDurationSeconds: aggregated.durationMs !== null ? Math.max(0, Math.floor(aggregated.durationMs / 1000)) : 0,
          entryTime: aggregated.entry ? new Date(aggregated.entry.earliestFillTimestamp) : posEntryDate,
          exitTime: new Date(aggregated.exit.latestFillTimestamp),
          exitReason,
          chargesJson: {
            entryCharges,
            exitCharges,
            totalCharges: Number((entryCharges.totalCharges + exitCharges.totalCharges).toFixed(2)),
          },
          featureSnapshotJson: (pos.featureSnapshotJson as any) || undefined,
          outcomeSnapshotJson: {
            executionPriceSource: priceSource,
            sourceTimestamp: sourceTimestamp.toISOString(),
            livePrice: exitPrice,
            exitPrice: effectiveExitPrice,
            entryPrice: effectiveEntryPrice,
            requestedEntryPrice: Number(pos.entryPrice),
            actualEntryPrice: aggregated.entry ? aggregated.entry.weightedPrice : null,
            actualEntryPriceCurrency: aggregated.entry ? snapshot.quoteCurrency : null,
            entryTimeUtc: aggregated.entry ? aggregated.entry.earliestFillTimeUtc : null,
            actualExitPrice: aggregated.exit.weightedPrice,
            actualExitPriceCurrency: snapshot.quoteCurrency,
            exitTimeUtc: new Date(aggregated.exit.latestFillTimestamp).toISOString(),
            slippageBps: exitSlippage.slippageBps,
            slippageAmount: exitSlippage.slippageAmount,
            exitReason,
            realizedPnL: hasAuthoritativeEntryFills ? canonicalRealizedPnL : null,
            quotePnl: pnlCalc ? pnlCalc.quotePnl : null,
            quoteCurrency: snapshot.quoteCurrency,
            netPnlAccount: hasAuthoritativeEntryFills ? pnlCalc.netPnlAccount : null,
            accountCurrency: snapshot.accountCurrency,
            accountingSnapshot: snapshot as any,
            accountingSnapshotHash: snapshot.snapshotHash,
            realizedR: hasAuthoritativeEntryFills ? canonicalRealizedR : null,
            holdingDurationSeconds: aggregated.durationMs !== null ? Math.max(0, Math.floor(aggregated.durationMs / 1000)) : null,
            durationMs: aggregated.durationMs,
            durationMinutes: aggregated.durationMinutes,
            entryFillCount: aggregated.entry ? aggregated.entry.fillCount : 0,
            exitFillCount: aggregated.exit.fillCount,
            isLegacyExecutionData,
            executionDataComplete,
            outcomeClassification,
            exitTime: new Date(aggregated.exit.latestFillTimestamp).toISOString(),
            correlationId,
          },
          outcomeClassification,
          correlationId,
        },
      });

      // 8. Update PaperAccount Balance & Release Margin with Exact Cash Parity
      if (hasAuthoritativeEntryFills && pnlCalc) {
        const canonicalCashImpact = Number((pnlCalc.grossPnlAccount - exitCharges.totalCharges).toFixed(2));
        await tx.paperAccount.update({
          where: { id: pos.accountId },
          data: {
            cashBalance: { increment: canonicalCashImpact },
            usedMargin: { decrement: Number(pos.usedMargin) },
            realizedPnL: { increment: canonicalRealizedPnL },
            totalChargesPaid: { increment: exitCharges.totalCharges },
          },
        });
      } else {
        await tx.paperAccount.update({
          where: { id: pos.accountId },
          data: {
            cashBalance: { decrement: exitCharges.totalCharges },
            usedMargin: { decrement: Number(pos.usedMargin) },
            totalChargesPaid: { increment: exitCharges.totalCharges },
          },
        });
      }

      // 9. Audit Log
      await tx.auditEvent.create({
        data: {
          actor: 'SYSTEM',
          service: 'PAPER_TRADING',
          eventType: 'POSITION_CLOSED',
          entityType: 'TRADE',
          entityId: tradeRecord.id,
          payloadJson: {
            contractSymbol: pos.contractSymbol,
            entryPrice: effectiveEntryPrice,
            exitPrice: effectiveExitPrice,
            actualEntryPrice: aggregated.entry ? aggregated.entry.weightedPrice : null,
            actualExitPrice: aggregated.exit.weightedPrice,
            executionPriceSource: priceSource,
            sourceTimestamp: sourceTimestamp.toISOString(),
            realizedPnL: hasAuthoritativeEntryFills ? canonicalRealizedPnL : null,
            quotePnl: pnlCalc ? pnlCalc.quotePnl : null,
            quoteCurrency: snapshot.quoteCurrency,
            accountCurrency: snapshot.accountCurrency,
            accountingSnapshotHash: snapshot.snapshotHash,
            isLegacyExecutionData,
            executionDataComplete,
          },
          correlationId,
        },
      });

      return tradeRecord;
    });

    this.logger.log(
      `✓ [PERSISTED PAPER POSITION CLOSED] ${pos.contractSymbol} @ ₹${finalExitPrice.toFixed(2)} | Net PnL: ${hasAuthoritativeFillsLog ? `₹${canonicalRealizedPnLLog.toFixed(2)} (${canonicalRealizedRLog}R)` : 'Unavailable (Legacy)'} [${exitReason}]`,
    );

    return this.mapDbTradeToInterface(trade);
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
      featureSnapshotJson: pos.featureSnapshotJson || undefined,
      charges,
    };
  }
}
