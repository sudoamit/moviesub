import {
  Direction,
  IBacktestTrade,
  ICandle,
  ISignalSetup,
  SignalGrade,
  SignalState,
  Timeframe,
} from '@quant/shared';
import { SignalGenerator } from '@quant/trading-engine';
import { PositionSizer, TradeLifecycleManager } from '@quant/risk-engine';
import { IBacktestOptions, IBacktestSimulationResult, IEquityPoint } from './types';
import { MetricsCalculator } from './metrics-calculator';

export class BacktestSimulator {
  /**
   * Simulates strategy historical execution candle-by-candle with zero look-ahead bias
   */
  static runSimulation(options: IBacktestOptions): IBacktestSimulationResult {
    const symbol = options.symbol.toUpperCase();
    const timeframe = (options.timeframe as string) || Timeframe.M15;
    const candles = options.candles;
    const initialCapital = options.initialCapital || 100000;
    const riskPercent = options.riskPerTradePercent || 1.0;
    const minScore = options.minScore || 65;
    const lotSize = options.lotSize || 1;

    let currentEquity = initialCapital;
    const trades: IBacktestTrade[] = [];
    const equityCurve: IEquityPoint[] = [
      {
        timestamp: candles[0]?.timestamp || new Date(),
        equity: initialCapital,
        drawdownPercent: 0,
      },
    ];

    if (!candles || candles.length < 50) {
      const emptyMetrics = MetricsCalculator.calculateMetrics([], initialCapital, equityCurve);
      return {
        id: `bt-${Date.now()}`,
        symbol,
        timeframe,
        initialCapital,
        ...emptyMetrics,
        trades: [],
        equityCurve,
      };
    }

    let activeSignal: ISignalSetup | null = null;
    let activeTradeUnits = 0;
    let activeTradeRiskAmount = 0;
    let activeTradeEntryTime: Date | null = null;
    let activeTradeEntryPrice = 0;

    const warmupBars = 40;

    for (let i = warmupBars; i < candles.length; i++) {
      const currentCandle = candles[i];
      const slice = candles.slice(0, i + 1);

      // 1. If currently in a trade or pending signal, manage tick update
      if (activeSignal) {
        const update = TradeLifecycleManager.evaluateTick(activeSignal, currentCandle);

        if (activeSignal.state === SignalState.PENDING && update.newState === SignalState.ACTIVE) {
          activeSignal.state = SignalState.ACTIVE;
          activeTradeEntryTime = currentCandle.timestamp;
          activeTradeEntryPrice = update.currentPrice;

          // Compute exact position sizing
          const sizing = PositionSizer.calculatePosition({
            accountBalance: currentEquity,
            riskPercentage: riskPercent,
            entryPrice: activeTradeEntryPrice,
            stopLoss: activeSignal.stopLoss,
            lotSize,
          });

          activeTradeUnits = sizing.roundedUnits > 0 ? sizing.roundedUnits : 1;
          activeTradeRiskAmount = sizing.riskAmount > 0 ? sizing.riskAmount : currentEquity * (riskPercent / 100);
        } else if (update.isClosed) {
          activeSignal.state = update.newState;

          if (activeTradeUnits > 0 && activeTradeEntryTime) {
            const isLong = activeSignal.direction === Direction.BULLISH;
            const exitPrice = update.currentPrice;
            const priceDiff = isLong
              ? (exitPrice - activeTradeEntryPrice)
              : (activeTradeEntryPrice - exitPrice);
            
            const realizedPnL = Number((priceDiff * activeTradeUnits).toFixed(2));
            const riskPerUnit = Math.abs(activeTradeEntryPrice - activeSignal.stopLoss);
            const pnlRMultiple = riskPerUnit > 0 ? Number((priceDiff / riskPerUnit).toFixed(2)) : update.pnlRMultiple;

            currentEquity = Number((currentEquity + realizedPnL).toFixed(2));

            const notionalVal = activeTradeUnits * activeTradeEntryPrice;
            const marginRequired = Number(Math.min(currentEquity, notionalVal / 5).toFixed(2));

            const tradeRecord: IBacktestTrade = {
              id: `tr-${trades.length + 1}`,
              direction: activeSignal.direction,
              entryTime: activeTradeEntryTime,
              entryPrice: activeTradeEntryPrice,
              exitTime: currentCandle.timestamp,
              exitPrice,
              stopLoss: activeSignal.stopLoss,
              takeProfit: activeSignal.takeProfits.tp2,
              positionSize: activeTradeUnits,
              marginRequired,
              riskAmount: Number(activeTradeRiskAmount.toFixed(2)),
              pnl: realizedPnL,
              pnlRMultiple,
              exitReason: update.newState,
            };

            trades.push(tradeRecord);

            equityCurve.push({
              timestamp: currentCandle.timestamp,
              equity: currentEquity,
              drawdownPercent: 0, // Will be computed by MetricsCalculator
            });
          }

          // Reset active trade
          activeSignal = null;
          activeTradeUnits = 0;
          activeTradeRiskAmount = 0;
          activeTradeEntryTime = null;
        } else {
          activeSignal.state = update.newState;
        }

        continue;
      }

      // 2. Scan for new high-confluence setup on historical bar i (Zero lookahead)
      const signal = SignalGenerator.generateSignal({
        symbol,
        executionCandles: slice,
        executionTimeframe: timeframe,
        htf1Candles: slice, // Self-contained for backtest simulation
      });

      if (
        signal.direction !== Direction.NEUTRAL &&
        signal.score >= minScore &&
        signal.grade !== SignalGrade.NO_TRADE
      ) {
        activeSignal = { ...signal, id: `sig-${i}`, state: SignalState.PENDING };
      }
    }

    // Compute comprehensive statistics
    const metrics = MetricsCalculator.calculateMetrics(trades, initialCapital, equityCurve);

    return {
      id: `bt-${symbol}-${timeframe}-${Date.now()}`,
      symbol,
      timeframe,
      initialCapital,
      ...metrics,
      trades,
      equityCurve,
    };
  }
}
