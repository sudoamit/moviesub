import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Optional,
  OnModuleInit,
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
  isSupportedSpotSymbol,
  LEGACY_SPOT_ALIASES,
  TradeLifecycleState,
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
  ExecutionMode,
} from './execution-provider.interface';
import * as crypto from 'crypto';
import { isOptionsUnderlying } from '../algo-bots/option-contract-resolver';
import { TransactionCostScheduleManager, TransactionChargesBreakdown } from './transaction-cost-schedule-manager';
import { PositionValuationService } from './position-valuation.service';
import {
  TradeLifecycleService,
  AccountingService,
  PositionService,
  OrderService,
  FillService,
  ReconciliationService,
  MarginService,
  JournalService,
} from '../trading-domain';

export * from './execution-provider.interface';

@Injectable()
export class PaperTradingService implements IExecutionProvider, OnModuleInit {
  private readonly logger = new Logger(PaperTradingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly candlesService: CandlesService,
    @Optional() private readonly realMarketStreamer?: RealMarketStreamerService,
    @Optional() private tradeLifecycleService?: TradeLifecycleService,
    @Optional() private readonly accountingService?: AccountingService,
    @Optional() private readonly positionService?: PositionService,
    @Optional() private readonly orderService?: OrderService,
    @Optional() private readonly fillService?: FillService,
    @Optional() private readonly reconciliationService?: ReconciliationService,
    @Optional() private readonly marginService?: MarginService,
    @Optional() private readonly journalService?: JournalService,
  ) {
    if (!this.tradeLifecycleService && this.prisma) {
      this.tradeLifecycleService = new TradeLifecycleService(this.prisma);
    }
    this.logger.log('Persistent Database-Backed Paper Trading Service Initialized.');
  }

  async onModuleInit() {
    if (this.reconciliationService) {
      try {
        await this.reconciliationService.runStartupReconciliation();
      } catch (err: any) {
        this.logger.warn(`Startup reconciliation non-fatal: ${err.message}`);
      }
    }
  }

