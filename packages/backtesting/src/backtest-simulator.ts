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
import {
  PositionSizer,
  TradeLifecycleManager,
  DEFAULT_PARTIAL_EXIT_POLICY,
  PositionLot,
  IExecutionEvent,
} from '@quant/risk-engine';
import {
  IBacktestOptions,
  IBacktestSimulationResult,
  IEquityPoint,
  IEquitySnapshot,
} from './types';
import { MetricsCalculator } from './metrics-calculator';
import { MarketDataRouter } from './market-data-router';
import {
  FillModel,
  SameCandleAmbiguityMode,
  FeeModel,
  SlippageModel,
  SpreadModel,
} from './execution';

export class BacktestSimulator {
  private static getDurationMs(tf: string): number {
    const unit = tf.slice(-1).toLowerCase();
    const val = parseInt(tf.slice(0, -1), 10) || 1;
    if (unit === 'm') return val * 60 * 1000;
    if (unit === 'h') return val * 3600 * 1000;
    if (unit === 'd') return val * 86400 * 1000;
    if (unit === 'w') return val * 7 * 86400 * 1000;
    return 15 * 60 * 1000;
  }

  /**
   * Simulates strategy historical execution candle-by-candle with zero look-ahead bias,
   * realistic fill models, partial scale-outs, fail-closed sizing, and bar-by-bar equity tracking.
   */
  static runSimulation(options: IBacktestOptions): IBacktestSimulationResult {
    const symbol = options.symbol.toUpperCase();
    const timeframe =
      (options.timeframe as string) || (options.executionTimeframe as string) || Timeframe.M15;
    const initialCapital = options.initialCapital || 100000;
    const riskPercent = options.riskPerTradePercent || 1.0;
    const minScore = options.minScore || 65;
    const lotSize = options.lotSize || 1;
    const fillModel = options.fillModel || FillModel.OHLC_PATH;
    const ambiguityMode = options.ambiguityMode || SameCandleAmbiguityMode.CONSERVATIVE;
    const partialPolicy = options.partialExitPolicy || DEFAULT_PARTIAL_EXIT_POLICY;
    const strategyMode = options.strategyMode || 'SMC';

    // 0. Temporal filter on candles if asOfTimestamp is provided
    let inputCandles = options.candles || [];
    if (options.asOfTimestamp) {
      const cutoffMs =
        options.asOfTimestamp instanceof Date
          ? options.asOfTimestamp.getTime()
          : new Date(options.asOfTimestamp).getTime();
      const tfMs = this.getDurationMs(timeframe);
      inputCandles = inputCandles.filter((c) => {
        const openMs =
          c.timestamp instanceof Date ? c.timestamp.getTime() : new Date(c.timestamp).getTime();
        return openMs + tfMs <= cutoffMs;
      });
    }

    const router = new MarketDataRouter({
      executionCandles: inputCandles,
      htf1Candles: options.htf1Candles,
      htf2Candles: options.htf2Candles,
      executionTimeframe: timeframe,
      htf1Timeframe: options.htf1Timeframe || '1h',
      htf2Timeframe: options.htf2Timeframe || '4h',
    });

    const executionCandles = router.getExecutionCandles();
    let currentCash = initialCapital;
    let currentEquity = initialCapital;

    const trades: IBacktestTrade[] = [];
    const positionLots: PositionLot[] = [];
    const executionEvents: IExecutionEvent[] = [];
    const equityCurve: IEquityPoint[] = [
      {
        timestamp: executionCandles[0]?.timestamp
          ? new Date(executionCandles[0].timestamp)
          : new Date(),
        equity: initialCapital,
        drawdownPercent: 0,
      },
    ];
    const equitySnapshots: IEquitySnapshot[] = [];

    if (!executionCandles || executionCandles.length < 50) {
      const emptyMetrics = MetricsCalculator.calculateMetrics([], initialCapital, equityCurve);
      return {
        id: `bt-${Date.now()}`,
        symbol,
        timeframe,
        initialCapital,
        trades: [],
        equityCurve,
        equitySnapshots: [],
        positionLots: [],
        executionEvents: [],
        ...emptyMetrics,
      };
    }

    let activeLot: PositionLot | null = null;
    let activeSignal: ISignalSetup | null = null;
    let activeEntryFee = 0;
    let activeSlippageCost = 0;
    const warmupBars = 40;

    for (let i = warmupBars; i < executionCandles.length; i++) {
      const currentCandle = executionCandles[i];
      const candleTime =
        currentCandle.timestamp instanceof Date
          ? currentCandle.timestamp.getTime()
          : new Date(currentCandle.timestamp).getTime();

      // 1. Manage Active Position Lot
      if (activeLot) {
        const tickRes = TradeLifecycleManager.evaluateLotTick(
          activeLot,
          currentCandle,
          partialPolicy,
          candleTime,
        );

        activeLot = tickRes.lot;
        executionEvents.push(...tickRes.events);

        // Calculate floating fees and unrealized PnL
        currentEquity = Number(
          (currentCash + activeLot.realizedPnl + activeLot.unrealizedPnl).toFixed(2),
        );

        if (tickRes.isClosed) {
          // Calculate exit fees & slippage
          const exitSide = activeLot.direction === Direction.BULLISH ? 'SELL' : 'BUY';
          const lastFill = activeLot.partialFills[activeLot.partialFills.length - 1];
          const exitPrice = lastFill?.price || activeLot.entryPrice;
          const exitFee = FeeModel.calculateFees(
            symbol,
            exitPrice,
            activeLot.initialQuantity,
            exitSide,
            false,
          );

          // Net trade PnL after all trading costs
          const grossPnl = activeLot.realizedPnl;
          const netPnl = Number((grossPnl - activeEntryFee - exitFee).toFixed(2));
          currentCash = Number((currentCash + netPnl).toFixed(2));
          currentEquity = currentCash;

          const isLong = activeLot.direction === Direction.BULLISH;
          const initialRisk = Math.abs(activeLot.entryPrice - activeLot.initialStopLoss);

          const tradeRecord: IBacktestTrade = {
            id: `tr-${trades.length + 1}`,
            direction: activeLot.direction,
            entryTime: new Date(activeLot.openedAt),
            entryPrice: activeLot.entryPrice,
            exitTime: new Date(activeLot.closedAt || candleTime),
            exitPrice,
            stopLoss: activeLot.initialStopLoss,
            takeProfit: activeLot.tp2,
            positionSize: activeLot.initialQuantity,
            marginRequired: Number(
              ((activeLot.initialQuantity * activeLot.entryPrice) / 5).toFixed(2),
            ),
            riskAmount: Number((initialRisk * activeLot.initialQuantity).toFixed(2)),
            pnl: netPnl,
            pnlRMultiple: activeLot.realizedR,
            exitReason: tickRes.state,
          };

          trades.push(tradeRecord);
          positionLots.push(activeLot);

          activeLot = null;
          activeSignal = null;
          activeEntryFee = 0;
          activeSlippageCost = 0;
        }

        // Record Bar-by-bar Snapshot
        const peak = Math.max(...equityCurve.map((e) => e.equity), initialCapital);
        const ddPercent = peak > 0 ? Number((((peak - currentEquity) / peak) * 100).toFixed(2)) : 0;

        equityCurve.push({
          timestamp: new Date(candleTime),
          equity: currentEquity,
          drawdownPercent: ddPercent,
        });

        equitySnapshots.push({
          timestamp: new Date(candleTime),
          cash: currentCash,
          realizedPnL: activeLot ? activeLot.realizedPnl : 0,
          unrealizedPnL: activeLot ? activeLot.unrealizedPnl : 0,
          equity: currentEquity,
          marginUsed: activeLot
            ? Number(((activeLot.remainingQuantity * activeLot.entryPrice) / 5).toFixed(2))
            : 0,
          availableMargin: Math.max(
            0,
            currentEquity -
              (activeLot ? (activeLot.remainingQuantity * activeLot.entryPrice) / 5 : 0),
          ),
          grossExposure: activeLot ? activeLot.remainingQuantity * activeLot.entryPrice : 0,
          netExposure: activeLot
            ? (activeLot.direction === Direction.BULLISH ? 1 : -1) *
              activeLot.remainingQuantity *
              activeLot.entryPrice
            : 0,
          fees: activeEntryFee,
          slippage: activeSlippageCost,
          drawdownPercent: ddPercent,
        });

        continue;
      }

      // 2. Evaluate Pending Signal Trigger
      if (activeSignal && activeSignal.state === SignalState.PENDING) {
        const isLong = activeSignal.direction === Direction.BULLISH;
        const entryHit = isLong
          ? currentCandle.low <= activeSignal.entryZone.max &&
            currentCandle.high >= activeSignal.entryZone.min
          : currentCandle.high >= activeSignal.entryZone.min &&
            currentCandle.low <= activeSignal.entryZone.max;

        if (entryHit) {
          // Compute fail-closed position sizing
          const sizing = PositionSizer.calculatePosition({
            accountBalance: currentEquity,
            riskPercentage: riskPercent,
            entryPrice: activeSignal.entryZone.optimal,
            stopLoss: activeSignal.stopLoss,
            lotSize,
          });

          // FAIL CLOSED: If sizing is invalid, reject trade
          if (!sizing.isValid || sizing.roundedUnits <= 0) {
            activeSignal = null;
          } else {
            // Apply fill model, spread & slippage to entry price
            const rawPrice = activeSignal.entryZone.optimal;
            const side = isLong ? 'BUY' : 'SELL';
            const slip = SlippageModel.calculateSlippage(
              rawPrice,
              sizing.roundedUnits,
              side,
              'LIMIT',
              currentCandle,
            );
            const halfSpread = SpreadModel.getHalfSpread(slip.executedPrice, symbol);
            const execEntryPrice =
              side === 'BUY' ? slip.executedPrice + halfSpread : slip.executedPrice - halfSpread;
            activeEntryFee = FeeModel.calculateFees(
              symbol,
              execEntryPrice,
              sizing.roundedUnits,
              side,
              true,
            );
            activeSlippageCost = slip.slippageAmount;

            activeLot = TradeLifecycleManager.createPositionLot(
              activeSignal,
              execEntryPrice,
              sizing.roundedUnits,
              candleTime,
            );
            executionEvents.push(...activeLot.events);
          }
        } else {
          // Check invalidation before entry
          const isInvalid = isLong
            ? currentCandle.low <= activeSignal.stopLoss
            : currentCandle.high >= activeSignal.stopLoss;
          if (isInvalid) {
            activeSignal = null;
          }
        }
      }

      // 3. Scan for new high-confluence setup on historical bar i (Zero lookahead via MarketDataRouter & explicit asOfTimestamp)
      if (!activeLot && !activeSignal) {
        const mtfData = router.getAvailableMarketDataAt(i);

        const signal = SignalGenerator.generateSignal({
          symbol,
          executionCandles: mtfData.executionSlice,
          executionTimeframe: timeframe,
          htf1Candles: mtfData.htf1Slice.length > 0 ? mtfData.htf1Slice : mtfData.executionSlice,
          htf1Timeframe: options.htf1Timeframe || '1h',
          htf2Candles: mtfData.htf2Slice.length > 0 ? mtfData.htf2Slice : undefined,
          htf2Timeframe: options.htf2Timeframe || '4h',
          strategyMode,
          asOfTimestamp: new Date(mtfData.timestamp),
        });

        if (
          signal.direction !== Direction.NEUTRAL &&
          signal.score >= minScore &&
          signal.grade !== SignalGrade.NO_TRADE
        ) {
          activeSignal = signal;
        }
      }

      // Record snapshot for flat bar
      const peak = Math.max(...equityCurve.map((e) => e.equity), initialCapital);
      const ddPercent = peak > 0 ? Number((((peak - currentEquity) / peak) * 100).toFixed(2)) : 0;

      equityCurve.push({
        timestamp: new Date(candleTime),
        equity: currentEquity,
        drawdownPercent: ddPercent,
      });

      equitySnapshots.push({
        timestamp: new Date(candleTime),
        cash: currentCash,
        realizedPnL: 0,
        unrealizedPnL: 0,
        equity: currentEquity,
        marginUsed: 0,
        availableMargin: currentEquity,
        grossExposure: 0,
        netExposure: 0,
        fees: 0,
        slippage: 0,
        drawdownPercent: ddPercent,
      });
    }

    const metrics = MetricsCalculator.calculateMetrics(
      trades,
      initialCapital,
      equityCurve,
      equitySnapshots,
      positionLots,
    );

    return {
      id: `bt-${Date.now()}`,
      symbol,
      timeframe,
      initialCapital,
      trades,
      equityCurve,
      equitySnapshots,
      positionLots,
      executionEvents,
      ...metrics,
    };
  }
}
