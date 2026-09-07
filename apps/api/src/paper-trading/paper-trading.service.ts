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
import { TrailingEngine, SessionFilter } from '@quant/trading-engine';

export interface IPaperOrderRequest {
  symbol: string;
  direction: 'BUY' | 'SELL';
  quantity: number;
  orderType: 'MARKET' | 'LIMIT';
  price?: number;
  signalPrice?: number;
  signalTime?: string;
  stopLoss?: number;
  target1?: number;
  target2?: number;
  target3?: number;
  leverage?: number;
  productType?: 'INTRADAY' | 'DELIVERY';
  instrumentType?: 'SPOT' | 'OPTION';
  strike?: number;
  optionType?: 'CE' | 'PE';
  contractSymbol?: string;
}

export interface IPaperPosition {
  id: string;
  symbol: string;
  contractSymbol: string;
  instrumentType: 'SPOT' | 'OPTION';
  strike?: number;
  optionType?: 'CE' | 'PE';
  direction: 'BUY' | 'SELL';
  quantity: number;
  signalPrice?: number;
  signalTime?: string;
  readonly entryPrice: number;
  readonly entryTime: string;
  averageEntryPrice: number;
  currentPrice: number;
  stopLoss?: number;
  initialStopLoss?: number;
  target1?: number;
  target2?: number;
  target3?: number;
  initialTarget1?: number;
  initialTarget2?: number;
  initialTarget3?: number;
  leverage: number;
  unrealizedPnL: number;
  unrealizedR: number;
  notionalValue: number;
  usedMargin: number;
  openedAt: string;
  trailingStopState?: {
    stage: string;
    stageBadge: string;
    currentStopLoss: number;
    isRiskFree: boolean;
    partialBookedPercent: number;
    recommendedAction: string;
  };
  charges: {
    brokerage: number;
    stt: number;
    exchangeTurnover: number;
    gst: number;
    sebiTurnover: number;
    totalCharges: number;
  };
}

export interface IPaperTradeHistory {
  id: string;
  symbol: string;
  contractSymbol?: string;
  instrumentType?: 'SPOT' | 'OPTION';
  strike?: number;
  optionType?: 'CE' | 'PE';
  direction: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  realizedPnL: number;
  realizedR: number;
  exitReason: string;
  openedAt: string;
  closedAt: string;
  totalCharges: number;
}

export interface IPaperPortfolio {
  initialCapital: number;
  cashBalance: number;
  usedMargin: number;
  availableMargin: number;
  totalEquity: number;
  realizedPnL: number;
  unrealizedPnL: number;
  totalChargesPaid: number;
  winRate: number;
  profitFactor: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  openPositions: IPaperPosition[];
  tradeHistory: IPaperTradeHistory[];
}

@Injectable()
export class PaperTradingService {
  private readonly logger = new Logger(PaperTradingService.name);

  // In-memory virtual account state with realistic institutional parameters
  private portfolioState: IPaperPortfolio = {
    initialCapital: 1000000.0, // ₹10,00,000 Starting Virtual Capital
    cashBalance: 1000000.0,
    usedMargin: 0.0,
    availableMargin: 1000000.0,
    totalEquity: 1000000.0,
    realizedPnL: 0.0,
    unrealizedPnL: 0.0,
    totalChargesPaid: 0.0,
    winRate: 0.0,
    profitFactor: 0.0,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    openPositions: [],
    tradeHistory: [],
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly candlesService: CandlesService,
    @Optional() private readonly realMarketStreamer?: RealMarketStreamerService,
  ) {
    this.logger.log('Paper Trading Virtual Brokerage initialized with ₹10,00,000 balance.');
  }