  /**
   * Retrieves or initializes the primary PaperAccount from PostgreSQL.
   */
  async getOrCreateAccount(): Promise<any> {
    let account = await this.prisma.paperAccount.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
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
  /**
   * Calculates realistic Indian stock & crypto transaction charges (Brokerage, STT, GST, Exchange turnover, SEBI, Stamp Duty)
   * Supporting all 7 instruments: NIFTY OPTION, BANKNIFTY OPTION, BTCUSDT_SPOT, XAUUSD, RELIANCE, HDFCBANK, INFY.
   */
  public calculateCharges(
    turnoverQuote: number,
    isCryptoOrInstrumentType: boolean | string = false,
    fxRate = 1.0,
    fxTimestamp = Date.now(),
    stage: 'ENTRY' | 'EXIT' | 'LIFECYCLE' = 'ENTRY',
    symbolOrType?: string,
  ): TransactionChargesBreakdown {
    const typeStr = typeof isCryptoOrInstrumentType === 'string'
      ? isCryptoOrInstrumentType.toUpperCase()
      : isCryptoOrInstrumentType === true
        ? 'CRYPTO'
        : 'EQUITY';

    const sym = (symbolOrType || '').toUpperCase().trim();
    const isCrypto =
      typeStr === 'CRYPTO' ||
      sym.includes('BTC') ||
      sym === 'BTCUSDT' ||
      sym === 'BTCUSDT_SPOT';
    const isGold =
      typeStr === 'COMMODITY' ||
      sym === 'XAUUSD' ||
      sym === 'GOLD';
    const isOption =
      typeStr === 'OPTION' ||
      sym.endsWith(' CE') ||
      sym.endsWith(' PE') ||
      sym.includes(' CE ') ||
      sym.includes(' PE ') ||
      (sym.startsWith('NIFTY') && (sym.includes('CE') || sym.includes('PE'))) ||
      (sym.startsWith('BANKNIFTY') && (sym.includes('CE') || sym.includes('PE')));

    const targetSymbol = isCrypto
      ? 'BTCUSDT_SPOT'
      : isGold
        ? 'XAUUSD'
        : isOption
          ? (sym || 'NIFTY')
          : (sym && sym !== 'NIFTY' && sym !== 'BANKNIFTY' ? sym : 'RELIANCE');

    const side = stage === 'ENTRY' ? 'BUY' : 'SELL';
    return TransactionCostScheduleManager.getInstance().calculateCostForSymbol(
      turnoverQuote,
      targetSymbol,
      fxRate,
      fxTimestamp,
      stage,
      side,
    );
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
          const ts = ticker.marketEventTime || ticker.lastUpdated || Date.now();
          return { price: ticker.price, timestamp: new Date(ts) };
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
   * Validates and fetches authoritative live option contract price without any hardcoded fallback.
   * Throws MarketDataUnavailableError or StaleMarketDataError if price is stale or missing.
   */
  public async getValidatedOptionPrice(
    contractSymbol: string,
    maxAgeSeconds = 5,
  ): Promise<{ price: number; timestamp: Date }> {
    const key = (contractSymbol || '').toUpperCase().trim();
    if (!key) {
      throw new MarketDataUnavailableError(
        'UNKNOWN_OPTION',
        'Option contract symbol is required to fetch option market price',
      );
    }

    if (this.realMarketStreamer) {
      try {
        let ticker =
          typeof this.realMarketStreamer.getOptionTicker === 'function'
            ? this.realMarketStreamer.getOptionTicker(key)
            : null;
        if (!ticker && typeof this.realMarketStreamer.getValidatedTicker === 'function') {
          ticker = this.realMarketStreamer.getValidatedTicker(key, maxAgeSeconds);
        }
        if (ticker && typeof ticker.price === 'number' && Number.isFinite(ticker.price) && ticker.price > 0) {
          const ts = ticker.marketEventTime || ticker.lastUpdated || Date.now();
          const ageMs = Date.now() - ts;
          if (ageMs > maxAgeSeconds * 1000) {
            throw new StaleMarketDataError(
              key,
              Math.round(ageMs / 1000),
              maxAgeSeconds,
              new Date(ts),
            );
          }
          return { price: ticker.price, timestamp: new Date(ts) };
        }
      } catch (err: any) {
        if (err instanceof StaleMarketDataError || err instanceof MarketDataUnavailableError) {
          throw err;
        }
      }
    }

    throw new MarketDataUnavailableError(
      key,
      `No fresh live option market data available for execution of ${key}. Fail closed.`,
    );
  }

  /**
   * Authoritative Live Quote Resolver across all 7 instruments:
   * - Options: exact contract symbol quote (getValidatedOptionPrice)
   * - Crypto spot: BTCUSDT_SPOT / BTCUSDT live tick
   * - Commodity spot: XAUUSD live tick
   * - Cash equities: RELIANCE, HDFCBANK, INFY live tick
   */
  public async resolveLivePositionQuote(
    pos: { symbol: string; contractSymbol?: string | null; instrumentType?: string | null; currentPrice?: any },
    maxAgeSeconds = 5,
  ): Promise<{ price: number; timestamp: Date; symbol: string }> {
    const rawSym = (pos.symbol || '').trim().toUpperCase();
    const contractSym = (pos.contractSymbol || '').trim().toUpperCase();
    const instType = (pos.instrumentType || '').trim().toUpperCase();

    const isOption =
      instType === 'OPTION' ||
      (contractSym.length > 0 && (contractSym.endsWith(' CE') || contractSym.endsWith(' PE') || contractSym.includes(' CE ') || contractSym.includes(' PE '))) ||
      rawSym.endsWith(' CE') ||
      rawSym.endsWith(' PE');

    // 1. Option contracts: resolve exact contract quote
    if (isOption) {
      const optKey = contractSym || rawSym;
      const optionQuote = await this.getValidatedOptionPrice(optKey, maxAgeSeconds);
      return {
        price: optionQuote.price,
        timestamp: optionQuote.timestamp,
        symbol: optKey,
      };
    }

    // 2. Crypto Spot: BTCUSDT / BTCUSDT_SPOT
    if (rawSym === 'BTCUSDT' || rawSym === 'BTCUSDT_SPOT' || rawSym === 'BTCUSD') {
      try {
        const quote = await this.getValidatedMarketPrice('BTCUSDT_SPOT', maxAgeSeconds);
        return {
          price: quote.price,
          timestamp: quote.timestamp,
          symbol: 'BTCUSDT_SPOT',
        };
      } catch {
        const quote = await this.getValidatedMarketPrice('BTCUSDT', maxAgeSeconds);
        return {
          price: quote.price,
          timestamp: quote.timestamp,
          symbol: 'BTCUSDT',
        };
      }
    }

    // 3. Commodity Spot: XAUUSD / GOLD
    if (rawSym === 'XAUUSD' || rawSym === 'GOLD') {
      const quote = await this.getValidatedMarketPrice(rawSym, maxAgeSeconds);
      return {
        price: quote.price,
        timestamp: quote.timestamp,
        symbol: rawSym,
      };
    }

    // 4. Cash Equities & other spot instruments: RELIANCE, HDFCBANK, INFY
    const quote = await this.getValidatedMarketPrice(rawSym, maxAgeSeconds);
    return {
      price: quote.price,
      timestamp: quote.timestamp,
      symbol: rawSym,
    };
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
        const liveQuote = await this.resolveLivePositionQuote(pos, 30);
        livePrice = liveQuote.price;
      } catch {
        // keep pos.currentPrice if live price fetch fails on read-only view
      }

      const entryPrice = Number(pos.entryPrice);
      const quantity = Number(pos.quantity);
      const isBuy = pos.direction === Direction.BULLISH;
      const charges = (pos.chargesJson as any) || { totalCharges: 0 };
      // Quote-currency conversion via point-in-time FX rate
      const targetSymbol = (pos.contractSymbol && pos.contractSymbol.trim().length > 0)
        ? pos.contractSymbol.trim().toUpperCase()
        : pos.symbol.trim().toUpperCase();
      const isOptionPos = targetSymbol.endsWith(' CE') || targetSymbol.endsWith(' PE') || pos.instrumentType === 'OPTION';
      let quoteCurrency = 'INR';
      try {
        const lookupSym = isOptionPos ? (targetSymbol.includes(' ') ? targetSymbol.split(' ')[0] : targetSymbol) : targetSymbol;
        const inst = getAuthoritativeInstrument(lookupSym);
        quoteCurrency = inst.currency;
      } catch {
        quoteCurrency = 'INR';
      }
      const openingSnapshot =
        (pos.executionEventsJson as any)?.accountingSnapshot ??
        (pos.featureSnapshotJson as any)?.accountingSnapshot;
      const fxRate =
        openingSnapshot?.fxRate ??
        PointInTimeCurrencyConverter.getInstance().getRate(quoteCurrency, 'INR', Date.now()).fxRate;

      const pnlCalc = TradeAccountingEngine.calculateTradePnl({
        entryPrice,
        exitPrice: livePrice,
        quantity,
        direction: isBuy ? Direction.BULLISH : Direction.BEARISH,
        fxRate,
        fees: charges.totalCharges,
        accountingSnapshot: openingSnapshot ?? undefined,
      });
      const unrealizedPnL = pnlCalc.netPnlAccount;
      const stopLoss = pos.stopLoss ? Number(pos.stopLoss) : undefined;
      const initialStopLoss = pos.initialStopLoss ? Number(pos.initialStopLoss) : stopLoss;
      const riskAnchor = initialStopLoss ?? stopLoss;
      const riskDistance = riskAnchor ? Math.abs(entryPrice - riskAnchor) : 0;
      const priceDiff = isBuy ? livePrice - entryPrice : entryPrice - livePrice;
      const unrealizedR =
        pnlCalc.realizedR !== undefined &&
        Number.isFinite(pnlCalc.realizedR) &&
        pnlCalc.realizedR !== 0
          ? pnlCalc.realizedR
          : riskDistance > 0
            ? Number((priceDiff / riskDistance).toFixed(2))
            : 0;
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

      const target1 = pos.target1 ? Number(pos.target1) : undefined;
      const target2 = pos.target2 ? Number(pos.target2) : undefined;
      const target3 = pos.target3 ? Number(pos.target3) : undefined;

      let tp1Hit = false;
      let tp2Hit = false;
      let tp3Hit = false;

      if (isBuy) {
        tp1Hit = target1 !== undefined && livePrice >= target1;
        tp2Hit = target2 !== undefined && livePrice >= target2;
        tp3Hit = target3 !== undefined && livePrice >= target3;
      } else {
        tp1Hit = target1 !== undefined && livePrice <= target1;
        tp2Hit = target2 !== undefined && livePrice <= target2;
        tp3Hit = target3 !== undefined && livePrice <= target3;
      }

      const highestTargetReached = tp3Hit
        ? 'TP3'
        : tp2Hit
          ? 'TP2'
          : tp1Hit
            ? 'TP1'
            : 'NONE';

      let targetProgressPercent = 0;
      const effectiveEntry = entryPrice;
      const anchorTarget = target2 ?? target1;
      if (anchorTarget && effectiveEntry) {
        const totalDist = Math.abs(anchorTarget - effectiveEntry);
        const currentDist = isBuy
          ? Math.max(0, livePrice - effectiveEntry)
          : Math.max(0, effectiveEntry - livePrice);
        targetProgressPercent =
          totalDist > 0
            ? Number(Math.min(100, Math.max(0, (currentDist / totalDist) * 100)).toFixed(1))
            : 0;
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
        target1,
        target2,
        target3,
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
        accountCurrency: openingSnapshot?.accountCurrency || 'INR',
        quoteCurrency,
        fxRateUsed: fxRate,
        fxRateTimestamp: openingSnapshot?.calculatedAt || Date.now(),
        accountingSnapshotHash: openingSnapshot?.snapshotHash,
        grossUnrealizedPnlQuote: pnlCalc.grossPnlQuote,
        grossUnrealizedPnlAccount: pnlCalc.grossPnlAccount,
        incurredFeesAccount: charges.totalCharges,
        unrealizedNetPnlAccount: pnlCalc.netPnlAccount,
        feeCurrency: charges.feeCurrency || (quoteCurrency === 'USDT' ? 'USDT' : 'INR'),
        pnlDirection: isBuy ? 'LONG' : 'SHORT',
        pnlFormula: isBuy
          ? '(exit - entry) * qty * contractSize * fxRate - fees'
          : '(entry - exit) * qty * contractSize * fxRate - fees',
        targetProgressPercent,
        highestTargetReached,
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
        entryPrice: t.entryPrice !== null ? Number(t.entryPrice) : null,
        exitPrice: Number(t.exitPrice),
        realizedPnL: t.realizedPnL !== null ? Number(t.realizedPnL) : null,
        realizedR: t.realizedR !== null ? Number(t.realizedR) : null,
        maxFavorableExcursion: Number(t.maxFavorableExcursion),
        maxAdverseExcursion: Number(t.maxAdverseExcursion),
        holdingDurationSeconds: t.holdingDurationSeconds !== null ? t.holdingDurationSeconds : null,
        exitReason: t.exitReason,
        openedAt: t.entryTime ? t.entryTime.toISOString() : null,
        closedAt: t.exitTime ? t.exitTime.toISOString() : new Date().toISOString(),
        totalCharges: charges.totalCharges || 0,
        featureSnapshotJson: (t.featureSnapshotJson as any) || undefined,
        outcomeSnapshotJson: (t.outcomeSnapshotJson as any) || undefined,
        correlationId: t.correlationId,
        accountCurrency: (t.outcomeSnapshotJson as any)?.accountCurrency || 'INR',
        quoteCurrency: (t.outcomeSnapshotJson as any)?.quoteCurrency || 'INR',
        fxRateUsed:
          (t.outcomeSnapshotJson as any)?.accountingSnapshot?.fxRate ??
          (t.outcomeSnapshotJson as any)?.fxRateUsed,
        fxRateTimestamp:
          (t.outcomeSnapshotJson as any)?.accountingSnapshot?.calculatedAt ??
          (t.outcomeSnapshotJson as any)?.fxRateTimestamp,
        accountingSnapshotHash:
          (t.outcomeSnapshotJson as any)?.accountingSnapshotHash ||
          (t.outcomeSnapshotJson as any)?.accountingSnapshot?.snapshotHash,
      };
    });

    const totalTrades = formattedHistory.length;
    const completedTrades = formattedHistory.filter(
      (t) => t.realizedPnL !== null && t.realizedPnL !== undefined,
    );
    const winningTrades = completedTrades.filter((t) => (t.realizedPnL || 0) > 0).length;
    const losingTrades = completedTrades.filter((t) => (t.realizedPnL || 0) <= 0).length;
    const winRate =
      completedTrades.length > 0
        ? Number(((winningTrades / completedTrades.length) * 100).toFixed(1))
        : 0.0;

    const grossWins = completedTrades
      .filter((t) => (t.realizedPnL || 0) > 0)
      .reduce((acc, t) => acc + (t.realizedPnL || 0), 0);
    const grossLosses = Math.abs(
      completedTrades
        .filter((t) => (t.realizedPnL || 0) < 0)
        .reduce((acc, t) => acc + (t.realizedPnL || 0), 0),
    );
    const profitFactor =
      grossLosses > 0 ? Number((grossWins / grossLosses).toFixed(2)) : grossWins > 0 ? 99.99 : 0.0;

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

    const rawSymbol = this.normalizeSymbol(req.symbol);
    const execSymbol = this.normalizeSymbol(req.executionInstrument || req.symbol);
    const isOptionsUnderlyingSymbol = isOptionsUnderlying(rawSymbol);

