import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CandlesService } from '../candles/candles.service';
import { TrailingEngine, SessionFilter } from '@quant/trading-engine';

export interface IPaperOrderRequest {
  symbol: string;
  direction: 'BUY' | 'SELL';
  quantity: number;
  orderType: 'MARKET' | 'LIMIT';
  price?: number;
  stopLoss?: number;
  target1?: number;
  target2?: number;
  target3?: number;
  leverage?: number;
  productType?: 'INTRADAY' | 'DELIVERY';
}

export interface IPaperPosition {
  id: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  quantity: number;
  averageEntryPrice: number;
  currentPrice: number;
  stopLoss?: number;
  target1?: number;
  target2?: number;
  target3?: number;
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
  ) {
    this.logger.log('Paper Trading Virtual Brokerage initialized with ₹10,00,000 balance.');
  }

  /**
   * Calculates realistic Indian stock & crypto transaction charges (Brokerage, STT, GST, Exchange turnover)
   */
  private calculateCharges(turnover: number, isCrypto: boolean): {
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
    const totalCharges = Number((brokerage + stt + exchangeTurnover + gst + sebiTurnover).toFixed(2));

    return {
      brokerage,
      stt,
      exchangeTurnover,
      gst,
      sebiTurnover,
      totalCharges,
    };
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
      try {
        const latestCandle = await this.candlesService.getLatestCandle(pos.symbol, '15m');
        if (latestCandle && latestCandle.close) {
          pos.currentPrice = Number(latestCandle.close);
        }
      } catch (err) {
        // keep currentPrice if network fails
      }

      const priceDiff = pos.direction === 'BUY' ? pos.currentPrice - pos.averageEntryPrice : pos.averageEntryPrice - pos.currentPrice;
      pos.unrealizedPnL = Number((priceDiff * pos.quantity - pos.charges.totalCharges).toFixed(2));
      
      const riskDistance = pos.stopLoss ? Math.abs(pos.averageEntryPrice - pos.stopLoss) : (pos.averageEntryPrice * 0.005);
      pos.unrealizedR = riskDistance > 0 ? Number((priceDiff / riskDistance).toFixed(2)) : 0;
      pos.notionalValue = Number((pos.currentPrice * pos.quantity).toFixed(2));

      // Dynamic Trailing Stop & Auto-Breakeven Evaluation
      const tp1 = pos.target1 || (pos.direction === 'BUY' ? pos.averageEntryPrice * 1.015 : pos.averageEntryPrice * 0.985);
      const tp2 = pos.target2 || (pos.direction === 'BUY' ? pos.averageEntryPrice * 1.025 : pos.averageEntryPrice * 0.975);
      const initialSl = pos.stopLoss || (pos.direction === 'BUY' ? pos.averageEntryPrice * 0.99 : pos.averageEntryPrice * 1.01);

      const trailing = TrailingEngine.evaluate(
        pos.averageEntryPrice,
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
        } else if (pos.direction === 'SELL' && trailing.currentStopLoss < (pos.stopLoss || Infinity)) {
          pos.stopLoss = trailing.currentStopLoss;
        }
      }

      // Auto SL Trigger Check
      if (pos.stopLoss) {
        const isSLHit = pos.direction === 'BUY' ? pos.currentPrice <= pos.stopLoss : pos.currentPrice >= pos.stopLoss;
        if (isSLHit) {
          positionsToClose.push({
            posId: pos.id,
            reason: trailing.isRiskFree ? 'Breakeven / Trailing SL Triggered' : 'Initial Stop Loss Triggered (SL)',
          });
          continue;
        }
      }

      // Auto TP3 Trigger Check
      if (pos.target3) {
        const isTP3Hit = pos.direction === 'BUY' ? pos.currentPrice >= pos.target3 : pos.currentPrice <= pos.target3;
        if (isTP3Hit) {
          positionsToClose.push({ posId: pos.id, reason: 'Final Take Profit (TP3 Runner) Achieved' });
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
    this.portfolioState.availableMargin = Number((this.portfolioState.cashBalance - this.portfolioState.usedMargin).toFixed(2));
    this.portfolioState.totalEquity = Number((this.portfolioState.cashBalance + this.portfolioState.unrealizedPnL).toFixed(2));

    // Calculate Profit Factor
    const grossWins = this.portfolioState.tradeHistory.filter((t) => t.realizedPnL > 0).reduce((acc, t) => acc + t.realizedPnL, 0);
    const grossLosses = Math.abs(this.portfolioState.tradeHistory.filter((t) => t.realizedPnL < 0).reduce((acc, t) => acc + t.realizedPnL, 0));
    this.portfolioState.profitFactor = grossLosses > 0 ? Number((grossWins / grossLosses).toFixed(2)) : grossWins > 0 ? 99.9 : 0.0;

    return this.portfolioState;
  }

  /**
   * Places a virtual paper order with real-world margin & fee checks
   */
  async placeOrder(req: IPaperOrderRequest): Promise<IPaperPosition> {
    if (!req.symbol || !req.direction || !req.quantity || req.quantity <= 0) {
      throw new BadRequestException('Invalid order parameters');
    }

    let executionPrice = req.price;
    if (!executionPrice) {
      try {
        const latestCandle = await this.candlesService.getLatestCandle(req.symbol, '15m');
        executionPrice = Number(latestCandle.close);
      } catch (err) {
        executionPrice = 100.0;
      }
    }

    const isCrypto = req.symbol === 'BTCUSDT';
    const turnover = executionPrice * req.quantity;
    const charges = this.calculateCharges(turnover, isCrypto);

    const effLeverage = Math.max(1, req.leverage || 5);
    const requiredMargin = Number((turnover / effLeverage + charges.totalCharges).toFixed(2));

    if (this.portfolioState.availableMargin < requiredMargin) {
      throw new BadRequestException(`Insufficient margin. Required: ₹${requiredMargin.toFixed(2)}, Available: ₹${this.portfolioState.availableMargin.toFixed(2)}`);
    }

    // Deduct entry charges from cash balance
    this.portfolioState.cashBalance = Number((this.portfolioState.cashBalance - charges.totalCharges).toFixed(2));
    this.portfolioState.totalChargesPaid = Number((this.portfolioState.totalChargesPaid + charges.totalCharges).toFixed(2));

    const newPosition: IPaperPosition = {
      id: `paper_pos_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      symbol: req.symbol,
      direction: req.direction,
      quantity: req.quantity,
      averageEntryPrice: executionPrice,
      currentPrice: executionPrice,
      stopLoss: req.stopLoss,
      target1: req.target1,
      target2: req.target2,
      target3: req.target3,
      leverage: effLeverage,
      unrealizedPnL: -charges.totalCharges,
      unrealizedR: 0,
      notionalValue: turnover,
      usedMargin: requiredMargin,
      openedAt: new Date().toISOString(),
      charges,
    };

    this.portfolioState.openPositions.push(newPosition);
    this.portfolioState.usedMargin = Number((this.portfolioState.usedMargin + requiredMargin).toFixed(2));
    this.portfolioState.availableMargin = Number((this.portfolioState.cashBalance - this.portfolioState.usedMargin).toFixed(2));

    this.logger.log(`✓ [PAPER ORDER EXECUTED] ${req.direction} ${req.quantity} ${req.symbol} @ ₹${executionPrice.toFixed(2)} (${effLeverage}x) | Margin: ₹${requiredMargin.toFixed(2)}`);
    return newPosition;
  }

  /**
   * Closes an existing paper position, books realized P&L, deducts exit charges, and updates portfolio stats
   */
  async closePosition(positionId: string, exitReason = 'Manual Exit'): Promise<IPaperTradeHistory> {
    const posIndex = this.portfolioState.openPositions.findIndex((p) => p.id === positionId);
    if (posIndex === -1) {
      throw new NotFoundException(`Position with ID '${positionId}' not found`);
    }

    const pos = this.portfolioState.openPositions[posIndex];
    const isCrypto = pos.symbol === 'BTCUSDT';
    
    // Refresh latest live exit price
    try {
      const latestCandle = await this.candlesService.getLatestCandle(pos.symbol, '15m');
      if (latestCandle && latestCandle.close) {
        pos.currentPrice = Number(latestCandle.close);
      }
    } catch {
      // keep currentPrice
    }

    const exitPrice = pos.currentPrice;
    const exitTurnover = exitPrice * pos.quantity;
    const exitCharges = this.calculateCharges(exitTurnover, isCrypto);

    const priceDiff = pos.direction === 'BUY' ? exitPrice - pos.averageEntryPrice : pos.averageEntryPrice - exitPrice;
    const totalCharges = Number((pos.charges.totalCharges + exitCharges.totalCharges).toFixed(2));
    const grossPnL = priceDiff * pos.quantity;
    const realizedPnL = Number((grossPnL - totalCharges).toFixed(2));

    const riskDistance = pos.stopLoss ? Math.abs(pos.averageEntryPrice - pos.stopLoss) : (pos.averageEntryPrice * 0.005);
    const realizedR = riskDistance > 0 ? Number((priceDiff / riskDistance).toFixed(2)) : 0;

    // Release margin and add realized P&L to cash
    this.portfolioState.cashBalance = Number((this.portfolioState.cashBalance + pos.usedMargin + grossPnL - exitCharges.totalCharges).toFixed(2));
    this.portfolioState.totalChargesPaid = Number((this.portfolioState.totalChargesPaid + exitCharges.totalCharges).toFixed(2));
    this.portfolioState.realizedPnL = Number((this.portfolioState.realizedPnL + realizedPnL).toFixed(2));
    this.portfolioState.usedMargin = Number((this.portfolioState.usedMargin - pos.usedMargin).toFixed(2));
    this.portfolioState.availableMargin = Number((this.portfolioState.cashBalance - this.portfolioState.usedMargin).toFixed(2));
    this.portfolioState.totalEquity = Number((this.portfolioState.cashBalance + this.portfolioState.unrealizedPnL).toFixed(2));

    // Update Stats
    this.portfolioState.totalTrades += 1;
    if (realizedPnL > 0) {
      this.portfolioState.winningTrades += 1;
    } else {
      this.portfolioState.losingTrades += 1;
    }
    this.portfolioState.winRate = Number(((this.portfolioState.winningTrades / this.portfolioState.totalTrades) * 100).toFixed(1));

    const tradeRecord: IPaperTradeHistory = {
      id: `trade_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      symbol: pos.symbol,
      direction: pos.direction,
      quantity: pos.quantity,
      entryPrice: pos.averageEntryPrice,
      exitPrice,
      realizedPnL,
      realizedR,
      exitReason,
      openedAt: pos.openedAt,
      closedAt: new Date().toISOString(),
      totalCharges,
    };

    this.portfolioState.tradeHistory.unshift(tradeRecord);
    this.portfolioState.openPositions.splice(posIndex, 1);

    this.logger.log(`✓ [PAPER POSITION CLOSED] ${pos.symbol} ${pos.direction} @ ₹${exitPrice.toFixed(2)} | Net PnL: ₹${realizedPnL.toFixed(2)} (${realizedR}R) [${exitReason}]`);
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

    this.logger.log(`Virtual Portfolio reset to initial capital: ₹${initialCapital.toLocaleString()}`);
    return this.portfolioState;
  }
}
