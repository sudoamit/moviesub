import {
  Direction,
  IBacktestTrade,
  ICandle,
  ISignalSetup,
  SignalGrade,
  SignalState,
  Timeframe,
  PositionSide,
  isLongPosition,
  hasInstrument,
  getAuthoritativeInstrument,
  PointInTimeCurrencyConverter,
  canonicalizeSpotSymbol,
  getAuthoritativeSpotInstrument,
  isSupportedSpotSymbol,
  SUPPORTED_SPOT_SYMBOLS,
  LEGACY_SPOT_ALIASES,
  FORBIDDEN_DERIVATIVE_INSTRUMENTS,
} from '@quant/shared';
import {
  SignalGenerator,
  CanonicalMLEngineV2,
  SnapshotBuilder,
  CANONICAL_FEATURE_NAMES_V2,
  CANONICAL_V2_DIMENSION,
} from '@quant/trading-engine';
import {
  PositionSizer,
  TradeLifecycleManager,
  DEFAULT_PARTIAL_EXIT_POLICY,
  PositionLot,
  IExecutionEvent,
  TradeAccountingEngine,
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

  private static submitRestingExitOrders(
    execSim: ExecutionSimulator,
    lot: PositionLot,
    symbol: string,
    policy = DEFAULT_PARTIAL_EXIT_POLICY,
    timestamp: number,
  ) {
    const isLong = isLongPosition(lot.direction || lot.entrySnapshot?.side);
    const exitSide = isLong ? 'SELL' : 'BUY';
    const posSide = isLong ? PositionSide.LONG : PositionSide.SHORT;
    const remainingQty = lot.remainingQuantity;

    if (remainingQty <= 0) return;

    const val = TradeLifecycleManager.validatePartialExitPolicy(policy);
    if (!val.isValid) {
      throw new Error(`Invalid partial exit policy: ${val.reason}`);
    }

    // 1. Resting Stop Loss Order (Protective Stop for open position)
    execSim.submitOrder({
      tradeId: lot.tradeId,
      symbol,
      side: exitSide,
      orderType: 'STOP',
      positionSide: posSide,
      stopPrice: lot.currentStopLoss,
      quantity: remainingQty,
      timestamp,
      exitTarget: lot.currentStopLoss === lot.entryPrice ? 'TRAILING_STOP' : 'SL',
    });

    // 2. Resting Target Limit Orders (TP1, TP2, TP3)
    const existingOrders = execSim.getTradeOrders(lot.tradeId);
    const hasAlreadyTp1 = existingOrders.some((o: any) => o.exitTarget === 'TP1');
    const hasAlreadyTp2 = existingOrders.some((o: any) => o.exitTarget === 'TP2');
    const hasAlreadyTp3 = existingOrders.some((o: any) => o.exitTarget === 'TP3');

    const tp1Qty = Math.round(lot.initialQuantity * policy.tp1Ratio);
    const tp2Qty =
      policy.tp3Ratio > 0
        ? Math.round(lot.initialQuantity * policy.tp2Ratio)
        : lot.initialQuantity - tp1Qty;
    const tp3Qty = policy.tp3Ratio > 0 ? lot.initialQuantity - (tp1Qty + tp2Qty) : 0;

    if (!hasAlreadyTp1 && tp1Qty > 0 && lot.tp1 > 0) {
      execSim.submitOrder({
        tradeId: lot.tradeId,
        symbol,
        side: exitSide,
        orderType: 'LIMIT',
        positionSide: posSide,
        price: lot.tp1,
        quantity: Math.min(remainingQty, tp1Qty),
        timestamp,
        exitTarget: 'TP1',
        referencePrice: lot.entryPrice,
      });
    }

    if (!hasAlreadyTp2 && tp2Qty > 0 && lot.tp2 > 0) {
      execSim.submitOrder({
        tradeId: lot.tradeId,
        symbol,
        side: exitSide,
        orderType: 'LIMIT',
        positionSide: posSide,
        price: lot.tp2,
        quantity: Math.min(remainingQty, tp2Qty),
        timestamp,
        exitTarget: 'TP2',
        referencePrice: lot.entryPrice,
      });
    }

    if (!hasAlreadyTp3 && tp3Qty > 0 && lot.tp3 > 0) {
      execSim.submitOrder({
        tradeId: lot.tradeId,
        symbol,
        side: exitSide,
        orderType: 'LIMIT',
        positionSide: posSide,
        price: lot.tp3,
        quantity: Math.min(remainingQty, tp3Qty),
        timestamp,
        exitTarget: 'TP3',
        referencePrice: lot.entryPrice,
      });
    }
  }

  /**
   * Simulates spot strategy historical execution candle-by-candle with zero look-ahead bias,
   * authoritative ExecutionSimulator order/fill pipeline, resting exit orders, gap handling,
   * fail-closed sizing, cash accounting, and bar-by-bar equity tracking.
   */
  static runSimulation(options: IBacktestOptions): IBacktestSimulationResult {
    const rawSymbol = (options.symbol || '').toUpperCase().trim();
    if (FORBIDDEN_DERIVATIVE_INSTRUMENTS.has(rawSymbol)) {
      throw new Error(
        `FORBIDDEN_DERIVATIVE_INSTRUMENT: Derivative instrument '${rawSymbol}' is strictly forbidden in spot trading architecture.`,
      );
    }
    const isSpotTrading =
      Boolean(options.isSpot) ||
      isSupportedSpotSymbol(rawSymbol) ||
      rawSymbol.endsWith('_SPOT') ||
      rawSymbol in LEGACY_SPOT_ALIASES ||
      (options as any).spotOnly === true;

    if (rawSymbol in LEGACY_SPOT_ALIASES) {
      throw new Error(
        `LEGACY_ALIAS_REJECTED: Symbol '${rawSymbol}' is a legacy alias. Spot strategy and backtest engine strictly require canonical symbol '${LEGACY_SPOT_ALIASES[rawSymbol as keyof typeof LEGACY_SPOT_ALIASES]}'.`,
      );
    }

    if (isSpotTrading && !isSupportedSpotSymbol(rawSymbol)) {
      throw new Error(
        `UNSUPPORTED_SPOT_INSTRUMENT: Symbol '${rawSymbol}' is not a supported spot instrument. Supported universe is strictly {NIFTY_SPOT, BANKNIFTY_SPOT, BTCUSDT_SPOT}.`,
      );
    }

    const symbol = isSpotTrading
      ? canonicalizeSpotSymbol(rawSymbol, { allowLegacyAliases: false })
      : options.symbol;

    // Data Provenance: Mock data provider strictly fails closed in research backtests
    if ((options as any).provenance === 'MOCK' || (options as any).isMockData) {
      throw new Error(
        'BACKTEST_DATA_PROVENANCE_INVALID: Backtests fail closed on mock market data providers. Real or authoritative fixture data required.',
      );
    }
    const timeframe =
      (options.timeframe as string) || (options.executionTimeframe as string) || Timeframe.M15;
    const initialCapital = options.initialCapital || 100000;
    const riskPercent =
      options.riskPerTradePercent ??
      (options.candidateArtifact?.riskConfig?.maxRiskPerTrade !== undefined
        ? (options.candidateArtifact.riskConfig.maxRiskPerTrade <= 1
            ? options.candidateArtifact.riskConfig.maxRiskPerTrade * 100
            : options.candidateArtifact.riskConfig.maxRiskPerTrade)
        : undefined) ??
      1.0;
    const minScore =
      options.minScore !== undefined
        ? options.minScore
        : options.experiences && options.experiences.length > 0
          ? 0
          : 65;
    const lotSize = options.lotSize || 1;
    const fillModel = options.fillModel || FillModel.NEXT_BAR_MARKET;
    const ambiguityMode = options.ambiguityMode || SameCandleAmbiguityMode.CONSERVATIVE;
    const partialPolicy = options.partialExitPolicy || DEFAULT_PARTIAL_EXIT_POLICY;
    const strategyMode = options.strategyMode || 'SMC';

    // Cryptographic Linkage Verification between Model and Candidate Scaler/Schema
    if (options.candidateArtifact?.modelArtifact) {
      const model = options.candidateArtifact.modelArtifact as any;
      if (
        model.featureSchemaHash &&
        options.candidateArtifact.featureSchemaHash &&
        model.featureSchemaHash !== options.candidateArtifact.featureSchemaHash
      ) {
        throw new Error(
          `INCOMPATIBLE_MODEL_SCHEMA_HASH: Model schema hash ${model.featureSchemaHash} does not match artifact ${options.candidateArtifact.featureSchemaHash}`,
        );
      }
      if (
        model.scalerHash &&
        options.candidateArtifact.scalerHash &&
        model.scalerHash !== options.candidateArtifact.scalerHash
      ) {
        throw new Error(
          `INCOMPATIBLE_MODEL_SCALER_HASH: Model scaler hash ${model.scalerHash} does not match artifact scaler hash ${options.candidateArtifact.scalerHash}`,
        );
      }
    }

    // 0. Temporal filter on candles if asOfTimestamp is provided
    let inputCandles = options.candles || [];
    const tfMs = this.getDurationMs(timeframe);

    if (options.asOfTimestamp) {
      const cutoffMs =
        options.asOfTimestamp instanceof Date
          ? options.asOfTimestamp.getTime()
          : new Date(options.asOfTimestamp).getTime();
      inputCandles = inputCandles.filter((c) => {
        const openMs =
          c.timestamp instanceof Date ? c.timestamp.getTime() : new Date(c.timestamp).getTime();
        return openMs + tfMs <= cutoffMs;
      });
    }

    const router = new MarketDataRouter({
      executionTimeframe: timeframe,
      htf1Timeframe: options.htf1Timeframe || '1h',
      htf2Timeframe: options.htf2Timeframe || '4h',
      executionCandles: inputCandles,
      htf1Candles: options.htf1Candles,
      htf2Candles: options.htf2Candles,
    });

    const executionCandles = router.getExecutionCandles();
    let currentCash = initialCapital;
    let currentEquity = initialCapital;

    const runId =
      options.runId || `bt_${symbol}_${timeframe}_${options.strategyMode || 'SMC'}`;

    const latencyConfig = options.latencyConfig || { submissionLatencyMs: 15, processingLatencyMs: 5 };
    let slippageConfig = options.slippageConfig;
    if (!slippageConfig && (options.slippageBps !== undefined || options.slippagePercent !== undefined)) {
      const baseSlippageBps = options.slippageBps ?? ((options.slippagePercent || 0) * 100);
      slippageConfig = {
        baseSlippageBps,
        volatilityMultiplier: 1.5,
        impactMultiplier: 0.8,
        maxSlippageBps: Math.max(25.0, baseSlippageBps * 2),
      };
    }
    let feeConfig = options.feeConfig;
    if (!feeConfig && options.feeRate !== undefined) {
      feeConfig = {
        brokerageRateBps: options.feeRate * 10000,
      };
    }
    const execSim = new ExecutionSimulator(
      fillModel,
      ambiguityMode,
      latencyConfig,
      runId,
      slippageConfig,
      feeConfig,
      options.spreadConfig,
      options.costStressConfig,
    );
    if (isSpotTrading) {
      execSim.setSpotOnly(true);
    }

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

    const minimumCandles = options.minimumCandles !== undefined ? options.minimumCandles : 50;
    if (!executionCandles || executionCandles.length < minimumCandles) {
      const emptyMetrics = MetricsCalculator.calculateMetrics([], initialCapital, equityCurve);
      return {
        runId,
        id: `${runId}_res`,
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

    let cumulativeFees = 0;
    let cumulativeSlippage = 0;
    const warmupBars = options.warmupBars !== undefined ? options.warmupBars : 40;

    for (let i = warmupBars; i < executionCandles.length; i++) {
      const currentCandle = executionCandles[i];
      const nextCandle = i < executionCandles.length - 1 ? executionCandles[i + 1] : undefined;
      const candleTime =
        currentCandle.timestamp instanceof Date
          ? currentCandle.timestamp.getTime()
          : new Date(currentCandle.timestamp).getTime();

      // 1. Process Candle through Authoritative ExecutionSimulator
      const subBarCandles = options.lowerTfCandles;
      const simResult = execSim.processCandle(currentCandle, nextCandle, subBarCandles, tfMs);
      executionEvents.push(...simResult.events);

      // 2. Handle Entry Order Fill
      if (pendingEntryOrder && pendingEntryOrder.status === 'FILLED') {
        const fill = simResult.fills.find((f) => f.orderId === pendingEntryOrder!.orderId);
        if (fill && pendingEntrySignal) {
          if (isSpotTrading) {
            const spotInst = getAuthoritativeSpotInstrument(symbol);
            const cSize = spotInst.contractMultiplier;
            const qCurr = spotInst.quoteCurrency;
            let fxRate = 1.0;
            if (qCurr !== 'INR') {
              fxRate = PointInTimeCurrencyConverter.getInstance().getRate(qCurr, 'INR', fill.timestamp).fxRate;
            }
            const fillCostQuote = fill.price * fill.quantity * cSize;
            const fillCostINR = Number((fillCostQuote * fxRate).toFixed(2));
            const fillFeeINR = qCurr !== 'INR' ? Number((fill.fee * fxRate).toFixed(2)) : fill.fee;
            const totalRequiredCash = fillCostINR + fillFeeINR;

            if (currentCash < totalRequiredCash - 1e-4) {
              execSim.cancelOrder(pendingEntryOrder.orderId);
              pendingEntryOrder = null;
              pendingEntrySignal = null;
              continue;
            }

            currentCash = Number((currentCash - totalRequiredCash).toFixed(2));
            activeLot = TradeLifecycleManager.createPositionLot(
              pendingEntrySignal,
              fill.price,
              fill.quantity,
              fill.timestamp,
              pendingEntryOrder.orderId,
              fill.fee,
              fill.slippage,
              partialPolicy,
            );
            cumulativeFees += fillFeeINR;
            cumulativeSlippage += fill.slippage;

            this.submitRestingExitOrders(execSim, activeLot, symbol, partialPolicy, fill.timestamp);

            pendingEntryOrder = null;
            pendingEntrySignal = null;
          } else {
            activeLot = TradeLifecycleManager.createPositionLot(
              pendingEntrySignal,
              fill.price,
              fill.quantity,
              fill.timestamp,
              pendingEntryOrder.orderId,
              fill.fee,
              fill.slippage,
              partialPolicy,
            );
            cumulativeFees += fill.fee;
            cumulativeSlippage += fill.slippage;

            this.submitRestingExitOrders(execSim, activeLot, symbol, partialPolicy, fill.timestamp);

            pendingEntryOrder = null;
            pendingEntrySignal = null;
          }
        }
      } else if (pendingEntryOrder) {
        if (pendingEntryOrder.status === 'PENDING' || pendingEntryOrder.status === 'PARTIALLY_FILLED') {
          execSim.cancelOrder(pendingEntryOrder.orderId);
        }
        pendingEntryOrder = null;
        pendingEntrySignal = null;
      }

      // 3. Handle Active Position Lot Exits & Fills
      if (activeLot && activeLot.status !== 'CLOSED') {
        const isLong = isLongPosition(activeLot.direction || activeLot.entrySnapshot?.side);
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

        // Process All Exit Order Fills returned from ExecutionSimulator for active trade (excluding entry order fill)
        const tradeFills = simResult.fills.filter(
          (f) => f.tradeId === activeLot!.tradeId && f.exitTarget !== 'ENTRY',
        );
        for (const exitFill of tradeFills) {
          if (!activeLot || activeLot.status === 'CLOSED') break;

          if (isSpotTrading) {
            const spotInst = getAuthoritativeSpotInstrument(symbol);
            const cSize = spotInst.contractMultiplier;
            const qCurr = spotInst.quoteCurrency;
            let fxRate = 1.0;
            if (qCurr !== 'INR') {
              fxRate = PointInTimeCurrencyConverter.getInstance().getRate(qCurr, 'INR', exitFill.timestamp).fxRate;
            }
            const exitProceedsQuote = exitFill.price * exitFill.quantity * cSize;
            const exitProceedsINR = Number((exitProceedsQuote * fxRate).toFixed(2));
            const exitFeeINR = qCurr !== 'INR' ? Number((exitFill.fee * fxRate).toFixed(2)) : exitFill.fee;
            const netProceedsINR = exitProceedsINR - exitFeeINR;
            currentCash = Number((currentCash + netProceedsINR).toFixed(2));

            cumulativeFees += exitFeeINR;
            cumulativeSlippage += exitFill.slippage;
          } else {
            cumulativeFees += exitFill.fee;
            cumulativeSlippage += exitFill.slippage;
          }

          const filledOrder = execSim.getOrder(exitFill.orderId);
          const targetType =
            exitFill.exitTarget ||
            (filledOrder?.orderType === 'STOP'
              ? activeLot.currentStopLoss === activeLot.entryPrice
                ? 'TRAILING_STOP'
                : 'SL'
              : 'TP1');

          const exitResult = TradeLifecycleManager.processExitFill(
            activeLot,
            {
              ...exitFill,
              targetType,
            },
            partialPolicy,
            String(execSim.getExecutionModelConfig().fillModel),
            String(execSim.getExecutionModelConfig().ambiguityMode),
          );

          activeLot = exitResult.lot;

          if (exitResult.isBreakevenStopTriggered) {
            execSim.updateStopPrice(activeLot.tradeId, activeLot.entryPrice, 'TRAILING_STOP');
          }

          if (exitResult.isClosed) {
            execSim.cancelTradeOrders(activeLot.tradeId);
            if (exitResult.completedTrade) {
              const tradeRecord: IBacktestTrade = {
                ...exitResult.completedTrade,
                id: `${runId}_tr_${trades.length + 1}`,
                symbol,
                marginRequired: isSpotTrading ? 0 : exitResult.completedTrade.marginRequired,
                initialMarginRequired: isSpotTrading ? 0 : exitResult.completedTrade.initialMarginRequired,
                maintenanceMarginRequired: isSpotTrading ? 0 : exitResult.completedTrade.maintenanceMarginRequired,
                leverage: isSpotTrading ? 1 : exitResult.completedTrade.leverage,
                marginMode: isSpotTrading ? 'SPOT' : exitResult.completedTrade.marginMode,
              };
              trades.push(tradeRecord);
              positionLots.push(activeLot);

              if (!isSpotTrading) {
                const realizedNet = tradeRecord.netPnL ?? tradeRecord.pnl ?? 0;
                currentCash = Number((currentCash + realizedNet).toFixed(2));
                currentEquity = currentCash;
              }
            }
            activeLot = null;
            break;
          }
        }

        // Record Bar-by-bar Snapshot
        if (isSpotTrading) {
          let openPositionValueINR = 0;
          let activeLotExposureINR = 0;
          if (activeLot && activeLot.status !== 'CLOSED') {
            const spotInst = getAuthoritativeSpotInstrument(symbol);
            const cSize = spotInst.contractMultiplier;
            const qCurr = spotInst.quoteCurrency;
            let fxRate = 1.0;
            if (qCurr !== 'INR') {
              fxRate = PointInTimeCurrencyConverter.getInstance().getRate(qCurr, 'INR', candleTime).fxRate;
            }
            openPositionValueINR = Number((activeLot.remainingQuantity * currentCandle.close * cSize * fxRate).toFixed(2));
            activeLotExposureINR = openPositionValueINR;
          }

          currentEquity = Number((currentCash + openPositionValueINR).toFixed(2));
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
            realizedPnL: Number((currentCash - initialCapital).toFixed(2)),
            unrealizedPnL: openPositionValueINR > 0 ? Number((currentEquity - currentCash).toFixed(2)) : 0,
            equity: currentEquity,
            marginUsed: 0,
            availableMargin: currentCash,
            grossExposure: activeLotExposureINR,
            netExposure: activeLotExposureINR,
            fees: cumulativeFees,
            slippage: cumulativeSlippage,
            drawdownPercent: ddPercent,
          });
        } else {
          currentEquity = Number(
            (currentCash + (activeLot ? activeLot.realizedPnl + activeLot.unrealizedPnl : 0)).toFixed(2),
          );
          const peak = Math.max(...equityCurve.map((e) => e.equity), initialCapital);
          const ddPercent = peak > 0 ? Number((((peak - currentEquity) / peak) * 100).toFixed(2)) : 0;

          equityCurve.push({
            timestamp: new Date(candleTime),
            equity: currentEquity,
            drawdownPercent: ddPercent,
          });

          let activeLotMargin = 0;
          let activeLotExposureINR = 0;
          if (activeLot) {
            const lotSym = activeLot.symbol;
            const inst = hasInstrument(lotSym) ? getAuthoritativeInstrument(lotSym) : undefined;
            const cSize = inst?.contractSize ?? 1;
            const qCurr = inst?.quoteCurrency || (inst?.currency as any) || 'INR';
            let fx = 1.0;
            if (qCurr !== 'INR') {
              fx = PointInTimeCurrencyConverter.getInstance().getRate(qCurr, 'INR', candleTime).fxRate;
            }
            const notionalCalc = TradeAccountingEngine.calculateNotional(activeLot.remainingQuantity, activeLot.entryPrice, cSize, fx);
            activeLotExposureINR = notionalCalc.notionalAccount;
            const lev = inst?.defaultLeverage ?? 1;
            const mMode = inst?.marginMode ?? (lev > 1 ? 'ISOLATED' : 'SPOT');
            const mCalc = TradeAccountingEngine.calculateMargin(notionalCalc.notionalAccount, lev, mMode, inst?.initialMarginRate, inst?.maintenanceMarginRate);
            activeLotMargin = mCalc.initialMarginRequired;
          }

          equitySnapshots.push({
            timestamp: new Date(candleTime),
            cash: currentCash,
            realizedPnL: activeLot ? activeLot.realizedPnl : 0,
            unrealizedPnL: activeLot ? activeLot.unrealizedPnl : 0,
            equity: currentEquity,
            marginUsed: activeLotMargin,
            availableMargin: Math.max(0, currentEquity - activeLotMargin),
            grossExposure: activeLotExposureINR,
            netExposure: activeLot ? (isLong ? 1 : -1) * activeLotExposureINR : 0,
            fees: cumulativeFees,
            slippage: cumulativeSlippage,
            drawdownPercent: ddPercent,
          });
        }

        continue;
      }

      // 4. Scan for New Signal on Historical Bar i (Zero Lookahead via MarketDataRouter & explicit asOfTimestamp)
      if (!activeLot && !pendingEntryOrder) {
        const mtfData = router.getAvailableMarketDataAt(i);

        // Authoritative signal generation directly from market data using candidate strategy configuration
        const effectiveStrategyMode =
          (options.candidateArtifact?.strategyConfig?.strategyMode || options.strategyMode || strategyMode) as any;
        const scoringWeights =
          options.scoringWeights || options.candidateArtifact?.strategyConfig?.scoringWeights;
        const strategyConfig =
          options.strategyConfig ||
          options.candidateArtifact?.strategyConfig ||
          (options.experiences && options.experiences.length > 0 && options.experiences[0]?.execution?.entryPrice
            ? {
                deterministicSignals: options.experiences
                  .filter((e) => e.execution?.entryPrice)
                  .map((e) => ({
                    id: e.id,
                    direction: e.decision?.action === 'SELL' ? 'BEARISH' : 'BULLISH',
                    score: e.decision?.score ?? 80,
                    entryPrice: e.execution?.entryPrice,
                    stopLoss: e.risk?.stopLoss,
                    tp1: e.risk?.target1,
                    tp2: e.risk?.target2,
                    tp3: e.risk?.target3,
                    reasons: [...(e.reasons || []), ...(e.failureReasons || [])],
                    marketContext: e.marketContext,
                    features: (e as any).features,
                    marketState: e.marketState,
                    prediction: e.prediction,
                    timestamp: e.timestamp,
                  })),
              }
            : undefined);

        const signal = SignalGenerator.generateSignal({
          symbol,
          executionCandles: mtfData.executionSlice,
          executionTimeframe: timeframe,
          htf1Candles: mtfData.htf1Slice,
          htf1Timeframe: options.htf1Timeframe || '1h',
          htf2Candles: mtfData.htf2Slice,
          htf2Timeframe: options.htf2Timeframe || '4h',
          strategyMode: effectiveStrategyMode,
          asOfTimestamp: new Date(mtfData.timestamp),
          scoringWeights,
          strategyConfig,
          minimumCandles: options.minimumCandles,
        });

        const effectiveMinScore =
          options.candidateArtifact?.executionConfig?.minMtfScore ?? options.minScore ?? minScore;
        const effectiveStopLossMultiplier =
          options.candidateArtifact?.riskConfig?.stopLossAtrMultiplier ??
          options.candidateArtifact?.executionConfig?.stopLossAtrMultiplier ??
          options.stopLossAtrMultiplier;
        const effectiveSizingMultiplier =
          options.candidateArtifact?.executionConfig?.sizingMultiplier ?? options.sizingMultiplier;
        const effectiveHighVolMultiplier =
          options.candidateArtifact?.executionConfig?.highVolatilitySizingMultiplier ??
          options.highVolatilitySizingMultiplier;
        const effectiveConditionRules =
          options.candidateArtifact?.executionConfig?.conditionRules ?? options.conditionRules;
        const effectiveFilterRegime =
          options.candidateArtifact?.executionConfig?.filterRegime ?? options.filterRegime;
        const effectiveRegimeMode =
          options.candidateArtifact?.executionConfig?.regimeMode ?? options.regimeMode;
        const effectiveMinProbability =
          options.candidateArtifact?.executionConfig?.minProbability ?? options.minProbability;

        const isSignalDirectionValid = isSpotTrading
          ? signal &&
            (signal.direction === Direction.BULLISH ||
              (signal.direction as any) === 'LONG' ||
              (signal.direction as any) === 'BUY')
          : signal && signal.direction !== Direction.NEUTRAL;

        if (
          signal &&
          isSignalDirectionValid &&
          signal.score >= effectiveMinScore &&
          signal.grade !== SignalGrade.NO_TRADE
        ) {
          let skip = false;

          // Condition rules filtering
          if (effectiveConditionRules && effectiveConditionRules.length > 0) {
            if (effectiveConditionRules.some((r: any) => signal.reasons?.includes(r))) {
              skip = true;
            }
          }

          // Regime filtering (INCLUDE_REGIME / EXCLUDE_REGIME)
          if (effectiveFilterRegime) {
            const currentRegime =
              (signal as any).marketContext?.regime ||
              (mtfData.currentCandle as any)?.regime ||
              (mtfData.currentCandle as any)?.marketContext?.regime;
            if (effectiveRegimeMode === 'INCLUDE' && currentRegime !== effectiveFilterRegime) {
              skip = true;
            } else if (effectiveRegimeMode === 'EXCLUDE' && currentRegime === effectiveFilterRegime) {
              skip = true;
            }
          }

          // Model scoring & filtering if candidate model artifact provided
          const model = options.modelArtifact || options.candidateArtifact?.modelArtifact;
          let modelProb: number | undefined;
          if (model) {
            const scalerParams =
              (model as any).scalerArtifact?.scalerParameters ||
              options.candidateArtifact?.scalerArtifact?.scalerParameters ||
              (options as any).scalerArtifact?.scalerParameters;

            let modelScore: number | undefined;
            const modelInput = {
              signal,
              candle: currentCandle,
              timestamp: candleTime,
            };

            if (typeof (model as any).score === 'function') {
              modelScore = (model as any).score(modelInput);
            } else if (Array.isArray((model as any).weights) && typeof (model as any).bias === 'number') {
              // Extract the REAL 28-dimensional canonical feature vector
              let featureVector: number[] | undefined;

              // 1. Check if signal contains explicit feature vector/map (e.g. from deterministic signal fixture)
              const candidateFeatures =
                (signal as any).features ||
                (signal as any).quantSnapshot?.features ||
                (signal as any).marketState?.quant ||
                (signal as any).marketState?.features;

              if (candidateFeatures) {
                if (Array.isArray(candidateFeatures)) {
                  if (
                    candidateFeatures.length !== CANONICAL_V2_DIMENSION ||
                    candidateFeatures.some((v) => typeof v !== 'number' || isNaN(v))
                  ) {
                    throw new Error(
                      `MISSING_REQUIRED_MODEL_FEATURE: Feature vector dimension must be ${CANONICAL_V2_DIMENSION} with valid numeric values`,
                    );
                  }
                  featureVector = candidateFeatures;
                } else if (typeof candidateFeatures === 'object') {
                  for (const name of CANONICAL_FEATURE_NAMES_V2) {
                    if (typeof candidateFeatures[name] !== 'number' || isNaN(candidateFeatures[name])) {
                      throw new Error(`MISSING_REQUIRED_MODEL_FEATURE: Required feature '${name}' is missing or invalid`);
                    }
                  }
                  featureVector = CANONICAL_FEATURE_NAMES_V2.map((name) => candidateFeatures[name]);
                }
              } else if ((signal as any).quantSnapshot) {
                // 2. Extract canonical features directly from the live signal's quantSnapshot
                const feats = CanonicalMLEngineV2.extractFeatures((signal as any).quantSnapshot);
                featureVector = CanonicalMLEngineV2.toArray(feats);
              } else if (mtfData.executionSlice.length >= 20) {
                // 3. Build live snapshot directly from continuous market data
                try {
                  const snap = SnapshotBuilder.buildSnapshot({
                    symbol,
                    executionCandles: mtfData.executionSlice,
                    executionTimeframe: timeframe,
                    htf1Candles: mtfData.htf1Slice,
                    htf1Timeframe: options.htf1Timeframe,
                    htf2Candles: mtfData.htf2Slice,
                    htf2Timeframe: options.htf2Timeframe,
                    asOfTimestamp: new Date(mtfData.timestamp),
                  });
                  const feats = CanonicalMLEngineV2.extractFeatures(snap);
                  featureVector = CanonicalMLEngineV2.toArray(feats);
                } catch {
                  featureVector = undefined;
                }
              }

              if (!featureVector || featureVector.length !== CANONICAL_V2_DIMENSION || featureVector.some((v) => typeof v !== 'number' || isNaN(v))) {
                throw new Error(
                  `MISSING_REQUIRED_MODEL_FEATURE: Required ${CANONICAL_V2_DIMENSION}-dimensional canonical feature vector is missing or incomplete for model execution`,
                );
              }

              // Evaluate against actual experience/market feature vector using scalerArtifact if present
              let z = (model as any).bias;
              for (let j = 0; j < (model as any).weights.length; j++) {
                const featName = CANONICAL_FEATURE_NAMES_V2[j];
                const rawFeatVal = featureVector[j];
                const scaledVal =
                  scalerParams && featName && scalerParams[featName]
                    ? scalerParams[featName].std < 1e-5
                      ? 0
                      : (rawFeatVal - scalerParams[featName].mean) / scalerParams[featName].std
                    : rawFeatVal;
                z += (model as any).weights[j] * scaledVal;
              }
              const prob = 1.0 / (1.0 + Math.exp(-Math.max(-15, Math.min(15, z))));
              modelProb = prob;
              modelScore = Math.round(prob * 100);
            }

            if (typeof (model as any).predict === 'function') {
              const pred = (model as any).predict(modelInput);
              if (pred && typeof pred.score === 'number') {
                modelScore = pred.score;
              }
              if (pred && typeof pred.probability === 'number') {
                modelProb = pred.probability;
              }
            }

            const requiredMinScore =
              effectiveMinProbability !== undefined
                ? (effectiveMinProbability > 1 ? effectiveMinProbability : effectiveMinProbability * 100)
                : (effectiveMinScore ?? minScore);

            if (typeof modelScore === 'number' && modelScore < requiredMinScore) {
              skip = true;
            }
          }

          // Universal minProbability enforcement across model predictions and signal probability
          if (effectiveMinProbability !== undefined) {
            const minProbThreshold =
              effectiveMinProbability > 1 ? effectiveMinProbability / 100.0 : effectiveMinProbability;
            const signalProb =
              modelProb ??
              (signal as any).mlProbability ??
              (signal as any).quantSnapshot?.ml?.probabilityWin ??
              (signal as any).prediction?.probabilityWin ??
              (signal as any).probability;

            if (typeof signalProb === 'number' && signalProb < minProbThreshold) {
              skip = true;
            }
          }

          if (!skip) {
            // Apply candidate stop loss multiplier if configured
            if (effectiveStopLossMultiplier && effectiveStopLossMultiplier !== 1.0) {
              const baseStopDist = Math.abs(signal.entryZone.optimal - signal.stopLoss);
              const newStopDist = baseStopDist * effectiveStopLossMultiplier;
              signal.stopLoss =
                signal.direction === Direction.BULLISH
                  ? signal.entryZone.optimal - newStopDist
                  : signal.entryZone.optimal + newStopDist;
            }

            pendingEntrySignal = signal;
            const isLong =
              signal.direction === Direction.BULLISH ||
              (signal.direction as any) === 'LONG' ||
              (signal.direction as any) === 'BUY';
            const isNextBarFill = String(fillModel) === 'NEXT_BAR_MARKET' || String(fillModel) === 'NEXT_BAR_OPEN';
            const decisionPrice =
              isNextBarFill
                ? currentCandle.close
                : signal.entryZone.optimal;

            if (isSpotTrading) {
              // Fail-closed spot position sizing based strictly on available cash and risk
              const spotSizing = PositionSizer.calculateSpotPosition({
                availableCash: currentCash,
                equity: currentEquity,
                riskPercentage: riskPercent,
                entryPrice: decisionPrice,
                stopLoss: signal.stopLoss,
                symbol,
                timestamp: candleTime,
              });

              const spotInst = getAuthoritativeSpotInstrument(symbol);
              let finalQuantity = spotSizing.roundedQuantity;
              const effLot = spotInst.lotSize || 1;
              const effPrec = typeof spotInst.quantityPrecision === 'number' ? spotInst.quantityPrecision : 4;

              if (effectiveSizingMultiplier && effectiveSizingMultiplier > 0) {
                const rawScaled = finalQuantity * effectiveSizingMultiplier;
                finalQuantity = effLot < 1
                  ? Number((Math.floor((rawScaled + 1e-9) / effLot) * effLot).toFixed(effPrec))
                  : Math.max(effLot, Math.round(rawScaled));
              }
              if (effectiveHighVolMultiplier && effectiveHighVolMultiplier > 0) {
                const isHighVol =
                  (signal as any)?.marketContext?.regime === 'HIGH_VOLATILITY' ||
                  (mtfData.currentCandle as any)?.regime === 'HIGH_VOLATILITY';
                if (isHighVol) {
                  const rawScaled = finalQuantity * effectiveHighVolMultiplier;
                  finalQuantity = effLot < 1
                    ? Number((Math.floor((rawScaled + 1e-9) / effLot) * effLot).toFixed(effPrec))
                    : Math.max(effLot, Math.round(rawScaled));
                }
              }

              // Spot Invariant: Final notional must never exceed available cash (with buffer for fees and slippage)
              let fxRate = 1.0;
              if (spotInst.quoteCurrency !== 'INR') {
                fxRate = PointInTimeCurrencyConverter.getInstance().getRate(spotInst.quoteCurrency, 'INR', candleTime).fxRate;
              }
              const costStressMultiplier =
                options.costStressConfig?.mode === 'MULTIPLIER' && typeof options.costStressConfig.multiplier === 'number'
                  ? options.costStressConfig.multiplier
                  : 1.0;
              const feeBufferRatio = Math.min(0.10, 0.005 * costStressMultiplier + 0.015);
              const maxSpendableCash = currentCash * (1 - feeBufferRatio);
              const unitPriceINR = decisionPrice * spotInst.contractMultiplier * fxRate;
              if (finalQuantity * unitPriceINR > maxSpendableCash) {
                finalQuantity = Math.floor(maxSpendableCash / (unitPriceINR * spotInst.lotSize)) * spotInst.lotSize;
                finalQuantity = Number(finalQuantity.toFixed(spotInst.quantityPrecision));
              }

              if (spotSizing.isValid && finalQuantity >= spotInst.minimumQuantity) {
                const orderType = isNextBarFill ? 'MARKET' : 'LIMIT';
                const costStressMultiplier =
                  options.costStressConfig?.mode === 'MULTIPLIER' && typeof options.costStressConfig.multiplier === 'number'
                    ? options.costStressConfig.multiplier
                    : 1.0;
                const effectiveMaxRiskDrift = 0.25 * Math.max(1.0, costStressMultiplier);

                pendingEntryOrder = execSim.submitOrder({
                  tradeId: signal.id || `trade_${candleTime}`,
                  symbol,
                  side: 'BUY',
                  orderType,
                  positionSide: PositionSide.LONG,
                  price: decisionPrice,
                  quantity: finalQuantity,
                  timestamp: candleTime,
                  referencePrice: decisionPrice,
                  stopLoss: signal.stopLoss,
                  maxRiskDrift: effectiveMaxRiskDrift,
                  signalTimestamp: candleTime,
                  ambiguityMode,
                  exitTarget: 'ENTRY',
                });
              }
            } else {
              // Legacy position sizing
              const sizing = PositionSizer.calculatePosition({
                accountBalance: currentEquity,
                riskPercentage: riskPercent,
                entryPrice: decisionPrice,
                stopLoss: signal.stopLoss,
                lotSize,
              });

              let finalQuantity = sizing.roundedUnits;
              if (effectiveSizingMultiplier && effectiveSizingMultiplier > 0) {
                finalQuantity = Math.max(lotSize, Math.round((finalQuantity * effectiveSizingMultiplier) / lotSize) * lotSize);
              }
              if (effectiveHighVolMultiplier && effectiveHighVolMultiplier > 0) {
                const isHighVol =
                  (signal as any)?.marketContext?.regime === 'HIGH_VOLATILITY' ||
                  (mtfData.currentCandle as any)?.regime === 'HIGH_VOLATILITY';
                if (isHighVol) {
                  finalQuantity = Math.max(lotSize, Math.round((finalQuantity * effectiveHighVolMultiplier) / lotSize) * lotSize);
                }
              }

              if (sizing.isValid && finalQuantity > 0) {
                const side = isLong ? 'BUY' : 'SELL';
                const orderType = isNextBarFill ? 'MARKET' : 'LIMIT';
                const costStressMultiplier =
                  options.costStressConfig?.mode === 'MULTIPLIER' && typeof options.costStressConfig.multiplier === 'number'
                    ? options.costStressConfig.multiplier
                    : 1.0;
                const effectiveMaxRiskDrift = 0.25 * Math.max(1.0, costStressMultiplier);

                pendingEntryOrder = execSim.submitOrder({
                  tradeId: signal.id || `trade_${candleTime}`,
                  symbol,
                  side,
                  orderType,
                  positionSide: isLong ? PositionSide.LONG : PositionSide.SHORT,
                  price: decisionPrice,
                  quantity: finalQuantity,
                  timestamp: candleTime,
                  referencePrice: decisionPrice,
                  stopLoss: signal.stopLoss,
                  maxRiskDrift: effectiveMaxRiskDrift,
                  signalTimestamp: candleTime,
                  ambiguityMode,
                  exitTarget: 'ENTRY',
                });
              }
            }
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
        realizedPnL: isSpotTrading ? Number((currentCash - initialCapital).toFixed(2)) : 0,
        unrealizedPnL: 0,
        equity: currentEquity,
        marginUsed: 0,
        availableMargin: isSpotTrading ? currentCash : currentEquity,
        grossExposure: 0,
        netExposure: 0,
        fees: cumulativeFees,
        slippage: cumulativeSlippage,
        drawdownPercent: ddPercent,
      });
    }

    // 5. Close any remaining open position lot at end-of-data using final candle's close
    if (activeLot && activeLot.status !== 'CLOSED' && executionCandles.length > 0) {
      const finalCandle = executionCandles[executionCandles.length - 1];
      const finalClose = finalCandle.close;
      const finalTime =
        finalCandle.timestamp instanceof Date
          ? finalCandle.timestamp.getTime()
          : new Date(finalCandle.timestamp).getTime();
      const isLong =
        activeLot.direction === Direction.BULLISH ||
        (activeLot.direction as any) === 'LONG' ||
        (activeLot.direction as any) === 'BUY';
      const chunkDiff = isLong
        ? finalClose - activeLot.entryPrice
        : activeLot.entryPrice - finalClose;
      const grossPnl = Number((chunkDiff * activeLot.remainingQuantity).toFixed(2));
      const initialRiskDist = Math.max(
        0.0001,
        Math.abs(activeLot.entryPrice - activeLot.initialStopLoss),
      );
      const chunkR = Number((chunkDiff / initialRiskDist).toFixed(2));

      activeLot.realizedPnl = Number((activeLot.realizedPnl + grossPnl).toFixed(2));
      activeLot.partialFills.push({
        fillId: `${runId}_fill_eod`,
        targetType: 'MARKET' as any,
        timestamp: finalTime,
        price: finalClose,
        quantity: activeLot.remainingQuantity,
        remainingQuantity: 0,
        realizedPnl: grossPnl,
        realizedR: chunkR,
        fee: 0,
        slippage: 0,
      });

      activeLot.remainingQuantity = 0;
      activeLot.status = 'CLOSED';
      activeLot.closedAt = finalTime;
      execSim.cancelTradeOrders(activeLot.tradeId);

      const totalFees = activeLot.partialFills.reduce((sum, f) => sum + f.fee, 0);
      const netPnl = Number((activeLot.realizedPnl - totalFees).toFixed(2));
      const lastFill = activeLot.partialFills[activeLot.partialFills.length - 1];
      const firstFill = activeLot.partialFills[0];

      let tradeRecord: IBacktestTrade;

      if (isSpotTrading) {
        const spotInst = getAuthoritativeSpotInstrument(symbol);
        const termContractSize = spotInst.contractMultiplier;
        const termLotSize = spotInst.lotSize;
        const termQuoteCurrency = spotInst.quoteCurrency;
        const termAccountCurrency = 'INR';
        let termFxRate = 1.0;
        let termFxTimestamp = activeLot.openedAt;
        let termFxPair = `${termQuoteCurrency}/${termAccountCurrency}`;
        if (termQuoteCurrency !== termAccountCurrency) {
          const fxRes = PointInTimeCurrencyConverter.getInstance().getRate(termQuoteCurrency, termAccountCurrency, activeLot.openedAt);
          termFxRate = fxRes.fxRate;
          termFxTimestamp = fxRes.fxTimestamp;
          termFxPair = fxRes.fxPair;
        }
        const termNotional = TradeAccountingEngine.calculateNotional(activeLot.initialQuantity, activeLot.entryPrice, termContractSize, termFxRate);
        const termRisk = TradeAccountingEngine.calculateStopRisk(activeLot.entryPrice, activeLot.initialStopLoss, activeLot.initialQuantity, termContractSize, termFxRate);

        tradeRecord = {
          id: `${runId}_tr_${trades.length + 1}`,
          direction: activeLot.direction,
          entryTime: new Date(activeLot.openedAt),
          entryPrice: activeLot.entryPrice,
          exitTime: new Date(finalTime),
          exitPrice: finalClose,
          stopLoss: activeLot.initialStopLoss,
          takeProfit: activeLot.tp2,
          positionSize: activeLot.initialQuantity,
          marginRequired: 0,
          initialMarginRequired: 0,
          maintenanceMarginRequired: 0,
          positionNotionalQuote: termNotional.notionalQuote,
          positionNotionalAccount: termNotional.notionalAccount,
          accountCurrency: termAccountCurrency,
          quoteCurrency: termQuoteCurrency,
          fxPair: termFxPair,
          fxRate: termFxRate,
          fxTimestamp: termFxTimestamp,
          contractSize: termContractSize,
          lotSize: termLotSize,
          leverage: 1,
          marginMode: 'SPOT',
          riskAmount: termRisk,
          pnl: netPnl,
          pnlRMultiple: Number((netPnl / Math.max(0.0001, initialRiskDist * activeLot.initialQuantity * termContractSize)).toFixed(4)),
          exitReason: (lastFill?.targetType as any) || SignalState.TP1_HIT,
          signalTimestamp: new Date(activeLot.entrySnapshot?.signalTimestamp || activeLot.openedAt),
          orderCreatedAt: new Date(activeLot.entrySnapshot?.orderCreatedAt || activeLot.openedAt),
          orderSubmittedAt: new Date(activeLot.entrySnapshot?.orderSubmittedAt || activeLot.openedAt),
          entryFillTimestamp: new Date(activeLot.entrySnapshot?.executionTimestamp || activeLot.openedAt),
          entryReferencePrice: activeLot.entrySnapshot?.referencePrice || activeLot.entryPrice,
          entryFillPrice: activeLot.entrySnapshot?.entryPrice || activeLot.entryPrice,
          entryFees: activeLot.entrySnapshot?.fee ?? (firstFill?.fee || 0),
          entrySlippage: activeLot.entrySnapshot?.slippage ?? (firstFill?.slippage || 0),
          exitOrderTimestamp: new Date(finalTime),
          exitOrderCreatedAt: new Date(finalTime),
          exitOrderSubmittedAt: new Date(finalTime),
          exitTriggerTimestamp: new Date(finalTime),
          exitFillTimestamp: new Date(finalTime),
          exitFillPrice: finalClose,
          exitFees: totalFees - (firstFill?.fee || 0),
          exitSlippage: activeLot.partialFills.reduce((sum, fill) => sum + fill.slippage, 0) - (firstFill?.slippage || 0),
          grossPnL: activeLot.realizedPnl,
          netPnL: netPnl,
          realizedR: Number((netPnl / Math.max(1, initialRiskDist * activeLot.initialQuantity)).toFixed(4)),
          fillModel: String(fillModel),
          ambiguityMode: String(ambiguityMode),
          entrySnapshot: activeLot.entrySnapshot,
        };

        const finalProceedsQuote = finalClose * activeLot.remainingQuantity * termContractSize;
        const finalProceedsINR = Number((finalProceedsQuote * termFxRate).toFixed(2));
        const finalExitFeesQuote = totalFees - (firstFill?.fee || 0);
        const finalExitFeesINR = termQuoteCurrency !== 'INR' ? Number((finalExitFeesQuote * termFxRate).toFixed(2)) : finalExitFeesQuote;
        currentCash = Number((currentCash + finalProceedsINR - finalExitFeesINR).toFixed(2));
        currentEquity = currentCash;
      } else {
        const terminalInst = hasInstrument(activeLot.symbol) ? getAuthoritativeInstrument(activeLot.symbol) : undefined;
        const termContractSize = terminalInst?.contractSize ?? 1;
        const termLotSize = terminalInst?.lotSize ?? 1;
        const termQuoteCurrency = terminalInst?.quoteCurrency || (terminalInst?.currency as any) || 'INR';
        const termAccountCurrency = 'INR';
        let termFxRate = 1.0;
        let termFxTimestamp = activeLot.openedAt;
        let termFxPair = `${termQuoteCurrency}/${termAccountCurrency}`;
        if (termQuoteCurrency !== termAccountCurrency) {
          const fxRes = PointInTimeCurrencyConverter.getInstance().getRate(termQuoteCurrency, termAccountCurrency, activeLot.openedAt);
          termFxRate = fxRes.fxRate;
          termFxTimestamp = fxRes.fxTimestamp;
          termFxPair = fxRes.fxPair;
        }
        const termLev = terminalInst?.defaultLeverage ?? 1;
        const termMarginMode = terminalInst?.marginMode ?? (termLev > 1 ? 'ISOLATED' : 'SPOT');
        const termNotional = TradeAccountingEngine.calculateNotional(activeLot.initialQuantity, activeLot.entryPrice, termContractSize, termFxRate);
        const termMargin = TradeAccountingEngine.calculateMargin(termNotional.notionalAccount, termLev, termMarginMode, terminalInst?.initialMarginRate, terminalInst?.maintenanceMarginRate);
        const termRisk = TradeAccountingEngine.calculateStopRisk(activeLot.entryPrice, activeLot.initialStopLoss, activeLot.initialQuantity, termContractSize, termFxRate);

        tradeRecord = {
          id: `${runId}_tr_${trades.length + 1}`,
          direction: activeLot.direction,
          entryTime: new Date(activeLot.openedAt),
          entryPrice: activeLot.entryPrice,
          exitTime: new Date(finalTime),
          exitPrice: finalClose,
          stopLoss: activeLot.initialStopLoss,
          takeProfit: activeLot.tp2,
          positionSize: activeLot.initialQuantity,
          marginRequired: termMargin.initialMarginRequired,
          initialMarginRequired: termMargin.initialMarginRequired,
          maintenanceMarginRequired: termMargin.maintenanceMarginRequired,
          positionNotionalQuote: termNotional.notionalQuote,
          positionNotionalAccount: termNotional.notionalAccount,
          accountCurrency: termAccountCurrency,
          quoteCurrency: termQuoteCurrency,
          fxPair: termFxPair,
          fxRate: termFxRate,
          fxTimestamp: termFxTimestamp,
          contractSize: termContractSize,
          lotSize: termLotSize,
          leverage: termLev,
          marginMode: termMarginMode,
          riskAmount: termRisk,
          pnl: netPnl,
          pnlRMultiple: Number((netPnl / Math.max(0.0001, initialRiskDist * activeLot.initialQuantity * termContractSize)).toFixed(4)),
          exitReason: (lastFill?.targetType as any) || SignalState.TP1_HIT,
          signalTimestamp: new Date(activeLot.entrySnapshot?.signalTimestamp || activeLot.openedAt),
          orderCreatedAt: new Date(activeLot.entrySnapshot?.orderCreatedAt || activeLot.openedAt),
          orderSubmittedAt: new Date(activeLot.entrySnapshot?.orderSubmittedAt || activeLot.openedAt),
          entryFillTimestamp: new Date(activeLot.entrySnapshot?.executionTimestamp || activeLot.openedAt),
          entryReferencePrice: activeLot.entrySnapshot?.referencePrice || activeLot.entryPrice,
          entryFillPrice: activeLot.entrySnapshot?.entryPrice || activeLot.entryPrice,
          entryFees: activeLot.entrySnapshot?.fee ?? (firstFill?.fee || 0),
          entrySlippage: activeLot.entrySnapshot?.slippage ?? (firstFill?.slippage || 0),
          exitOrderTimestamp: new Date(finalTime),
          exitOrderCreatedAt: new Date(finalTime),
          exitOrderSubmittedAt: new Date(finalTime),
          exitTriggerTimestamp: new Date(finalTime),
          exitFillTimestamp: new Date(finalTime),
          exitFillPrice: finalClose,
          exitFees: totalFees - (firstFill?.fee || 0),
          exitSlippage: activeLot.partialFills.reduce((sum, fill) => sum + fill.slippage, 0) - (firstFill?.slippage || 0),
          grossPnL: activeLot.realizedPnl,
          netPnL: netPnl,
          realizedR: Number((netPnl / Math.max(1, initialRiskDist * activeLot.initialQuantity)).toFixed(4)),
          fillModel: String(fillModel),
          ambiguityMode: String(ambiguityMode),
          entrySnapshot: activeLot.entrySnapshot,
        };

        currentCash = Number((currentCash + netPnl).toFixed(2));
        currentEquity = currentCash;
      }

      trades.push(tradeRecord);
      positionLots.push(activeLot);

      if (equityCurve.length > 0) {
        equityCurve[equityCurve.length - 1].equity = currentEquity;
      }
      if (equitySnapshots.length > 0) {
        equitySnapshots[equitySnapshots.length - 1].equity = currentEquity;
        equitySnapshots[equitySnapshots.length - 1].cash = currentCash;
        if (isSpotTrading) {
          equitySnapshots[equitySnapshots.length - 1].availableMargin = currentCash;
          equitySnapshots[equitySnapshots.length - 1].marginUsed = 0;
          equitySnapshots[equitySnapshots.length - 1].grossExposure = 0;
          equitySnapshots[equitySnapshots.length - 1].netExposure = 0;
          equitySnapshots[equitySnapshots.length - 1].unrealizedPnL = 0;
          equitySnapshots[equitySnapshots.length - 1].realizedPnL = Number((currentCash - initialCapital).toFixed(2));
        }
      }
    }

    const metrics = MetricsCalculator.calculateMetrics(
      trades,
      initialCapital,
      equityCurve,
      equitySnapshots,
      positionLots,
    );

    return {
      runId,
      id: `${runId}_res`,
      symbol: options.symbol || symbol,
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

/**
 * Dedicated Authoritative Spot Backtest Simulator.
 * Strictly enforces spot-only universe (NIFTY_SPOT, BANKNIFTY_SPOT, BTCUSDT_SPOT),
 * rejects legacy aliases and forbidden derivatives,
 * and guarantees 100% pure cash spot execution.
 */
export class SpotBacktestSimulator {
  static runSimulation(options: IBacktestOptions): IBacktestSimulationResult {
    const rawSymbol = (options.symbol || '').toUpperCase().trim();
    if (FORBIDDEN_DERIVATIVE_INSTRUMENTS.has(rawSymbol)) {
      throw new Error(
        `FORBIDDEN_DERIVATIVE_INSTRUMENT: Derivative instrument '${rawSymbol}' is strictly forbidden in spot trading architecture.`,
      );
    }
    if (rawSymbol in LEGACY_SPOT_ALIASES) {
      throw new Error(
        `LEGACY_ALIAS_REJECTED: Symbol '${rawSymbol}' is a legacy alias. The spot engine strictly requires canonical symbol '${LEGACY_SPOT_ALIASES[rawSymbol]}'.`,
      );
    }
    if (!isSupportedSpotSymbol(rawSymbol)) {
      throw new Error(
        `UNSUPPORTED_SPOT_INSTRUMENT: Symbol '${options.symbol}' is not supported in the spot trading universe. Supported symbols: ${SUPPORTED_SPOT_SYMBOLS.join(', ')}`,
      );
    }
    return BacktestSimulator.runSimulation({
      ...options,
      symbol: rawSymbol,
      isSpot: true,
    });
  }
}