    // Section 10 Validation: Options-Only Execution for NIFTY / BANKNIFTY Algo Bots
    const isOptionsBotOrder =
      Boolean(req.sourceBotId) &&
      (req.executionInstrumentType === 'OPTION' ||
        Boolean(req.executionInstrument?.toUpperCase().includes('OPTION')) ||
        (isOptionsUnderlyingSymbol && (req.executionInstrument === rawSymbol || !req.executionInstrument)));
    const isExplicitOptionOrder =
      req.instrumentType === 'OPTION' ||
      req.executionInstrumentType === 'OPTION' ||
      Boolean(req.strike);

    if (isOptionsBotOrder && req.instrumentType !== 'OPTION') {
      throw new BadRequestException(
        `OPTION_EXECUTION_REQUIRED: NIFTY and BANKNIFTY Algo Bots must execute OPTIONS ONLY. Got instrumentType='${req.instrumentType || 'SPOT'}'.`,
      );
    }

    let strike = req.strike !== undefined && req.strike !== null ? Number(req.strike) : undefined;
    let optionType = req.optionType;
    let contractSymbol: string = req.contractSymbol || '';

    if (contractSymbol && typeof contractSymbol === 'string') {
      const match = contractSymbol.match(/(?:NIFTY|BANKNIFTY)\s+(\d+(?:\.\d+)?)\s+(CE|PE)/i);
      if (match) {
        if (strike === undefined || Number.isNaN(strike)) {
          strike = Number(match[1]);
        }
        if (!optionType) {
          optionType = match[2].toUpperCase() as any;
        }
      }
    }

    if (isOptionsBotOrder || isExplicitOptionOrder) {
      if (req.instrumentType !== 'OPTION') {
        throw new BadRequestException(
          `OPTION_EXECUTION_REQUIRED: Option orders must specify instrumentType='OPTION'.`,
        );
      }
      if (
        strike === undefined ||
        strike === null ||
        Number(strike) <= 0 ||
        !Number.isFinite(Number(strike))
      ) {
        throw new BadRequestException(
          `OPTION_STRIKE_REQUIRED: Option orders require a positive numeric strike price. Got '${req.strike}'.`,
        );
      }
      if (!optionType || !['CE', 'PE'].includes(String(optionType).toUpperCase())) {
        throw new BadRequestException(
          `OPTION_TYPE_REQUIRED: Option orders require an optionType of 'CE' or 'PE'. Got '${req.optionType}'.`,
        );
      }
      if (!contractSymbol || typeof contractSymbol !== 'string' || contractSymbol.trim() === '') {
        throw new BadRequestException(
          `OPTION_CONTRACT_REQUIRED: Option orders require a valid contractSymbol. Got '${req.contractSymbol}'.`,
        );
      }
    }

    const instrumentType = (isOptionsBotOrder || isExplicitOptionOrder) ? 'OPTION' : (req.instrumentType || 'SPOT');
    const isOption = instrumentType === 'OPTION';

    const isSpot = instrumentType === 'SPOT' && !isOption;
    const isSupportedSpot = isSupportedSpotSymbol(execSymbol);

    if (isSpot && isSupportedSpot && req.direction !== 'BUY') {
      throw new BadRequestException(
        `SPOT_SHORT_SELLING_FORBIDDEN: Cannot create a short/bearish position for spot instrument '${execSymbol}'. ` +
          `Spot instruments (NIFTY_SPOT, BANKNIFTY_SPOT, BTCUSDT_SPOT) are long-only. ` +
          `BUY entries open positions; SELL reduces/closes existing long holdings only.`,
      );
    }

    const symbol = rawSymbol;

