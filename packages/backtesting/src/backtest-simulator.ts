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
  IPartialFillRecord,
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
  ExecutionSimulator,
  IOrder,
  IFill,
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
   * authoritative ExecutionSimulator order/fill pipeline, gap handling, fail-closed sizing,
   * and bar-by-bar equity tracking.
   */
  static runSimulation(options: IBacktestOptions): IBacktestSimulationResult {
    const symbol = options.symbol.toUpperCase();
    const timeframe =
      (options.timeframe as string) || (options.executionTimeframe as string) || Timeframe.M15;
    const initialCapital = options.initialCapital || 100000;
    const riskPercent = options.riskPerTradePercent || 1.0;
    const minScore = options.minScore || 65;
    const lotSize = options.lotSize || 1;
    const fillModel = options.fillModel || FillModel.NEXT_BAR_MARKET;
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

    const runId = `bt_${symbol.toLowerCase()}_${timeframe}`;
    const execSim = new ExecutionSimulator(
      fillModel,
      ambiguityMode,
      { submissionLatencyMs: 0, processingLatencyMs: 0 },
      runId,
    );

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
    let pendingEntryOrder: IOrder | null = null;
    let pendingEntrySignal: ISignalSetup | null = null;
    let activeExitOrders: Map<string, { order: IOrder; targetType: string }> = new Map();

    let cumulativeFees = 0;
    let cumulativeSlippage = 0;
    const warmupBars = 40;

    for (let i = warmupBars; i < executionCandles.length; i++) {
      const currentCandle = executionCandles[i];
      const nextCandle = i < executionCandles.length - 1 ? executionCandles[i + 1] : undefined;
      const candleTime =
        currentCandle.timestamp instanceof Date
          ? currentCandle.timestamp.getTime()
          : new Date(currentCandle.timestamp).getTime();

      // 1. Process Candle through Authoritative ExecutionSimulator
      const subBarCandles = options.lowerTfCandles;
      const simResult = execSim.processCandle(currentCandle, nextCandle, subBarCandles);
      executionEvents.push(...simResult.events);

      // 2. Handle Entry Order Fill
      if (pendingEntryOrder && pendingEntryOrder.status === 'FILLED') {
        const fill = simResult.fills.find((f) => f.orderId === pendingEntryOrder!.orderId);
        if (fill && pendingEntrySignal) {
          const isLong = pendingEntrySignal.direction === Direction.BULLISH;
          const refPrice = pendingEntryOrder.referencePrice || pendingEntrySignal.entryZone.optimal;
          const initialRiskDist = Math.abs(refPrice - pendingEntrySignal.stopLoss);
          const priceDrift = Math.abs(fill.price - refPrice);
          const riskDriftRatio = initialRiskDist > 0 ? priceDrift / initialRiskDist : 0;

          // Fail Closed on Excessive Risk Drift (> 25% of risk distance)
          if (riskDriftRatio > 0.25) {
            executionEvents.push({
              eventId: `${runId}_evt_reject_${candleTime}`,
              tradeId: pendingEntrySignal.id || `trade_${candleTime}`,
              orderId: pendingEntryOrder.orderId,
              symbol,
              eventType: 'ORDER_REJECTED',
              timestamp: candleTime,
              price: fill.price,
              quantity: fill.quantity,
              remainingQuantity: 0,
              fees: fill.fee,
              slippage: fill.slippage,
              reason: `Rejected: Excessive risk drift (${(riskDriftRatio * 100).toFixed(1)}% > 25%)`,
            });
            pendingEntryOrder = null;
            pendingEntrySignal = null;
          } else {
            // Create Position Lot strictly from actual IFill result
            activeLot = TradeLifecycleManager.createPositionLot(
              pendingEntrySignal,
              fill.price,
              fill.quantity,
              fill.timestamp,
              pendingEntryOrder.orderId,
            );
            cumulativeFees += fill.fee;
            cumulativeSlippage += fill.slippage;

            pendingEntryOrder = null;
            pendingEntrySignal = null;
          }
        }
      }

      // 3. Handle Active Position Lot Exits & Trailing Stops
      if (activeLot && activeLot.status !== 'CLOSED') {
        const isLong = activeLot.direction === Direction.BULLISH;
        const low = currentCandle.low;
        const high = currentCandle.high;
        const close = currentCandle.close;

        // Track MAE / MFE
        const adversePrice = isLong
          ? Math.max(0, activeLot.entryPrice - low)
          : Math.max(0, high - activeLot.entryPrice);
        const favorablePrice = isLong
          ? Math.max(0, high - activeLot.entryPrice)
          : Math.max(0, activeLot.entryPrice - low);
        activeLot.mae = Math.max(activeLot.mae, adversePrice);
        activeLot.mfe = Math.max(activeLot.mfe, favorablePrice);

        // Update floating unrealized PnL
        const unitDiff = isLong ? close - activeLot.entryPrice : activeLot.entryPrice - close;
        activeLot.unrealizedPnl = Number((unitDiff * activeLot.remainingQuantity).toFixed(2));

        // Process Exit Order Fills
        for (const [orderId, exitInfo] of activeExitOrders.entries()) {
          const fill = simResult.fills.find((f) => f.orderId === orderId);
          if (fill) {
            const fillQty = fill.quantity;
            const chunkDiff = isLong
              ? fill.price - activeLot.entryPrice
              : activeLot.entryPrice - fill.price;
            const grossPnl = Number((chunkDiff * fillQty).toFixed(2));
            const initialRiskPerUnit = Math.max(
              0.0001,
              Math.abs(activeLot.entryPrice - activeLot.initialStopLoss),
            );
            const chunkR = Number((chunkDiff / initialRiskPerUnit).toFixed(2));

            activeLot.realizedPnl = Number((activeLot.realizedPnl + grossPnl).toFixed(2));
            activeLot.remainingQuantity = Number(
              Math.max(0, activeLot.remainingQuantity - fillQty).toFixed(4),
            );
            cumulativeFees += fill.fee;
            cumulativeSlippage += fill.slippage;

            activeLot.partialFills.push({
              fillId: fill.fillId,
              targetType: exitInfo.targetType as any,
              timestamp: fill.timestamp,
              price: fill.price,
              quantity: fillQty,
              remainingQuantity: activeLot.remainingQuantity,
              realizedPnl: grossPnl,
              realizedR: chunkR,
              fee: fill.fee,
              slippage: fill.slippage,
            });

            if (activeLot.remainingQuantity <= 0) {
              activeLot.status = 'CLOSED';
              activeLot.closedAt = fill.timestamp;
              activeLot.unrealizedPnl = 0;
            } else {
              activeLot.status = 'PARTIALLY_CLOSED';
              if (exitInfo.targetType === 'TP1' && partialPolicy.moveStopToBreakevenOnTp1) {
                activeLot.currentStopLoss = activeLot.entryPrice;
              } else if (exitInfo.targetType === 'TP2' && partialPolicy.trailStopOnTp2) {
                activeLot.currentStopLoss = activeLot.tp1;
              }
            }

            activeExitOrders.delete(orderId);
          }
        }

        // Check Exit Condition Triggers and Submit Exit Orders to ExecutionSimulator
        if (activeLot.status !== 'CLOSED' && activeExitOrders.size === 0) {
          const exitSide = isLong ? 'SELL' : 'BUY';
          const isStopHit = isLong ? low <= activeLot.currentStopLoss : high >= activeLot.currentStopLoss;
          const isTp3Hit = isLong ? high >= activeLot.tp3 : low <= activeLot.tp3;
          const isTp2Hit = isLong ? high >= activeLot.tp2 : low <= activeLot.tp2;
          const isTp1Hit = isLong ? high >= activeLot.tp1 : low <= activeLot.tp1;

          if (isStopHit) {
            const exitOrder = execSim.submitOrder({
              tradeId: activeLot.tradeId,
              symbol,
              side: exitSide,
              orderType: 'STOP',
              stopPrice: activeLot.currentStopLoss,
              quantity: activeLot.remainingQuantity,
              timestamp: candleTime,
            });
            activeExitOrders.set(exitOrder.orderId, {
              order: exitOrder,
              targetType:
                activeLot.currentStopLoss === activeLot.entryPrice
                  ? 'TRAILING_STOP'
                  : 'STOP_LOSS',
            });
          } else if (isTp3Hit) {
            const exitOrder = execSim.submitOrder({
              tradeId: activeLot.tradeId,
              symbol,
              side: exitSide,
              orderType: 'LIMIT',
              price: activeLot.tp3,
              quantity: activeLot.remainingQuantity,
              timestamp: candleTime,
            });
            activeExitOrders.set(exitOrder.orderId, { order: exitOrder, targetType: 'TP3' });
          } else if (isTp2Hit && !activeLot.partialFills.some((f) => f.targetType === 'TP2')) {
            const targetRatio = partialPolicy.tp3Ratio > 0 ? partialPolicy.tp2Ratio : 1.0;
            const scaleQty = Math.max(
              1,
              Math.min(
                activeLot.remainingQuantity,
                Math.round(activeLot.initialQuantity * targetRatio),
              ),
            );
            const exitOrder = execSim.submitOrder({
              tradeId: activeLot.tradeId,
              symbol,
              side: exitSide,
              orderType: 'LIMIT',
              price: activeLot.tp2,
              quantity: scaleQty,
              timestamp: candleTime,
            });
            activeExitOrders.set(exitOrder.orderId, { order: exitOrder, targetType: 'TP2' });
          } else if (isTp1Hit && !activeLot.partialFills.some((f) => f.targetType === 'TP1')) {
            const scaleQty = Math.max(
              1,
              Math.min(
                activeLot.remainingQuantity,
                Math.round(activeLot.initialQuantity * partialPolicy.tp1Ratio),
              ),
            );
            const exitOrder = execSim.submitOrder({
              tradeId: activeLot.tradeId,
              symbol,
              side: exitSide,
              orderType: 'LIMIT',
              price: activeLot.tp1,
              quantity: scaleQty,
              timestamp: candleTime,
            });
            activeExitOrders.set(exitOrder.orderId, { order: exitOrder, targetType: 'TP1' });
          }
        }

        // Record Closed Trade Record
        if (activeLot.status === 'CLOSED') {
          const totalFees = activeLot.partialFills.reduce((sum, f) => sum + f.fee, 0);
          const totalSlippageCost = activeLot.partialFills.reduce((sum, f) => sum + f.slippage, 0);
          const grossPnl = activeLot.realizedPnl;
          const netPnl = Number((grossPnl - totalFees).toFixed(2));

          currentCash = Number((currentCash + netPnl).toFixed(2));
          currentEquity = currentCash;

          const lastFill = activeLot.partialFills[activeLot.partialFills.length - 1];
          const firstFill = activeLot.partialFills[0];

          const initialRiskDist = Math.abs(activeLot.entryPrice - activeLot.initialStopLoss);
          const tradeRecord: IBacktestTrade = {
            id: `tr_${trades.length + 1}`,
            direction: activeLot.direction,
            entryTime: new Date(activeLot.openedAt),
            entryPrice: activeLot.entryPrice,
            exitTime: new Date(activeLot.closedAt || candleTime),
            exitPrice: lastFill?.price || activeLot.entryPrice,
            stopLoss: activeLot.initialStopLoss,
            takeProfit: activeLot.tp2,
            positionSize: activeLot.initialQuantity,
            marginRequired: Number(
              ((activeLot.initialQuantity * activeLot.entryPrice) / 5).toFixed(2),
            ),
            riskAmount: Number((initialRiskDist * activeLot.initialQuantity).toFixed(2)),
            pnl: netPnl,
            pnlRMultiple: Number(
              (netPnl / Math.max(1, initialRiskDist * activeLot.initialQuantity)).toFixed(2),
            ),
            exitReason:
              lastFill?.targetType === 'STOP_LOSS' || lastFill?.targetType === 'TRAILING_STOP'
                ? SignalState.SL_HIT
                : SignalState.TP1_HIT,
            signalTimestamp: new Date(firstFill?.timestamp || activeLot.openedAt),
            orderCreatedAt: new Date(firstFill?.timestamp || activeLot.openedAt),
            orderSubmittedAt: new Date(firstFill?.timestamp || activeLot.openedAt),
            entryFillTimestamp: new Date(activeLot.openedAt),
            entryReferencePrice: activeLot.entryPrice,
            entryFillPrice: activeLot.entryPrice,
            entryFees: firstFill?.fee || 0,
            entrySlippage: firstFill?.slippage || 0,
            exitOrderTimestamp: new Date(lastFill?.timestamp || candleTime),
            exitFillTimestamp: new Date(lastFill?.timestamp || candleTime),
            exitFillPrice: lastFill?.price || activeLot.entryPrice,
            exitFees: totalFees - (firstFill?.fee || 0),
            exitSlippage: totalSlippageCost - (firstFill?.slippage || 0),
            grossPnL: grossPnl,
            netPnL: netPnl,
            realizedR: Number(
              (netPnl / Math.max(1, initialRiskDist * activeLot.initialQuantity)).toFixed(2),
            ),
            fillModel: String(fillModel),
            ambiguityMode: String(ambiguityMode),
          };

          trades.push(tradeRecord);
          positionLots.push(activeLot);

          activeLot = null;
          activeExitOrders.clear();
        }

        // Record Bar-by-bar Snapshot
        currentEquity = Number(
          (currentCash + (activeLot ? activeLot.realizedPnl + activeLot.unrealizedPnl : 0)).toFixed(
            2,
          ),
        );
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
          fees: cumulativeFees,
          slippage: cumulativeSlippage,
          drawdownPercent: ddPercent,
        });

        continue;
      }

      // 4. Scan for New Signal on Historical Bar i (Zero Lookahead via MarketDataRouter & explicit asOfTimestamp)
      if (!activeLot && !pendingEntryOrder) {
        const mtfData = router.getAvailableMarketDataAt(i);

        const signal = SignalGenerator.generateSignal({
          symbol,
          executionCandles: mtfData.executionSlice,
          executionTimeframe: timeframe,
          htf1Candles: mtfData.htf1Slice,
          htf1Timeframe: options.htf1Timeframe || '1h',
          htf2Candles: mtfData.htf2Slice,
          htf2Timeframe: options.htf2Timeframe || '4h',
          strategyMode,
          asOfTimestamp: new Date(mtfData.timestamp),
        });

        if (
          signal.direction !== Direction.NEUTRAL &&
          signal.score >= minScore &&
          signal.grade !== SignalGrade.NO_TRADE
        ) {
          pendingEntrySignal = signal;
          const isLong = signal.direction === Direction.BULLISH;

          // Fail-closed position sizing using reference decision price
          const sizing = PositionSizer.calculatePosition({
            accountBalance: currentEquity,
            riskPercentage: riskPercent,
            entryPrice: signal.entryZone.optimal,
            stopLoss: signal.stopLoss,
            lotSize,
          });

          if (sizing.isValid && sizing.roundedUnits > 0) {
            const side = isLong ? 'BUY' : 'SELL';
            const orderType = fillModel === FillModel.NEXT_BAR_MARKET ? 'MARKET' : 'LIMIT';
            pendingEntryOrder = execSim.submitOrder({
              tradeId: signal.id || `trade_${candleTime}`,
              symbol,
              side,
              orderType,
              price: signal.entryZone.optimal,
              quantity: sizing.roundedUnits,
              timestamp: mtfData.timestamp,
              referencePrice: signal.entryZone.optimal,
              maxRiskDrift: 0.25,
              signalTimestamp: mtfData.timestamp,
              ambiguityMode,
            });
          }
        }
      }

      // Record Snapshot for Flat Bar
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
        fees: cumulativeFees,
        slippage: cumulativeSlippage,
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
      id: `${runId}_res`,
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