  /**
   * Calculates realistic Indian stock & crypto transaction charges (Brokerage, STT, GST, Exchange turnover)
   */
  private calculateCharges(
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

  private toSignalDirection(direction: 'BUY' | 'SELL'): 'BULLISH' | 'BEARISH' {
    return direction === 'BUY' ? 'BULLISH' : 'BEARISH';
  }

  private toClosedState(realizedR: number): 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'SL_HIT' {
    if (realizedR < 0) return 'SL_HIT';
    if (realizedR >= 4) return 'TP3_HIT';
    if (realizedR >= 1.5) return 'TP2_HIT';
    return 'TP1_HIT';
  }

  private getPrismaTimeframe() {
    return 'M15' as any;
  }

  private async persistExecutedTradeToJournal(
    pos: IPaperPosition,
    tradeRecord: IPaperTradeHistory,
  ): Promise<void> {
    const instrument = await this.prisma.instrument.findUnique({
      where: { symbol: this.normalizeSymbol(pos.symbol) },
    });

    if (!instrument) {
      this.logger.warn(`[PAPER JOURNAL SKIPPED] Instrument '${pos.symbol}' not found`);
      return;
    }

    const direction = this.toSignalDirection(pos.direction);
    const state = this.toClosedState(tradeRecord.realizedR);
    const initialStopLoss = pos.initialStopLoss ?? pos.stopLoss ?? pos.entryPrice;
    const riskRewardRatio = Math.max(Math.abs(tradeRecord.realizedR), 0.01);

    const existing = await this.prisma.signal.findFirst({
      where: {
        instrumentId: instrument.id,
        activatedAt: new Date(pos.entryTime),
        closedAt: new Date(tradeRecord.closedAt),
        entryPrice: pos.entryPrice,
        exitPrice: tradeRecord.exitPrice,
      },
    });

    if (existing) {
      return;
    }

    await this.prisma.signal.create({
      data: {
        instrumentId: instrument.id,
        direction: direction as any,
        state: state as any,
        grade: 'A_PLUS' as any,
        score: 100,
        timeframe: this.getPrismaTimeframe(),
        entryPrice: pos.entryPrice,
        stopLoss: initialStopLoss,
        target1: pos.initialTarget1 ?? pos.target1 ?? pos.entryPrice,
        target2: pos.initialTarget2 ?? pos.target2 ?? pos.entryPrice,
        target3: pos.initialTarget3 ?? pos.target3 ?? null,
        riskRewardRatio,
        exitPrice: tradeRecord.exitPrice,
        pnlAmount: tradeRecord.realizedPnL,
        pnlRMultiple: tradeRecord.realizedR,
        reasonsJson: {
          source: 'paper_execution',
          paperPositionId: pos.id,
          paperTradeId: tradeRecord.id,
          contractSymbol: pos.contractSymbol || pos.symbol,
          instrumentType: pos.instrumentType || 'SPOT',
          strike: pos.strike,
          optionType: pos.optionType,
          signalPrice: pos.signalPrice,
          signalTime: pos.signalTime,
          quantity: pos.quantity,
          entryPrice: pos.entryPrice,
          entryTime: pos.entryTime,
          exitPrice: tradeRecord.exitPrice,
          exitTime: tradeRecord.closedAt,
          exitReason: tradeRecord.exitReason,
          tradeReason: `${pos.contractSymbol || pos.symbol} ${direction} Paper Execution`,
          checklist: [
            'Order executed via virtual brokerage engine',
            'Authoritative immutable entry snapshot preserved',
            'Authoritative immutable exit snapshot recorded',
          ],
        },
        risksJson: {
          initialStopLoss,
          currentStopLoss: pos.stopLoss,
          initialTakeProfit: pos.initialTarget2 ?? pos.target2,
          totalCharges: tradeRecord.totalCharges,
        },
        activatedAt: new Date(pos.entryTime),
        closedAt: new Date(tradeRecord.closedAt),
      },
    });
  }

  /**
   * Retrieves current portfolio and refreshes live unrealized P&L
   */
  async getPortfolio(): Promise<IPaperPortfolio> {
    let totalUnrealized = 0.0;
    let totalUsedMargin = 0.0;
    const positionsToClose: { posId: string; reason: string }[] = [];

    // Refresh unrealized P&L for open positions using real live exchange price
    for (const pos of this.portfolioState.openPositions) {
      // Defensive guarantee: Never allow entryPrice or entryTime to be mutated or overwritten
      // Only currentPrice, unrealizedPnL, unrealizedR, notionalValue, trailingStopState change.
      let livePrice = pos.currentPrice;
      const ticker = this.realMarketStreamer?.getTicker(pos.symbol);
      if (ticker && ticker.price > 0 && pos.instrumentType !== 'OPTION') {
        livePrice = ticker.price;
      } else {
        try {
          const latestCandle = await this.candlesService.getLatestCandle(pos.symbol, '15m');
          if (latestCandle && latestCandle.close && pos.instrumentType !== 'OPTION') {
            livePrice = Number(latestCandle.close);
          }
        } catch (err) {
          // keep currentPrice if network fails
        }
      }

      pos.currentPrice = livePrice;

      const priceDiff =
        pos.direction === 'BUY'
          ? pos.currentPrice - pos.entryPrice
          : pos.entryPrice - pos.currentPrice;
      pos.unrealizedPnL = Number((priceDiff * pos.quantity - pos.charges.totalCharges).toFixed(2));

      const riskAnchor = pos.initialStopLoss ?? pos.stopLoss;
      const riskDistance = riskAnchor
        ? Math.abs(pos.entryPrice - riskAnchor)
        : pos.entryPrice * 0.005;
      pos.unrealizedR = riskDistance > 0 ? Number((priceDiff / riskDistance).toFixed(2)) : 0;
      pos.notionalValue = Number((pos.currentPrice * pos.quantity).toFixed(2));

      // Dynamic Trailing Stop & Auto-Breakeven Evaluation
      const tp1 =
        pos.initialTarget1 ||
        pos.target1 ||
        (pos.direction === 'BUY' ? pos.entryPrice * 1.015 : pos.entryPrice * 0.985);
      const tp2 =
        pos.initialTarget2 ||
        pos.target2 ||
        (pos.direction === 'BUY' ? pos.entryPrice * 1.025 : pos.entryPrice * 0.975);
      const initialSl =
        pos.initialStopLoss ||
        pos.stopLoss ||
        (pos.direction === 'BUY' ? pos.entryPrice * 0.99 : pos.entryPrice * 1.01);

      const trailing = TrailingEngine.evaluate(
        pos.entryPrice,
        initialSl,
        tp1,
        tp2,
        pos.currentPrice,
        pos.direction === 'BUY' ? 'BULLISH' : 'BEARISH',
      );

      pos.trailingStopState = {
        stage: trailing.stage,
        stageBadge: trailing.stageBadge,
        currentStopLoss: trailing.currentStopLoss,
        isRiskFree: trailing.isRiskFree,
        partialBookedPercent: trailing.partialBookedPercent,
        recommendedAction: trailing.recommendedAction,
      };

      // Auto-trail SL if breakeven or trailing runner is active
      if (trailing.isRiskFree) {
        if (pos.direction === 'BUY' && trailing.currentStopLoss > (pos.stopLoss || 0)) {
          pos.stopLoss = trailing.currentStopLoss;
        } else if (
          pos.direction === 'SELL' &&
          trailing.currentStopLoss < (pos.stopLoss || Infinity)
        ) {
          pos.stopLoss = trailing.currentStopLoss;
        }
      }

      // Calculate age of position to prevent sub-second auto-close races
      const openedTime = new Date(pos.openedAt).getTime();
      const posAgeMs = Date.now() - openedTime;
      const minAgeMs = 3000; // Require position to be active for at least 3 seconds before auto-evaluating exits

      // Auto SL Trigger Check
      if (pos.stopLoss && posAgeMs >= minAgeMs) {
        const isSLHit =
          pos.direction === 'BUY'
            ? pos.stopLoss < pos.entryPrice && pos.currentPrice <= pos.stopLoss
            : pos.stopLoss > pos.entryPrice && pos.currentPrice >= pos.stopLoss;

        if (isSLHit) {
          positionsToClose.push({
            posId: pos.id,
            reason: trailing.isRiskFree
              ? 'Breakeven / Trailing SL Triggered'
              : 'Initial Stop Loss Triggered (SL)',
          });
          continue;
        }
      }

      // Auto TP3 Trigger Check
      if (pos.target3 && posAgeMs >= minAgeMs) {
        const isTP3Hit =
          pos.direction === 'BUY'
            ? pos.target3 > pos.entryPrice && pos.currentPrice >= pos.target3
            : pos.target3 < pos.entryPrice && pos.currentPrice <= pos.target3;

        if (isTP3Hit) {
          positionsToClose.push({
            posId: pos.id,
            reason: 'Final Take Profit (TP3 Runner) Achieved',
          });
          continue;
        }
      }

      totalUnrealized += pos.unrealizedPnL;
      totalUsedMargin += pos.usedMargin;
    }

    // Auto close any positions that triggered TP/SL
    for (const item of positionsToClose) {
      await this.closePosition(item.posId, item.reason);
    }

    this.portfolioState.unrealizedPnL = Number(totalUnrealized.toFixed(2));
    this.portfolioState.usedMargin = Number(totalUsedMargin.toFixed(2));
    this.portfolioState.availableMargin = Number(
      (this.portfolioState.cashBalance - this.portfolioState.usedMargin).toFixed(2),
    );
    this.portfolioState.totalEquity = Number(
      (this.portfolioState.cashBalance + this.portfolioState.unrealizedPnL).toFixed(2),
    );

    // Calculate Profit Factor
    const grossWins = this.portfolioState.tradeHistory
      .filter((t) => t.realizedPnL > 0)
      .reduce((acc, t) => acc + t.realizedPnL, 0);
    const grossLosses = Math.abs(
      this.portfolioState.tradeHistory
        .filter((t) => t.realizedPnL < 0)
        .reduce((acc, t) => acc + t.realizedPnL, 0),
    );
    this.portfolioState.profitFactor =
      grossLosses > 0 ? Number((grossWins / grossLosses).toFixed(2)) : grossWins > 0 ? 99.9 : 0.0;

    return this.portfolioState;
  }

  /**
   * Places a virtual paper order with real-world margin & fee checks
   */
  async placeOrder(req: IPaperOrderRequest): Promise<IPaperPosition> {
    if (!req.symbol || !req.direction || !req.quantity || req.quantity <= 0) {
      throw new BadRequestException('Invalid order parameters');
    }

    const symbol = this.normalizeSymbol(req.symbol);
    const isCrypto = symbol === 'BTCUSDT';
    const instrumentType = req.instrumentType || (req.strike ? 'OPTION' : 'SPOT');
    const contractSymbol =
      req.contractSymbol ||
      (req.strike && req.optionType ? `${symbol} ${req.strike} ${req.optionType}` : symbol);

    // Determine execution price: use explicitly provided price (e.g. limit order, option premium, or specific execution price) or live market price
    let executionPrice = req.price;
    if (!executionPrice || executionPrice <= 0) {
      const ticker = this.realMarketStreamer?.getTicker(symbol);
      if (ticker && ticker.price > 0 && instrumentType !== 'OPTION') {
        executionPrice = ticker.price;
      } else {
        try {
          const latestCandle = await this.candlesService.getLatestCandle(symbol, '15m');
          if (latestCandle && latestCandle.close && instrumentType !== 'OPTION') {
            executionPrice = Number(latestCandle.close);
          }
        } catch (err) {
          executionPrice = isCrypto
            ? 79230.0
            : symbol === 'XAUUSD' || symbol === 'GOLD'
              ? 2885.5
              : symbol === 'BANKNIFTY'
                ? 57400.0
                : symbol === 'NIFTY'
                  ? 24100.0
                  : 100.0;
        }
      }
    }
    if (!executionPrice || executionPrice <= 0) {
      executionPrice = isCrypto
        ? 79230.0
        : symbol === 'XAUUSD' || symbol === 'GOLD'
          ? 2885.5
          : symbol === 'BANKNIFTY'
            ? 57400.0
            : symbol === 'NIFTY'
              ? 24100.0
              : 100.0;
    }

    // Directional sanity & Risk/Reward alignment for SL and TPs relative to executionPrice
    const isBuy = req.direction === 'BUY';
    let stopLoss = req.stopLoss;
    let target1 = req.target1;
    let target2 = req.target2;
    let target3 = req.target3;

    // Validate Stop Loss
    if (isBuy) {
      if (!stopLoss || stopLoss >= executionPrice) {
        stopLoss = Number((executionPrice * 0.99).toFixed(2));
      }
    } else {
      if (!stopLoss || stopLoss <= executionPrice) {
        stopLoss = Number((executionPrice * 1.01).toFixed(2));
      }
    }

    const riskDistance = Math.max(Math.abs(executionPrice - stopLoss), executionPrice * 0.005);

    // Validate Take Profits (must be beyond executionPrice in trade direction)
    if (isBuy) {
      if (!target1 || target1 <= executionPrice) {
        target1 = Number((executionPrice + 1.5 * riskDistance).toFixed(2));
      }
      if (!target2 || target2 <= executionPrice) {
        target2 = Number((executionPrice + 2.5 * riskDistance).toFixed(2));
      }
      if (!target3 || target3 <= executionPrice) {
        target3 = Number((executionPrice + 4.0 * riskDistance).toFixed(2));
      }
    } else {
      if (!target1 || target1 >= executionPrice) {
        target1 = Number((executionPrice - 1.5 * riskDistance).toFixed(2));
      }
      if (!target2 || target2 >= executionPrice) {
        target2 = Number((executionPrice - 2.5 * riskDistance).toFixed(2));
      }
      if (!target3 || target3 >= executionPrice) {
        target3 = Number((executionPrice - 4.0 * riskDistance).toFixed(2));
      }
    }

    const turnover = executionPrice * req.quantity;
    const charges = this.calculateCharges(turnover, isCrypto);

    const effLeverage = Math.max(1, req.leverage || 5);
    const requiredMargin = Number((turnover / effLeverage + charges.totalCharges).toFixed(2));

    if (this.portfolioState.availableMargin < requiredMargin) {
      throw new BadRequestException(
        `Insufficient margin. Required: ₹${requiredMargin.toFixed(2)}, Available: ₹${this.portfolioState.availableMargin.toFixed(2)}`,
      );
    }

    // Deduct entry charges from cash balance
    this.portfolioState.cashBalance = Number(
      (this.portfolioState.cashBalance - charges.totalCharges).toFixed(2),
    );
    this.portfolioState.totalChargesPaid = Number(
      (this.portfolioState.totalChargesPaid + charges.totalCharges).toFixed(2),
    );

    const entryTime = new Date().toISOString();
    const newPosition: IPaperPosition = {
      id: `paper_pos_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      symbol,
      contractSymbol,
      instrumentType,
      strike: req.strike,
      optionType: req.optionType,
      direction: req.direction,
      quantity: req.quantity,
      signalPrice: req.signalPrice || executionPrice,
      signalTime: req.signalTime || entryTime,
      entryPrice: executionPrice,
      entryTime,
      averageEntryPrice: executionPrice,
      currentPrice: executionPrice,
      stopLoss,
      initialStopLoss: stopLoss,
      target1,
      target2,
      target3,
      initialTarget1: target1,
      initialTarget2: target2,
      initialTarget3: target3,
      leverage: effLeverage,
      unrealizedPnL: -charges.totalCharges,
      unrealizedR: 0,
      notionalValue: turnover,
      usedMargin: requiredMargin,
      openedAt: entryTime,
      charges,
    };

    // Immutability runtime freeze for entry attributes
    Object.defineProperty(newPosition, 'entryPrice', { writable: false, configurable: false });
    Object.defineProperty(newPosition, 'entryTime', { writable: false, configurable: false });

    this.portfolioState.openPositions.push(newPosition);
    this.portfolioState.usedMargin = Number(
      (this.portfolioState.usedMargin + requiredMargin).toFixed(2),
    );
    this.portfolioState.availableMargin = Number(
      (this.portfolioState.cashBalance - this.portfolioState.usedMargin).toFixed(2),
    );

    this.logger.log(
      `✓ [PAPER ORDER EXECUTED] ${req.direction} ${req.quantity} ${contractSymbol} @ ₹${executionPrice.toFixed(2)} (${effLeverage}x) | Margin: ₹${requiredMargin.toFixed(2)}`,
    );
    return newPosition;
  }

  /**
   * Closes an existing paper position, books realized P&L, deducts exit charges, and updates portfolio stats
   */
  async closePosition(
    positionId: string,
    exitReason = 'Manual Exit',
    exitPriceOverride?: number,
  ): Promise<IPaperTradeHistory> {
    const posIndex = this.portfolioState.openPositions.findIndex((p) => p.id === positionId);
    if (posIndex === -1) {
      throw new NotFoundException(`Position with ID '${positionId}' not found`);
    }

    const pos = this.portfolioState.openPositions[posIndex];
    const isCrypto = pos.symbol === 'BTCUSDT';

    // Refresh latest live exit price
    let exitPrice =
      exitPriceOverride && exitPriceOverride > 0 ? exitPriceOverride : pos.currentPrice;
    if (!exitPriceOverride) {
      const ticker = this.realMarketStreamer?.getTicker(pos.symbol);
      if (ticker && ticker.price > 0 && pos.instrumentType !== 'OPTION') {
        exitPrice = ticker.price;
      } else {
        try {
          const latestCandle = await this.candlesService.getLatestCandle(pos.symbol, '15m');
          if (latestCandle && latestCandle.close && pos.instrumentType !== 'OPTION') {
            exitPrice = Number(latestCandle.close);
          }
        } catch {
          // keep pos.currentPrice
        }
      }
    }

    const exitTime = new Date().toISOString();
    const exitTurnover = exitPrice * pos.quantity;
    const exitCharges = this.calculateCharges(exitTurnover, isCrypto);

    const priceDiff =
      pos.direction === 'BUY' ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice;
    const totalCharges = Number((pos.charges.totalCharges + exitCharges.totalCharges).toFixed(2));
    const grossPnL = priceDiff * pos.quantity;
    const realizedPnL = Number((grossPnL - totalCharges).toFixed(2));

    const riskAnchor = pos.initialStopLoss ?? pos.stopLoss;
    const riskDistance = riskAnchor
      ? Math.abs(pos.entryPrice - riskAnchor)
      : pos.entryPrice * 0.005;
    const realizedR = riskDistance > 0 ? Number((priceDiff / riskDistance).toFixed(2)) : 0;

    // Release margin and add realized P&L to cash
    this.portfolioState.cashBalance = Number(
      (
        this.portfolioState.cashBalance +
        pos.usedMargin +
        grossPnL -
        exitCharges.totalCharges
      ).toFixed(2),
    );
    this.portfolioState.totalChargesPaid = Number(
      (this.portfolioState.totalChargesPaid + exitCharges.totalCharges).toFixed(2),
    );
    this.portfolioState.realizedPnL = Number(
      (this.portfolioState.realizedPnL + realizedPnL).toFixed(2),
    );
    this.portfolioState.usedMargin = Number(
      (this.portfolioState.usedMargin - pos.usedMargin).toFixed(2),
    );
    this.portfolioState.availableMargin = Number(
      (this.portfolioState.cashBalance - this.portfolioState.usedMargin).toFixed(2),
    );
    this.portfolioState.totalEquity = Number(
      (this.portfolioState.cashBalance + this.portfolioState.unrealizedPnL).toFixed(2),
    );

    // Update Stats
    this.portfolioState.totalTrades += 1;
    if (realizedPnL > 0) {
      this.portfolioState.winningTrades += 1;
    } else {
      this.portfolioState.losingTrades += 1;
    }
    this.portfolioState.winRate = Number(
      ((this.portfolioState.winningTrades / this.portfolioState.totalTrades) * 100).toFixed(1),
    );

    const tradeRecord: IPaperTradeHistory = {
      id: `trade_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      symbol: pos.symbol,
      contractSymbol: pos.contractSymbol || pos.symbol,
      instrumentType: pos.instrumentType,
      strike: pos.strike,
      optionType: pos.optionType,
      direction: pos.direction,
      quantity: pos.quantity,
      entryPrice: pos.entryPrice,
      exitPrice,
      realizedPnL,
      realizedR,
      exitReason,
      openedAt: pos.entryTime,
      closedAt: exitTime,
      totalCharges,
    };

    this.portfolioState.tradeHistory.unshift(tradeRecord);
    this.portfolioState.openPositions.splice(posIndex, 1);
    await this.persistExecutedTradeToJournal(pos, tradeRecord);

    this.logger.log(
      `✓ [PAPER POSITION CLOSED] ${pos.contractSymbol || pos.symbol} ${pos.direction} @ ₹${exitPrice.toFixed(2)} | Net PnL: ₹${realizedPnL.toFixed(2)} (${realizedR}R) [${exitReason}]`,
    );
    return tradeRecord;
  }

  /**
   * Resets the entire paper trading virtual portfolio back to initial starting state
   */
  async resetPortfolio(initialCapital = 1000000.0): Promise<IPaperPortfolio> {
    this.portfolioState = {
      initialCapital,
      cashBalance: initialCapital,
      usedMargin: 0.0,
      availableMargin: initialCapital,
      totalEquity: initialCapital,
      realizedPnL: 0.0,
      unrealizedPnL: 0.0,
      totalChargesPaid: 0.0,
      winRate: 0.0,
      profitFactor: 0.0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      openPositions: [],
      tradeHistory: [],
    };

    this.logger.log(
      `Virtual Portfolio reset to initial capital: ₹${initialCapital.toLocaleString()}`,
    );
    return this.portfolioState;
  }
}