    const isCrypto =
      symbol === 'BTCUSDT' ||
      symbol === 'BTCUSDT_SPOT' ||
      symbol === 'BTCUSD' ||
      symbol.toUpperCase().includes('BTC');
    const correlationId =
      req.correlationId || `corr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    contractSymbol =
      contractSymbol ||
      (strike && optionType ? `${symbol} ${strike} ${optionType}` : symbol);

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
    const isMarketOrder = !req.orderType || req.orderType === 'MARKET';
    let executionPrice: number | undefined;
    let sourceTimestamp = new Date();

    const isLiveMarket = req.executionMode === ExecutionMode.LIVE_MARKET;

    if (!isMarketOrder && req.price && req.price > 0) {
      executionPrice = req.price;
    } else if (!isLiveMarket && (req.allowPriceOverride || req.price) && req.price && req.price > 0) {
      executionPrice = req.price;
    }

    if (!executionPrice || executionPrice <= 0) {
      try {
        if (isOption) {
          const optionPriceData = await this.getValidatedOptionPrice(
            contractSymbol,
            config.maxMarketDataAgeSeconds || 5,
          );
          executionPrice = optionPriceData.price;
          sourceTimestamp = optionPriceData.timestamp;
        } else {
          const marketPriceData = await this.getValidatedMarketPrice(
            symbol,
            config.maxMarketDataAgeSeconds || 5,
          );
          executionPrice = marketPriceData.price;
          sourceTimestamp = marketPriceData.timestamp;
        }
      } catch (err: any) {
        const rejReason =
          err instanceof StaleMarketDataError
            ? RiskRejectionReason.STALE_MARKET_DATA
            : RiskRejectionReason.MARKET_DATA_UNAVAILABLE;
        await this.prisma.paperOrder.create({
          data: {
            accountId: account.id,
            symbol,
            contractSymbol,
            instrumentType,
            strike: req.strike ? new Decimal(req.strike) : null,
            optionType: req.optionType,
            expiry: req.expiry || null,
            direction: this.toSignalDirection(req.direction),
            orderType: req.orderType || 'MARKET',
            requestedQuantity: new Decimal(req.quantity),
            status: OrderState.REJECTED,
            rejectionReason: rejReason,
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
    const isBuy =
      (req.direction as any) === 'BUY' ||
      (req.direction as any) === 'BULLISH' ||
      (req.direction as any) === 'LONG';
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
    // Use beginning-of-day balance (current balance minus today's PnL swing) as the denominator
    // so the limit scales with the actual account size, not the fixed initial capital.
    const beginOfDayBalance = Math.max(
      initialCapital,
      Number(account.cashBalance) - todayRealizedPnL,
    );
    const maxDailyLossAllowed = beginOfDayBalance * (Number(config.maxDailyLossPercent) / 100);

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
      config.maxSlippageBps ?? 50,
    );
    const finalFillPrice = slippageResult.fillPrice;
    const slippageAmount = slippageResult.slippageAmount;

    const orderSubmittedAt = new Date();
    const fillExecutionTime = new Date();
    const baseLookupSymbol = symbol.includes(' ') ? symbol.split(' ')[0] : symbol;
    const openingInst = getAuthoritativeInstrument(baseLookupSymbol);
    const maxInstLeverage = openingInst.marginMode === 'SPOT' ? 1 : Number(config.maxLeverage || 5);
    const requestedLeverage = req.leverage ?? (openingInst.marginMode === 'SPOT' ? 1 : Math.min(5, maxInstLeverage));
    const effLeverage = Math.max(1, Math.min(requestedLeverage, maxInstLeverage));
    const openingQuoteCurrency = openingInst.currency;
    const openingConverter = PointInTimeCurrencyConverter.getInstance();
    const openingFxRes = openingConverter.getRate(
      openingQuoteCurrency,
      'INR',
      fillExecutionTime.getTime(),
    );
    const fxRate = openingFxRes.fxRate;
    const contractSize = openingInst.contractSize ?? 1;

    const turnoverQuote = finalFillPrice * req.quantity * contractSize;
    const turnoverAccount = Number((turnoverQuote * fxRate).toFixed(2));
    const charges = this.calculateCharges(
      turnoverQuote,
      isCrypto ? 'CRYPTO' : (baseLookupSymbol === 'XAUUSD' || baseLookupSymbol === 'GOLD') ? 'COMMODITY' : isOption ? 'OPTION' : 'EQUITY',
      fxRate,
      fillExecutionTime.getTime(),
      'ENTRY',
      contractSymbol || symbol,
    );
    const requiredMargin = Number((turnoverAccount / effLeverage).toFixed(2));
    const maxExposureAllowed = initialCapital * (Number(config.maxTotalExposurePercent) / 100);

    const openingMarginModel = resolveMarginModel(openingInst, { requestedLeverage: effLeverage });

    const openingAccountingSnapshot = buildAccountingSnapshot({
      accountCurrency: 'INR',
      quoteCurrency: openingQuoteCurrency,
      fxResult: openingFxRes,
      contractSize,
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

      if (this.accountingService) {
        try {
          this.accountingService.assertFinancialInvariants(txAccount);
        } catch (err: any) {
          this.logger.warn(`Pre-trade financial invariant check: ${err.message}`);
        }
      }

      const txCash = Number(txAccount.cashBalance);
      // Reconcile used margin directly from active open positions to prevent dirty/stale margin locks
      const activePositions = await tx.paperPosition.findMany({
        where: {
          accountId: account.id,
          status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED] },
        },
        select: { usedMargin: true },
      });
      const reconciledUsedMargin = activePositions.reduce(
        (sum, p) => sum + Number(p.usedMargin),
        0,
      );

      // Check available cash balance against required margin + entry charges
      const txAvailable = txCash - reconciledUsedMargin;
      const totalCashRequired = requiredMargin + charges.totalCharges;
      if (txAvailable < totalCashRequired) {
        await this.rejectOrder(
          account.id,
          symbol,
          contractSymbol,
          instrumentType,
          req.direction,
          req.orderType,
          req.quantity,
          RiskRejectionReason.INSUFFICIENT_MARGIN,
          `[INSUFFICIENT_MARGIN] Concurrency check failed. Required: ₹${totalCashRequired.toFixed(2)} (Margin: ₹${requiredMargin.toFixed(2)} + Fees: ₹${charges.totalCharges.toFixed(2)}), Available: ₹${txAvailable.toFixed(2)}`,
          idempotencyKey,
          correlationId,
        );
        throw new BadRequestException(
          `Order Rejected [INSUFFICIENT_MARGIN]: Available cash (₹${txAvailable.toFixed(2)}) is insufficient for required margin (₹${requiredMargin.toFixed(2)}) and fees (₹${charges.totalCharges.toFixed(2)}).`,
        );
      }

      // Check portfolio exposure limit
      const projectedTotalExposure = reconciledUsedMargin + requiredMargin;
      if (projectedTotalExposure > maxExposureAllowed) {
        await this.rejectOrder(
          account.id,
          symbol,
          contractSymbol,
          instrumentType,
          req.direction,
          req.orderType,
          req.quantity,
          RiskRejectionReason.TOTAL_EXPOSURE_LIMIT,
          `Projected portfolio exposure (₹${projectedTotalExposure.toFixed(2)}) exceeds maximum allowed (₹${maxExposureAllowed.toFixed(2)})`,
          idempotencyKey,
          correlationId,
        );
        throw new BadRequestException(
          `Order Rejected [MAX_PORTFOLIO_RISK_EXCEEDED]: Position requires ₹${requiredMargin.toFixed(2)} margin, which pushes portfolio exposure to ₹${projectedTotalExposure.toFixed(2)} (Limit: ₹${maxExposureAllowed.toFixed(2)}).`,
        );
      }

      // Create PaperOrder (FILLED)
      const order = await tx.paperOrder.create({
        data: {
          accountId: account.id,
          tradeDecisionId: req.tradeDecisionId || null,
          executionId: (req as any).executionId || null,
          symbol,
          contractSymbol,
          instrumentType,
          strike: req.strike ? new Decimal(req.strike) : null,
          optionType: req.optionType,
          expiry: req.expiry || null,
          direction: this.toSignalDirection(req.direction),
          strategyDirection: req.strategyDirection ? (req.strategyDirection.toUpperCase() as Direction) : null,
          sourceBotId: req.sourceBotId || null,
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
          orderSubmittedAt,
          firstFillAt: fillExecutionTime,
        },
      });

      // Create PaperFill with slippage & executionPriceSource
      const fill = await tx.paperFill.create({
        data: {
          orderId: order.id,
          executionRole: 'ENTRY',
          fillPrice: new Decimal(finalFillPrice),
          fillQuantity: new Decimal(req.quantity),
          fee: new Decimal(charges.totalCharges),
          feeBreakdownJson: charges as any,
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
          tradeDecisionId: req.tradeDecisionId || null,
          executionId: (req as any).executionId || null,
          symbol,
          contractSymbol,
          instrumentType,
          executionInstrument: req.executionInstrument || (isOption ? contractSymbol : rawSymbol),
          strike: req.strike ? new Decimal(req.strike) : null,
          optionType: req.optionType,
          expiry: req.expiry || null,
          direction: this.toSignalDirection(req.direction),
          strategyDirection: req.strategyDirection ? (req.strategyDirection.toUpperCase() as Direction) : null,
          sourceBotId: req.sourceBotId || null,
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
          chargesJson: charges as any,
          featureSnapshotJson: (req.featureSnapshotJson as any) || undefined,
          executionEventsJson: {
            accountingSnapshot: openingAccountingSnapshot as any,
            accountingSnapshotHash: openingAccountingSnapshot.snapshotHash,
            tradeDecisionId: req.tradeDecisionId,
            managedBy: 'API_MONITOR',
            currentLifecycleState: TradeLifecycleState.POSITION_OPENED,
            initialQuantity: Number(req.quantity),
            remainingQuantity: Number(req.quantity),
            currentStopLoss: Number(stopLoss),
            partialLegs: [],
          } as any,
          openedAt: fill.fillTimestamp,
          positionOpenedAt: fill.fillTimestamp,
          correlationId,
        },
      });

      // Link fill directly to position
      if (typeof (tx.paperFill as any)?.update === 'function') {
        await tx.paperFill.update({
          where: { id: fill.id },
          data: { positionId: position.id },
        });
      }

      // MODEL-A ACCOUNTING CONTRACT:
      // At ENTRY: cashBalance -= entryFees, realizedPnL -= entryFees, totalChargesPaid += entryFees, usedMargin += requiredMargin.
      await tx.paperAccount.update({
        where: { id: account.id },
        data: {
          cashBalance: { decrement: charges.totalCharges },
          realizedPnL: { decrement: charges.totalCharges },
          usedMargin: { increment: requiredMargin },
          totalChargesPaid: { increment: charges.totalCharges },
        },
      });

      if (this.accountingService) {
        try {
          const postEntryAccount = await tx.paperAccount.findUnique({ where: { id: account.id } });
          if (postEntryAccount) {
            this.accountingService.assertFinancialInvariants(postEntryAccount);
          }
        } catch (err: any) {
          this.logger.warn(`Post-entry financial invariant check: ${err.message}`);
        }
      }

      // Synchronize TradeDecision if tradeDecisionId provided (fail-closed inside tx)
      if (req.tradeDecisionId) {
        const currentDecision = await tx.tradeDecision.findUnique({
          where: { id: req.tradeDecisionId },
          select: { lifecycleState: true },
        });
        const isBotManaged =
          currentDecision?.lifecycleState === TradeLifecycleState.ORDER_SUBMITTED ||
          currentDecision?.lifecycleState === TradeLifecycleState.RESERVATION_CREATED;

        if (!isBotManaged && this.tradeLifecycleService && currentDecision) {
          try {
            const curState = currentDecision.lifecycleState;
            if (curState === TradeLifecycleState.PRE_TRADE_APPROVED) {
              await this.tradeLifecycleService.transition(
                {
                  tradeDecisionId: req.tradeDecisionId,
                  newState: TradeLifecycleState.TRADE_TAKEN,
                  event: 'TRADE_TAKEN',
                  correlationId,
                },
                tx,
              );
            }
            const midState = (await tx.tradeDecision.findUnique({
              where: { id: req.tradeDecisionId },
              select: { lifecycleState: true },
            }))?.lifecycleState;
            if (midState === TradeLifecycleState.TRADE_TAKEN) {
              await this.tradeLifecycleService.transition(
                {
                  tradeDecisionId: req.tradeDecisionId,
                  newState: TradeLifecycleState.RESERVATION_CREATED,
                  event: 'RESERVATION_CREATED',
                  correlationId,
                },
                tx,
              );
            }
            const resState = (await tx.tradeDecision.findUnique({
              where: { id: req.tradeDecisionId },
              select: { lifecycleState: true },
            }))?.lifecycleState;
            if (resState === TradeLifecycleState.RESERVATION_CREATED || resState === TradeLifecycleState.RESERVED) {
              await this.tradeLifecycleService.transition(
                {
                  tradeDecisionId: req.tradeDecisionId,
                  newState: TradeLifecycleState.ORDER_SUBMITTED,
                  event: 'ORDER_SUBMITTED',
                  correlationId,
                },
                tx,
              );
            }
            const subState = (await tx.tradeDecision.findUnique({
              where: { id: req.tradeDecisionId },
              select: { lifecycleState: true },
            }))?.lifecycleState;
            if (subState === TradeLifecycleState.ORDER_SUBMITTED) {
              await this.tradeLifecycleService.transition(
                {
                  tradeDecisionId: req.tradeDecisionId,
                  newState: TradeLifecycleState.ORDER_FILLED,
                  event: 'ORDER_FILLED',
                  correlationId,
                },
                tx,
              );
            }
            await this.tradeLifecycleService.transition(
              {
                tradeDecisionId: req.tradeDecisionId,
                newState: TradeLifecycleState.POSITION_OPENED,
                event: 'ORDER_FILLED',
                correlationId,
                metadata: {
                  positionId: position.id,
                  orderPositionId: position.id,
                  orderSubmittedTime: orderSubmittedAt,
                  fillTime: fillExecutionTime,
                  marketEventTime: sourceTimestamp,
                  observedAt: orderSubmittedAt,
                  receivedAt: fillExecutionTime,
                },
              },
              tx,
            );
          } catch (lifecycleErr: any) {
            this.logger.debug(`Lifecycle transition note: ${lifecycleErr.message}`);
          }
        }

        await tx.tradeDecision.updateMany({
          where: { id: req.tradeDecisionId },
          data: {
            orderPositionId: position.id,
            orderSubmittedTime: orderSubmittedAt,
            fillTime: fillExecutionTime,
            marketEventTime: sourceTimestamp,
            observedAt: orderSubmittedAt,
            receivedAt: fillExecutionTime,
            updatedAt: new Date(),
          },
        });
      }

      // Create Audit Events with full metadata
      const auditPayload = {
        positionId: position.id,
        orderId: order.id,
        executionId: order.id,
        tradeDecisionId: req.tradeDecisionId,
        symbol,
        direction: req.direction,
        triggerPrice: finalFillPrice,
        fillPrice: finalFillPrice,
        quantity: req.quantity,
        marketEventTime: sourceTimestamp.toISOString(),
        observedAt: orderSubmittedAt.toISOString(),
        receivedAt: fillExecutionTime.toISOString(),
        correlationId,
      };

      await tx.auditEvent.createMany({
        data: [
          {
            actor: 'SYSTEM',
            service: 'PAPER_TRADING',
            eventType: 'ORDER_SUBMITTED',
            entityType: 'ORDER',
            entityId: order.id,
            payloadJson: auditPayload,
            correlationId,
          },
          {
            actor: 'SYSTEM',
            service: 'PAPER_TRADING',
            eventType: 'ORDER_FILLED',
            entityType: 'ORDER',
            entityId: order.id,
            payloadJson: auditPayload,
            correlationId,
          },
          {
            actor: 'SYSTEM',
            service: 'PAPER_TRADING',
            eventType: 'POSITION_OPENED',
            entityType: 'POSITION',
            entityId: position.id,
            payloadJson: auditPayload,
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
      maxFavorableExcursion: trade.maxFavorableExcursion
        ? Number(trade.maxFavorableExcursion)
        : undefined,
      maxAdverseExcursion: trade.maxAdverseExcursion
        ? Number(trade.maxAdverseExcursion)
        : undefined,
      holdingDurationSeconds: trade.holdingDurationSeconds || 0,
      exitReason: trade.exitReason,
      openedAt: new Date(trade.entryTime).toISOString(),
      closedAt: new Date(trade.exitTime).toISOString(),
      totalCharges: Number(charges.totalCharges || 0),
      featureSnapshotJson: (trade.featureSnapshotJson as any) || undefined,
      outcomeSnapshotJson: (trade.outcomeSnapshotJson as any) || undefined,
      correlationId: trade.correlationId,
      accountCurrency: (trade.outcomeSnapshotJson as any)?.accountCurrency || 'INR',
      quoteCurrency: (trade.outcomeSnapshotJson as any)?.quoteCurrency || 'INR',
      fxRateUsed:
        (trade.outcomeSnapshotJson as any)?.accountingSnapshot?.fxRate ??
        (trade.outcomeSnapshotJson as any)?.fxRateUsed,
      fxRateTimestamp:
        (trade.outcomeSnapshotJson as any)?.accountingSnapshot?.calculatedAt ??
        (trade.outcomeSnapshotJson as any)?.fxRateTimestamp,
      accountingSnapshotHash:
        (trade.outcomeSnapshotJson as any)?.accountingSnapshotHash ||
        (trade.outcomeSnapshotJson as any)?.accountingSnapshot?.snapshotHash,
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
    let triggerPriceOpt: number | undefined;
    let triggerMarketEventTimeOpt: Date | string | undefined;

    let isInternalCall = false;
    let executionModeOpt: ExecutionMode | undefined;

    if (typeof options === 'number') {
      exitPriceOverride = options;
    } else if (options && typeof options === 'object') {
      exitPriceOverride = options.exitPriceOverride;
      allowPriceOverride = options.allowPriceOverride === true;
      isInternalCall = options.isInternalCall === true;
      executionModeOpt = options.executionMode;
      correlationIdOpt = options.correlationId;
      triggerPriceOpt = options.triggerPrice;
      triggerMarketEventTimeOpt = options.triggerMarketEventTime;
    }

    const pos = await this.prisma.paperPosition.findUnique({
      where: { id: positionId },
      include: { account: true },
    });

    if (!pos) {
      throw new NotFoundException(`Active position with ID '${positionId}' not found`);
    }

    if (pos.status === PositionState.CLOSED || pos.status === PositionState.CLOSING) {
      // Idempotent retry / concurrency handling: wait for and return existing completed PaperTrade
      for (let i = 0; i < 10; i++) {
        const existingTrade = await this.prisma.paperTrade.findFirst({
          where: { positionId: pos.id },
          orderBy: { exitTime: 'desc' },
        });
        if (existingTrade) {
          return this.mapDbTradeToInterface(existingTrade);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const existingTrade = await this.prisma.paperTrade.findFirst({
        where: { positionId: pos.id },
        orderBy: { exitTime: 'desc' },
      });
      if (existingTrade) {
        return this.mapDbTradeToInterface(existingTrade);
      }
      throw new BadRequestException(
        `Position '${positionId}' is currently being closed by another request.`,
      );
    }

    const correlationId =
      correlationIdOverride || correlationIdOpt || pos.correlationId || `corr_${Date.now()}`;
    const symbol = pos.symbol;
    const isCrypto = symbol === 'BTCUSDT' || symbol === 'BTCUSD';
    const isGold = symbol === 'XAUUSD' || symbol === 'GOLD';
    const config = await this.getSystemConfig();

    // Authoritative Lifecycle Invariant: A position lacking an immutable opening snapshot cannot be closed
    const openingSnapshot =
      (pos.executionEventsJson as any)?.accountingSnapshot ??
      ((pos.featureSnapshotJson as any)?.accountingSnapshot as any);

    if (!openingSnapshot) {
      throw new BadRequestException(
        `[MALFORMED_LIFECYCLE] Cannot close position '${pos.id}': Missing authoritative immutable opening accounting snapshot. Silently constructing an ad-hoc snapshot during close execution is strictly prohibited.`,
      );
    }

    // Resolve live exit price with strict fail-closed validation & LIVE_TICK provenance
    let exitPrice: number;
    let sourceTimestamp = new Date();
    let priceSource = ExecutionPriceSource.LIVE_TICK;

    const effectiveExecutionMode = executionModeOpt || (pos as any).executionMode;
    const isLiveMode =
      effectiveExecutionMode === ExecutionMode.LIVE_MARKET ||
      effectiveExecutionMode === ExecutionMode.LIVE ||
      effectiveExecutionMode === 'LIVE' ||
      effectiveExecutionMode === 'LIVE_MARKET';
    const isTestOrSimulated =
      effectiveExecutionMode === ExecutionMode.TEST ||
      effectiveExecutionMode === ExecutionMode.SIMULATED ||
      effectiveExecutionMode === 'TEST' ||
      effectiveExecutionMode === 'SIMULATED';

    // LIVE mode MUST reject any price override — only validated market quote is authoritative
    if (isLiveMode && exitPriceOverride !== undefined && exitPriceOverride > 0) {
      throw new BadRequestException(
        `[LIVE_OVERRIDE_REJECTED] ExecutionMode.LIVE does not permit exitPriceOverride. Only validated live market quotes are authoritative for LIVE execution.`,
      );
    }

    if (
      allowPriceOverride &&
      exitPriceOverride &&
      exitPriceOverride > 0 &&
      !isLiveMode
    ) {
      exitPrice = exitPriceOverride;
      priceSource = ExecutionPriceSource.SIMULATED_FILL;
    } else {
      try {
        const liveQuote = await this.resolveLivePositionQuote(
          pos,
          config.maxMarketDataAgeSeconds || 5,
        );
        exitPrice = liveQuote.price;
        sourceTimestamp = liveQuote.timestamp;
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
      config.maxSlippageBps ?? 50,
    );
    const finalExitPrice = Number(exitSlippage.fillPrice.toFixed(2));

    const exitTime = new Date();
    const quantity = Number(pos.quantity);
    const exitTurnover = finalExitPrice * quantity;
    const isOptionPos = pos.instrumentType === 'OPTION' || Boolean(pos.strike);
    const fxRate = openingSnapshot?.fxRate ?? 1.0;
    const exitCharges = this.calculateCharges(
      exitTurnover,
      isCrypto ? 'CRYPTO' : isGold ? 'COMMODITY' : isOptionPos ? 'OPTION' : 'EQUITY',
      fxRate,
      exitTime.getTime(),
      'EXIT',
      pos.contractSymbol || pos.symbol,
    );
    const entryCharges = (pos.chargesJson as any) || { totalCharges: 0 };
    const totalCharges = Number((entryCharges.totalCharges + exitCharges.totalCharges).toFixed(2));
    const isBuy = pos.direction === Direction.BULLISH;

    // Determine outcome classification directly without string heuristics
    const validOutcomes = new Set([
      'WIN_TP1',
      'WIN_TP2',
      'WIN_TP3_RUNNER',
      'LOSS_SL',
      'BREAKEVEN',
      'MANUAL_EXIT',
      'CANCELLED',
      'FAILED',
    ]);

    let outcomeClassification = 'MANUAL_EXIT';
    if (
      options &&
      typeof options === 'object' &&
      options.outcomeClassification &&
      validOutcomes.has(options.outcomeClassification)
    ) {
      outcomeClassification = options.outcomeClassification;
    } else {
      const existingEvents = (pos.executionEventsJson as any) || {};
      const hasTP2 = Boolean(existingEvents.tp2FillTime);
      const hasTP1 = Boolean(existingEvents.tp1FillTime);

      if (hasTP2) {
        outcomeClassification = 'WIN_TP3_RUNNER';
      } else if (hasTP1) {
        outcomeClassification = 'WIN_TP2';
      } else if (pos.status === PositionState.PARTIALLY_CLOSED) {
        outcomeClassification = 'WIN_TP1';
      } else if (
        exitReason.toLowerCase().includes('stop loss') ||
        exitReason.toLowerCase().includes('sl')
      ) {
        outcomeClassification = 'LOSS_SL';
      } else if (exitReason.toLowerCase().includes('breakeven')) {
        outcomeClassification = 'BREAKEVEN';
      } else {
        outcomeClassification = 'MANUAL_EXIT';
      }
    }

    let canonicalRealizedPnLLog = 0;
    let canonicalRealizedRLog = 0;
    let hasAuthoritativeFillsLog = false;

    // Atomic Database Transaction for Position Closure (with Concurrency / Double-Close Guard)
    const trade = await this.prisma.$transaction(async (tx) => {
      // 1. Atomic state transition: OPEN/EXIT_PENDING/PARTIALLY_CLOSED -> CLOSING
      const updated = await tx.paperPosition.updateMany({
        where: {
          id: pos.id,
          status: {
            in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED, PositionState.EXIT_PENDING],
          },
        },
        data: {
          status: PositionState.CLOSING,
        },
      });

      if (updated.count === 0) {
        // Concurrency check: another worker/thread already closed this position!
        for (let i = 0; i < 10; i++) {
          const existingTrade = await tx.paperTrade.findFirst({
            where: { positionId: pos.id },
            orderBy: { exitTime: 'desc' },
          });
          if (existingTrade) {
            return existingTrade;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
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
          tradeDecisionId: pos.tradeDecisionId || null,
          executionId: pos.executionId || null,
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
          orderSubmittedAt: exitTime,
          firstFillAt: exitTime,
        },
      });

      // 3. Create Exit PaperFill
      const exitFill = await tx.paperFill.create({
        data: {
          orderId: exitOrder.id,
          positionId: pos.id,
          executionRole: 'FINAL_EXIT',
          fillPrice: new Decimal(finalExitPrice),
          fillQuantity: pos.quantity,
          fee: new Decimal(exitCharges.totalCharges),
          feeBreakdownJson: exitCharges as any,
          slippage: new Decimal(exitSlippage.slippageAmount),
          executionPriceSource: priceSource,
          liquidityType: 'TAKER',
          sourceTimestamp,
          fillTimestamp: exitTime,
          correlationId,
        },
      });

      // 4. Retrieve Fills & Multi-Leg Execution Details
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

      // 5. Multi-Leg Accounting & Lifecycle Realized P&L / Weighted R Aggregation
      const inst = getAuthoritativeInstrument(symbol);
      const quoteCurrency = inst.currency;
      const openingSnapshot =
        (pos.executionEventsJson as any)?.accountingSnapshot ??
        ((pos.featureSnapshotJson as any)?.accountingSnapshot as any);

      if (!openingSnapshot) {
        throw new BadRequestException(
          `[MALFORMED_LIFECYCLE] Cannot close position '${pos.id}': Missing authoritative immutable opening accounting snapshot. Silently constructing an ad-hoc snapshot during close execution is strictly prohibited.`,
        );
      }
      const snapshot = openingSnapshot;

      const partialLegs: any[] = (pos.executionEventsJson as any)?.partialLegs || [];
      let partialNetPnLTotal = 0;
      let partialWeightedRSum = 0;
      let partialQtyTotal = 0;
      let partialFeesTotal = 0;

      for (const leg of partialLegs) {
        partialNetPnLTotal += Number(leg.netPnL || 0);
        partialWeightedRSum += Number(leg.realizedR || 0) * Number(leg.quantity || 0);
        partialQtyTotal += Number(leg.quantity || 0);
        partialFeesTotal += Number(leg.fee || 0);
      }

      const finalQty = Number(pos.quantity);
      const finalTurnover = finalExitPrice * finalQty;
      const finalExitCharges = exitCharges.totalCharges;
      const entryPrice = Number(pos.entryPrice);

      const totalPositionQuantity = partialQtyTotal + finalQty;
      const totalLifecycleCharges = Number(
        (entryCharges.totalCharges + partialFeesTotal + finalExitCharges).toFixed(2),
      );
      const effectiveExitPrice =
        totalPositionQuantity > 0
          ? Number(
              (
                (partialLegs.reduce(
                  (acc: number, l: any) =>
                    acc + Number(l.price ?? l.fillPrice) * Number(l.quantity),
                  0,
                ) +
                  finalExitPrice * finalQty) /
                totalPositionQuantity
              ).toFixed(2),
            )
          : finalExitPrice;
      const effectiveEntryPrice =
        hasAuthoritativeEntryFills && aggregated.entry
          ? aggregated.entry.weightedPrice
          : Number(pos.entryPrice);
      const initialSL = pos.initialStopLoss
        ? Number(pos.initialStopLoss)
        : pos.stopLoss
          ? Number(pos.stopLoss)
          : undefined;

      const finalLegSettlement = TradeAccountingEngine.settleExecutionLeg({
        role: 'FINAL_EXIT',
        entryPrice: effectiveEntryPrice,
        fillPrice: finalExitPrice,
        quantity: finalQty,
        direction: isBuy ? Direction.BULLISH : Direction.BEARISH,
        accountingSnapshot: snapshot,
        fees: finalExitCharges,
        initialStopLoss: initialSL,
      });
      const finalGrossPnL = finalLegSettlement.grossPnL;
      const finalNetPnL = finalLegSettlement.netPnL;
      const finalRealizedR = finalLegSettlement.realizedR;

      const totalWeightedRSum = partialWeightedRSum + finalRealizedR * finalQty;
      const weightedLifecycleR =
        totalPositionQuantity > 0
          ? Number((totalWeightedRSum / totalPositionQuantity).toFixed(2))
          : 0;

      const entryLegSettlement = TradeAccountingEngine.settleExecutionLeg({
        role: 'ENTRY',
        entryPrice: effectiveEntryPrice,
        fillPrice: effectiveEntryPrice,
        quantity: totalPositionQuantity,
        direction: isBuy ? Direction.BULLISH : Direction.BEARISH,
        accountingSnapshot: snapshot,
        fees: entryCharges.totalCharges,
        initialStopLoss: initialSL,
      });

      const allLegsBreakdown = [
        ...(hasAuthoritativeEntryFills && aggregated.entry
          ? [
              {
                role: 'ENTRY',
                quantity: totalPositionQuantity,
                fillPrice: effectiveEntryPrice,
                fillTimestamp: new Date(aggregated.entry.earliestFillTimestamp).toISOString(),
                marketEventTime: sourceTimestamp.toISOString(),
                observedAt: new Date(aggregated.entry.earliestFillTimestamp).toISOString(),
                receivedAt: new Date(aggregated.entry.earliestFillTimestamp).toISOString(),
                fee: entryCharges.totalCharges,
                feeBreakdown: entryCharges,
                grossPnL: entryLegSettlement.grossPnL,
                netPnL: entryLegSettlement.netPnL,
                realizedR: entryLegSettlement.realizedR,
                executionPriceSource: priceSource,
                slippage: 0,
                correlationId: pos.correlationId,
                price: effectiveEntryPrice,
                timestamp: pos.entryTime,
                fxRate: snapshot.fxRate,
                accountingSnapshotHash:
                  entryLegSettlement.accountingSnapshotHash ?? snapshot.snapshotHash,
              },
            ]
          : []),
        ...partialLegs,
        {
          role: 'FINAL_EXIT',
          quantity: finalQty,
          triggerPrice: triggerPriceOpt ?? null,
          triggerMarketEventTime: triggerMarketEventTimeOpt
            ? new Date(triggerMarketEventTimeOpt).toISOString()
            : null,
          fillPrice: finalExitPrice,
          fillTimestamp: exitTime.toISOString(),
          marketEventTime: sourceTimestamp.toISOString(),
          observedAt: exitTime.toISOString(),
          receivedAt: exitTime.toISOString(),
          quotePrice: exitPrice,
          quoteMarketEventTime: sourceTimestamp.toISOString(),
          fee: finalExitCharges,
          feeBreakdown: exitCharges,
          grossPnL: finalGrossPnL,
          netPnL: finalNetPnL,
          realizedR: finalRealizedR,
          executionPriceSource: priceSource,
          slippage: 0,
          correlationId: pos.correlationId,
          price: finalExitPrice,
          timestamp: exitTime.toISOString(),
          fxRate: snapshot.fxRate,
          accountingSnapshotHash:
            finalLegSettlement.accountingSnapshotHash ?? snapshot.snapshotHash,
        },
      ];

      // Canonical lifecycle P&L derived from sum of canonical leg settlements:
      const canonicalRealizedPnL = Number(
        allLegsBreakdown.reduce((sum, leg) => sum + Number(leg.netPnL || 0), 0).toFixed(2),
      );

      const canonicalRealizedR = weightedLifecycleR;
      const pnlCalc: any = finalLegSettlement;

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
          executionEventsJson: {
            ...((pos.executionEventsJson as any) || {}),
            currentLifecycleState: TradeLifecycleState.TRADE_CLOSED,
            closedAt: new Date(aggregated.exit.latestFillTimestamp).toISOString(),
            exitReason,
          },
        },
      });

      // 7. Create EXACTLY ONE Canonical PaperTrade Record for the entire position lifecycle
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
          outcomeClassification,
          quantity: new Decimal(totalPositionQuantity),
          entryPrice:
            hasAuthoritativeEntryFills && aggregated.entry
              ? new Decimal(effectiveEntryPrice)
              : new Decimal(entryPrice),
          exitPrice: new Decimal(effectiveExitPrice),
          realizedPnL: new Decimal(canonicalRealizedPnL),
          realizedR: new Decimal(canonicalRealizedR),
          maxFavorableExcursion: pos.maxFavorableExcursion,
          maxAdverseExcursion: pos.maxAdverseExcursion,
          holdingDurationSeconds:
            aggregated.durationMs !== null
              ? Math.max(0, Math.floor(aggregated.durationMs / 1000))
              : null,
          entryTime:
            hasAuthoritativeEntryFills && aggregated.entry
              ? new Date(aggregated.entry.earliestFillTimestamp)
              : pos.entryTime,
          exitTime: new Date(aggregated.exit.latestFillTimestamp),
          exitReason,
          chargesJson: {
            entryCharges,
            partialExitCharges: partialFeesTotal,
            finalExitCharges,
            totalCharges: totalLifecycleCharges,
          },
          featureSnapshotJson: (pos.featureSnapshotJson as any) || undefined,
          outcomeSnapshotJson: {
            legs: allLegsBreakdown,
            totalPositionQuantity,
            weightedExitPrice: effectiveExitPrice,
            weightedEntryPrice: effectiveEntryPrice,
            totalLifecyclePnL: canonicalRealizedPnL,
            weightedLifecycleR: canonicalRealizedR,
            executionPriceSource: priceSource,
            sourceTimestamp: sourceTimestamp.toISOString(),
            triggerPrice: triggerPriceOpt ?? null,
            triggerMarketEventTime: triggerMarketEventTimeOpt
              ? new Date(triggerMarketEventTimeOpt).toISOString()
              : null,
            exitQuotePrice: exitPrice,
            exitExecutionTime: exitTime.toISOString(),
            exitFillPrice: finalExitPrice,
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
            realizedPnL: canonicalRealizedPnL,
            quotePnl: pnlCalc ? pnlCalc.quotePnl : null,
            quoteCurrency: snapshot.quoteCurrency,
            netPnlAccount: pnlCalc ? pnlCalc.netPnlAccount : canonicalRealizedPnL,
            accountCurrency: snapshot.accountCurrency,
            accountingSnapshot: snapshot as any,
            accountingSnapshotHash: snapshot.snapshotHash,
            realizedR: canonicalRealizedR,
            holdingDurationSeconds:
              aggregated.durationMs !== null
                ? Math.max(0, Math.floor(aggregated.durationMs / 1000))
                : null,
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
          correlationId,
        },
      });

      // MODEL-A ACCOUNTING CONTRACT:
      // At FINAL exit: cashBalance += final grossPnL - final exitFees, realizedPnL += final grossPnL - final exitFees, totalChargesPaid += final exitFees, usedMargin -= remainingMargin.
      // Over complete lifecycle: PaperAccount.realizedPnL === PaperTrade.realizedPnL === (cashBalanceFinal - cashBalanceInitial).
      await tx.paperAccount.update({
        where: { id: pos.accountId },
        data: {
          cashBalance: { increment: new Decimal(finalLegSettlement.cashDelta) },
          usedMargin: { decrement: Number(pos.usedMargin) },
          realizedPnL: { increment: new Decimal(finalLegSettlement.realizedPnLDelta) },
          totalChargesPaid: { increment: new Decimal(finalExitCharges) },
        },
      });

      if (this.accountingService) {
        try {
          const postCloseAccount = await tx.paperAccount.findUnique({ where: { id: pos.accountId } });
          if (postCloseAccount) {
            this.accountingService.assertFinancialInvariants(postCloseAccount);
          }
        } catch (err: any) {
          this.logger.warn(`Post-close financial invariant check: ${err.message}`);
        }
      }

      // Synchronize TradeDecision lifecycle state if tradeDecisionId exists
      const tradeDecisionId = (pos.executionEventsJson as any)?.tradeDecisionId;
      if (tradeDecisionId) {
        if (this.tradeLifecycleService) {
          try {
            await this.tradeLifecycleService.transition(
              {
                tradeDecisionId,
                newState: TradeLifecycleState.TRADE_CLOSED,
                event: 'POSITION_CLOSED',
                correlationId,
                metadata: {
                  tradeId: tradeRecord.id,
                  positionId: pos.id,
                  orderPositionId: pos.id,
                  fillTime: exitTime,
                  marketEventTime: sourceTimestamp,
                  exitReason,
                },
              },
              tx,
            );
          } catch (lifecycleErr: any) {
            this.logger.debug(`Lifecycle close transition note: ${lifecycleErr.message}`);
          }
        }

        await tx.tradeDecision.updateMany({
          where: { id: tradeDecisionId },
          data: {
            orderPositionId: pos.id,
            fillTime: exitTime,
            marketEventTime: sourceTimestamp,
            updatedAt: new Date(),
          },
        });
      }

      if (this.journalService) {
        try {
          await this.journalService.createJournalEntry({
            accountId: pos.accountId,
            positionId: pos.id,
            symbol: pos.symbol,
            contractSymbol: pos.contractSymbol,
            instrumentType: pos.instrumentType,
            direction: pos.direction as any,
            quantity: totalPositionQuantity,
            entryPrice: effectiveEntryPrice,
            exitPrice: effectiveExitPrice,
            realizedPnL: canonicalRealizedPnL,
            realizedR: canonicalRealizedR,
            fees: totalLifecycleCharges,
            maxFavorableExcursion: pos.maxFavorableExcursion ? Number(pos.maxFavorableExcursion) : undefined,
            maxAdverseExcursion: pos.maxAdverseExcursion ? Number(pos.maxAdverseExcursion) : undefined,
            holdingDurationSeconds:
              aggregated.durationMs !== null
                ? Math.max(0, Math.floor(aggregated.durationMs / 1000))
                : undefined,
            entryTime:
              hasAuthoritativeEntryFills && aggregated.entry
                ? new Date(aggregated.entry.earliestFillTimestamp)
                : pos.entryTime,
            exitTime: new Date(aggregated.exit.latestFillTimestamp),
            exitReason,
            chargesJson: tradeRecord.chargesJson,
            featureSnapshotJson: (pos.featureSnapshotJson as any) || undefined,
            outcomeSnapshotJson: tradeRecord.outcomeSnapshotJson,
            outcomeClassification,
            correlationId,
          });
        } catch (jErr: any) {
          this.logger.debug(`Journal entry note: ${jErr.message}`);
        }
      }

      // 9. Audit Logs
      await tx.auditEvent.create({
        data: {
          actor: 'SYSTEM',
          service: 'PAPER_TRADING',
          eventType: 'EXIT_FILLED',
          entityType: 'ORDER',
          entityId: exitOrder.id,
          payloadJson: {
            positionId: pos.id,
            tradeId: tradeRecord.id,
            symbol,
            exitPrice: finalExitPrice,
            fillQuantity: pos.quantity,
          },
          correlationId,
        },
      });

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

      await tx.auditEvent.create({
        data: {
          actor: 'SYSTEM',
          service: 'PAPER_TRADING',
          eventType: 'TRADE_CLOSED',
          entityType: 'TRADE',
          entityId: tradeRecord.id,
          payloadJson: {
            tradeId: tradeRecord.id,
            positionId: pos.id,
            tradeDecisionId,
            realizedPnL: canonicalRealizedPnL,
            realizedR: canonicalRealizedR,
            exitReason,
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
      // Invalidate all open/partially closed positions on account reset without creating fake CLOSED journal entries
      await tx.paperPosition.updateMany({
        where: {
          accountId: account.id,
          status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED] },
        },
        data: {
          status: PositionState.INVALIDATED,
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
      executionEventsJson: pos.executionEventsJson || undefined,
      executionInstrument: pos.executionInstrument || undefined,
      executionInstrumentType: (pos as any).executionInstrumentType || undefined,
      expiry: pos.expiry || undefined,
      strategyDirection: pos.strategyDirection || undefined,
      sourceBotId: pos.sourceBotId || undefined,
      charges,
      accountCurrency:
        (pos.executionEventsJson as any)?.accountingSnapshot?.accountCurrency || 'INR',
      quoteCurrency:
        (pos.executionEventsJson as any)?.accountingSnapshot?.quoteCurrency ||
        (pos.symbol === 'BTCUSDT'
          ? 'USDT'
          : pos.symbol === 'XAUUSD' || pos.symbol === 'GOLD'
            ? 'USD'
            : 'INR'),
      fxRateUsed: (pos.executionEventsJson as any)?.accountingSnapshot?.fxRate ?? 1.0,
      fxRateTimestamp: (pos.executionEventsJson as any)?.accountingSnapshot?.calculatedAt,
      accountingSnapshotHash:
        (pos.executionEventsJson as any)?.accountingSnapshot?.snapshotHash ??
        (pos.executionEventsJson as any)?.accountingSnapshotHash,
    };
  }

  /**
   * Retrieves authoritative active positions enriched with live quote, real P&L, and relational links.
   */
  async getActivePositions(accountId?: string): Promise<any[]> {
    let targetAccountId = accountId;
    if (!targetAccountId) {
      const account = await this.getOrCreateAccount();
      targetAccountId = account.id;
    }

    const positions = await this.prisma.paperPosition.findMany({
      where: {
        accountId: targetAccountId,
        status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED] },
      },
      orderBy: { openedAt: 'desc' },
      include: {
        tradeDecision: {
          select: { id: true, botId: true, fingerprint: true, lifecycleState: true },
        },
        execution: {
          select: { id: true, state: true, fingerprint: true },
        },
        fills: {
          select: { id: true, executionRole: true, fillPrice: true, fillQuantity: true, fillTimestamp: true },
        },
      },
    });

    const enriched = await Promise.all(
      positions.map(async (pos: any) => {
        let livePrice = Number(pos.currentPrice);
        try {
          const liveQuote = await this.resolveLivePositionQuote(pos, 5);
          livePrice = liveQuote.price;
        } catch {}

        const entryPrice = Number(pos.entryPrice);
        const quantity = Number(pos.quantity);
        const isBuy = pos.direction === Direction.BULLISH;
        const charges = (pos.chargesJson as any) || { totalCharges: 0 };
        const snapshot =
          (pos.executionEventsJson as any)?.accountingSnapshot ??
          (pos.featureSnapshotJson as any)?.accountingSnapshot;

        const pnlCalc = TradeAccountingEngine.calculateTradePnl({
          entryPrice,
          exitPrice: livePrice,
          quantity,
          direction: isBuy ? Direction.BULLISH : Direction.BEARISH,
          fxRate: snapshot?.fxRate ?? 1.0,
          fees: charges.totalCharges,
          accountingSnapshot: snapshot,
        });

        return {
          id: pos.id,
          positionId: pos.id,
          accountId: pos.accountId,
          orderId: pos.orderId,
          tradeDecisionId: pos.tradeDecisionId,
          executionId: pos.executionId,
          symbol: pos.symbol,
          contractSymbol: pos.contractSymbol,
          instrumentType: pos.instrumentType,
          strike: pos.strike ? Number(pos.strike) : null,
          optionType: pos.optionType,
          expiry: pos.expiry,
          direction: pos.direction,
          quantity,
          entryPrice,
          currentPrice: livePrice,
          livePrice,
          unrealizedPnL: pnlCalc.netPnlAccount,
          unrealizedR: pnlCalc.realizedR,
          stopLoss: pos.stopLoss ? Number(pos.stopLoss) : null,
          initialStopLoss: pos.initialStopLoss ? Number(pos.initialStopLoss) : null,
          target1: pos.target1 ? Number(pos.target1) : null,
          target2: pos.target2 ? Number(pos.target2) : null,
          target3: pos.target3 ? Number(pos.target3) : null,
          leverage: Number(pos.leverage),
          usedMargin: Number(pos.usedMargin),
          status: pos.status,
          openedAt: pos.openedAt,
          tradeDecision: pos.tradeDecision,
          execution: pos.execution,
          fills: pos.fills,
        };
      }),
    );

    return enriched;
  }

  /**
   * Retrieves completed canonical PaperTrade records for an account with summary statistics.
   */
  async getCompletedTrades(
    accountId?: string,
    limit = 200,
  ): Promise<{ trades: any[]; stats: any }> {
    let targetAccountId = accountId;
    if (!targetAccountId) {
      const account = await this.getOrCreateAccount();
      targetAccountId = account.id;
    }

    const paperTrades = await this.prisma.paperTrade.findMany({
      where: { accountId: targetAccountId },
      orderBy: { exitTime: 'desc' },
      take: limit,
      include: {
        position: true,
      },
    });

    const trades = paperTrades.map((t) => {
      const charges = (t.chargesJson as any) || {};
      const outcome = (t.outcomeSnapshotJson as any) || {};
      return {
        id: t.id,
        accountId: t.accountId,
        positionId: t.positionId,
        symbol: t.symbol,
        contractSymbol: t.contractSymbol || t.symbol,
        instrumentType: t.instrumentType,
        strike: t.strike ? Number(t.strike) : null,
        optionType: t.optionType,
        expiry: t.expiry,
        direction: t.direction,
        strategyDirection: t.strategyDirection || t.direction,
        orderSide: t.orderSide || (t.direction === Direction.BULLISH ? 'BUY' : 'SELL'),
        quantity: Number(t.quantity),
        entryPrice: Number(t.entryPrice || 0),
        exitPrice: Number(t.exitPrice),
        realizedPnL: Number(t.realizedPnL || 0),
        realizedR: Number(t.realizedR || 0),
        pnlAmount: Number(t.realizedPnL || 0),
        pnlRMultiple: Number(t.realizedR || 0),
        fees: Number(t.fees ?? charges.totalCharges ?? 0),
        totalCharges: Number(t.fees ?? charges.totalCharges ?? 0),
        chargesJson: t.chargesJson,
        outcomeClassification: t.outcomeClassification || 'MANUAL_EXIT',
        exitReason: t.exitReason,
        entryTime: t.entryTime,
        exitTime: t.exitTime,
        activatedAt: t.entryTime ? t.entryTime.toISOString() : undefined,
        closedAt: t.exitTime.toISOString(),
        holdingDurationSeconds: t.holdingDurationSeconds,
        durationMinutes: t.holdingDurationSeconds ? Number((t.holdingDurationSeconds / 60).toFixed(1)) : 0,
        outcomeSnapshotJson: t.outcomeSnapshotJson,
        sourceBotId: t.sourceBotId,
        executionId: t.executionId,
        tradeDecisionId: t.tradeDecisionId,
        createdAt: t.createdAt,
      };
    });

    // Compute canonical stats
    const totalTrades = trades.length;
    const winningTrades = trades.filter((t) => t.realizedPnL > 0).length;
    const losingTrades = trades.filter((t) => t.realizedPnL < 0).length;
    const winRate = totalTrades > 0 ? Number(((winningTrades / totalTrades) * 100).toFixed(1)) : 0;
    const totalPnl = Number(trades.reduce((acc, t) => acc + t.realizedPnL, 0).toFixed(2));
    const grossProfit = trades.filter((t) => t.realizedPnL > 0).reduce((acc, t) => acc + t.realizedPnL, 0);
    const grossLoss = Math.abs(trades.filter((t) => t.realizedPnL < 0).reduce((acc, t) => acc + t.realizedPnL, 0));
    const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 999 : 0;
    const averageR = totalTrades > 0 ? Number((trades.reduce((acc, t) => acc + t.realizedR, 0) / totalTrades).toFixed(2)) : 0;

    const stats = {
      totalTrades,
      totalVerifiedTrades: totalTrades,
      legacyTradeCount: 0,
      winningTrades,
      losingTrades,
      winRate,
      totalPnl,
      profitFactor,
      averageR,
    };

    return { trades, stats };
  }

  /**
   * Scoped account-level clearing of completed paper trades in atomic transaction.
   * Does NOT wipe active positions and does NOT reset account cash balance.
   */
  async clearAllCompletedTrades(accountId?: string): Promise<{ success: boolean; count: number }> {
    let targetAccountId = accountId;
    if (!targetAccountId) {
      const account = await this.getOrCreateAccount();
      targetAccountId = account.id;
    }

    const result = await this.prisma.$transaction(async (tx) => {
      return tx.paperTrade.deleteMany({
        where: { accountId: targetAccountId },
      });
    });

    return {
      success: true,
      count: result.count,
    };
  }
}
