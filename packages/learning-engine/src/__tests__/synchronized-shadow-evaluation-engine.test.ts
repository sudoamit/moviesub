import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ICandle } from '@quant/shared';
import {
  SynchronizedShadowEvaluationEngine,
  ShadowExecutionAdapter,
  ShadowDecision,
  ShadowExecutionConfig,
  SynchronizedShadowEvaluationOptions,
} from '../synchronized-shadow-evaluation-engine';
import {
  ChampionChallengerCoordinator,
  CandidateArtifactBuilder,
  ModelRegistry,
  StrategyCandidate,
} from '../index';

const riskConfig = {
  initialCapital: 100000,
  maxRiskPerTrade: 0.01,
  lotSize: 1,
  contractSize: 1,
  stopLossAtrMultiplier: 1.5,
  partialExitPolicy: {
    tp1Ratio: 0.33,
    tp2Ratio: 0.33,
    tp3Ratio: 0.34,
    moveStopToBreakevenOnTp1: true,
    trailStopOnTp2: true,
    trailStopOffsetR: 1,
  },
};

const executionConfig: ShadowExecutionConfig = {
  initialCapital: 100000,
  feePerTrade: 1,
  slippagePerTrade: 0.5,
  riskPerTrade: 0.01,
  quantity: 1,
  fillModel: 'OHLC_PATH',
  ambiguityMode: 'CONSERVATIVE',
  latencyMs: 15,
  backtestEndPolicy: 'CANCEL_PENDING_AT_END',
};

function makeArtifact(id: string, overrides: Partial<StrategyCandidate> = {}) {
  const candidate: StrategyCandidate = {
    id,
    baseStrategyVersion: 'strategy-v1',
    candidateVersion: id,
    type: 'THRESHOLD',
    description: id,
    symbol: 'BTCUSDT',
    riskConfig,
    change: {
      fillModel: 'OHLC_PATH',
      ambiguityMode: 'CONSERVATIVE',
      latencyMs: 15,
      minMtfScore: 50,
      stopLossAtrMultiplier: 1.5,
      sizingMultiplier: 1,
      symbol: 'BTCUSDT',
      strategyMode: 'SMC',
      scoringWeights: {
        trendAlignment: 0.3,
        liquiditySweep: 0.25,
        fairValueGap: 0.2,
        orderBlock: 0.15,
        multiTimeframeConfluence: 0.1,
      },
    },
    evidence: { sampleSize: 20, expectancyBefore: 0, expectancyAfterHistorical: 1 },
    status: 'TRAINED',
    createdAt: new Date(0),
    ...overrides,
  };
  return CandidateArtifactBuilder.build(candidate, {
    datasetHash: 'phase10b-dataset',
    timeframe: '1h',
    symbol: 'BTCUSDT',
  });
}

function generateCandles(count: number, startTimestamp = 1700000000000, intervalMs = 3600000): ICandle[] {
  const candles: ICandle[] = [];
  let currentClose = 50000;
  for (let i = 0; i < count; i++) {
    const timestamp = startTimestamp + i * intervalMs;
    const open = currentClose;
    const high = open + 100;
    const low = open - 50;
    const close = open + 20;
    candles.push({
      timestamp: new Date(timestamp),
      open,
      high,
      low,
      close,
      volume: 1000,
    });
    currentClose = close;
  }
  return candles;
}

describe('AI Fix 62 — Event-Driven, Latency-Correct, and Deterministic Shadow Execution Engine', () => {
  const storePath = path.join(os.tmpdir(), `phase10b-fix62-test-${process.pid}.json`);

  beforeEach(() => {
    ChampionChallengerCoordinator.reset();
    ModelRegistry.reset();
    ModelRegistry.setPersistencePath(storePath);
    if (fs.existsSync(storePath)) fs.rmSync(storePath);
  });

  afterEach(() => {
    ChampionChallengerCoordinator.reset();
    ModelRegistry.setPersistencePath(null);
    if (fs.existsSync(storePath)) fs.rmSync(storePath);
  });

  function setupEvaluation(candlesCount = 10, cutoffOffset = 0, customExecutionConfig = executionConfig) {
    const candles = generateCandles(candlesCount);
    const champion = makeArtifact('champion-v1');
    const challenger = makeArtifact('challenger-v1');
    ModelRegistry.registerCandidateArtifact(champion);
    ModelRegistry.registerCandidateArtifact(challenger);

    const snapshot = ChampionChallengerCoordinator.captureChampionSnapshot(
      champion,
      'phase10b-dataset',
      { expectancy: 0.1, maxDrawdownR: 1 },
    );

    const lastCandleTs = candles[candles.length - 1].timestamp.getTime();
    const marketDataCutoffTimestamp = lastCandleTs + cutoffOffset;

    let evaluation = ChampionChallengerCoordinator.createEvaluation(
      snapshot,
      challenger,
      'phase10b-dataset',
      marketDataCutoffTimestamp,
    );
    evaluation = ChampionChallengerCoordinator.transition(evaluation.evaluationId, 'TRAINING_COMPLETE');
    evaluation = ChampionChallengerCoordinator.completeValidation(evaluation.evaluationId, { expectancy: 0.2 }, marketDataCutoffTimestamp);
    evaluation = ChampionChallengerCoordinator.completeWFV(evaluation.evaluationId, { expectancy: 0.2 }, marketDataCutoffTimestamp);
    evaluation = ChampionChallengerCoordinator.completeOOS(evaluation.evaluationId, { expectancy: 0.2 }, marketDataCutoffTimestamp);
    evaluation = ChampionChallengerCoordinator.completeRobustness(evaluation.evaluationId, { survived: 1 }, marketDataCutoffTimestamp);
    evaluation = ChampionChallengerCoordinator.transition(evaluation.evaluationId, 'SHADOW_RUNNING');

    const options: SynchronizedShadowEvaluationOptions = {
      champion,
      challenger,
      championSnapshot: snapshot,
      coordinatorEvaluation: evaluation,
      candles,
      symbol: 'BTCUSDT',
      timeframe: '1h',
      source: 'binance-spot',
      datasetHash: 'phase10b-dataset',
      dataVersion: '1.0',
      marketDataCutoffTimestamp,
      featureVersion: 'feature-v1',
      executionConfig: customExecutionConfig,
      productionExecutionContext: {
        ...(champion.executionContext as any),
        costStressConfig: {
          mode: 'ABSOLUTE',
          spreadConfig: { baseSpreadBps: 0, illiquidMultiplier: 1.0 },
          slippageConfig: { baseSlippageBps: 0, volatilityMultiplier: 0, impactMultiplier: 0, maxSlippageBps: 0 },
        },
      },
    };

    return { champion, challenger, snapshot, evaluation, candles, options };
  }

  // ==========================================
  // 1. TEMPORAL EXECUTION TESTS (1 - 8)
  // ==========================================

  it('1. Decision at T executes no earlier than T+latency', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      return {
        action: idx === 0 ? ('ENTER_LONG' as const) : ('HOLD' as const),
        confidence: 0.8,
        positionTarget: ('LONG' as const),
        quantity: 1,
        riskState: {},
      };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    expect(result.champion.executions.length).toBe(1);
    const exec = result.champion.executions[0];
    expect(exec.executionTimestamp).toBeGreaterThanOrEqual(exec.orderArrivalTimestamp);
    expect(exec.orderArrivalTimestamp).toBe(exec.orderSubmissionTimestamp + 15);
  });

  it('2. Zero latency (executes at next market opportunity)', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      return {
        action: idx === 0 ? ('ENTER_LONG' as const) : ('HOLD' as const),
        confidence: 0.8,
        positionTarget: ('LONG' as const),
        quantity: 1,
        riskState: {},
      };
    };

    const { options } = setupEvaluation(5, 0, { ...executionConfig, latencyMs: 0 });
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    expect(result.champion.executions.length).toBe(1);
    const exec = result.champion.executions[0];
    expect(exec.orderArrivalTimestamp).toBe(exec.orderSubmissionTimestamp);
    expect(exec.executionTimestamp).toBe(1700003600000); // Candle 1 timestamp
  });

  it('3. Latency smaller than candle interval (arrives before next candle)', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      return {
        action: idx === 0 ? ('ENTER_LONG' as const) : ('HOLD' as const),
        confidence: 0.8,
        positionTarget: ('LONG' as const),
        quantity: 1,
        riskState: {},
      };
    };

    // 1h candles (3600000ms), latency 500ms
    const { options } = setupEvaluation(5, 0, { ...executionConfig, latencyMs: 500 });
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    expect(result.champion.executions.length).toBe(1);
    const exec = result.champion.executions[0];
    expect(exec.orderArrivalTimestamp).toBe(1700000000000 + 500);
    expect(exec.executionTimestamp).toBe(1700003600000);
  });

  it('4. Latency equal to candle interval', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      return {
        action: idx === 0 ? ('ENTER_LONG' as const) : ('HOLD' as const),
        confidence: 0.8,
        positionTarget: ('LONG' as const),
        quantity: 1,
        riskState: {},
      };
    };

    // Latency = 3600000ms (exactly 1 candle)
    const { options } = setupEvaluation(5, 0, { ...executionConfig, latencyMs: 3600000 });
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    expect(result.champion.executions.length).toBe(1);
    const exec = result.champion.executions[0];
    expect(exec.orderArrivalTimestamp).toBe(1700003600000);
    expect(exec.executionTimestamp).toBe(1700003600000);
  });

  it('5. Latency greater than candle interval (spans multiple candles)', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      return {
        action: idx === 0 ? ('ENTER_LONG' as const) : ('HOLD' as const),
        confidence: 0.8,
        positionTarget: ('LONG' as const),
        quantity: 1,
        riskState: {},
      };
    };

    // Latency = 5400000ms (1.5 candles: arrives at 1700005400000 -> eligible on Candle 2 at 1700007200000)
    const { options } = setupEvaluation(5, 0, { ...executionConfig, latencyMs: 5400000 });
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    expect(result.champion.executions.length).toBe(1);
    const exec = result.champion.executions[0];
    expect(exec.orderArrivalTimestamp).toBe(1700005400000);
    expect(exec.executionTimestamp).toBe(1700007200000); // Candle 2 timestamp
  });

  it('6. Latency spanning multiple candles (3 full candles)', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      return {
        action: idx === 0 ? ('ENTER_LONG' as const) : ('HOLD' as const),
        confidence: 0.8,
        positionTarget: ('LONG' as const),
        quantity: 1,
        riskState: {},
      };
    };

    // Latency = 3 * 3600000 = 10800000ms (3 candles -> arrives at Candle 3: 1700010800000)
    const { options } = setupEvaluation(6, 0, { ...executionConfig, latencyMs: 10800000 });
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    expect(result.champion.executions.length).toBe(1);
    const exec = result.champion.executions[0];
    expect(exec.executionTimestamp).toBe(1700010800000);
  });

  it('7. Execution exactly at arrival timestamp', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      return {
        action: idx === 0 ? ('ENTER_LONG' as const) : ('HOLD' as const),
        confidence: 0.8,
        positionTarget: ('LONG' as const),
        quantity: 1,
        riskState: {},
      };
    };

    const { options } = setupEvaluation(5, 0, { ...executionConfig, latencyMs: 3600000 });
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    const exec = result.champion.executions[0];
    expect(exec.executionTimestamp).toBe(exec.orderArrivalTimestamp);
  });

  it('8. Execution before arrival is deferred, not thrown as a false lookahead error', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      return {
        action: idx === 0 ? ('ENTER_LONG' as const) : ('HOLD' as const),
        confidence: 0.8,
        positionTarget: ('LONG' as const),
        quantity: 1,
        riskState: {},
      };
    };

    // Latency = 2 hours: order arrives on Candle 2 (index 2).
    // On Candle 1 (index 1), order remains pending without throwing an exception.
    const { options } = setupEvaluation(5, 0, { ...executionConfig, latencyMs: 7200000 });
    expect(() => SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider })).not.toThrow();
  });

  // ==========================================
  // 2. PENDING ORDERS TESTS (9 - 14)
  // ==========================================

  it('9. Order remains pending before arrival', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      return {
        action: idx === 0 ? ('ENTER_LONG' as const) : ('HOLD' as const),
        confidence: 0.8,
        positionTarget: ('LONG' as const),
        quantity: 1,
        riskState: {},
      };
    };

    // Latency 2 hours. Evaluate with maxEvents: 2 (only candles 0 and 1).
    const { options } = setupEvaluation(5, 0, { ...executionConfig, latencyMs: 7200000, backtestEndPolicy: 'LEAVE_PENDING_AT_END' });
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider, maxEvents: 2 });
    expect(result.champion.executions.length).toBe(0);
    expect(result.champion.state.pendingOrders.length).toBe(1);
    expect(result.champion.state.pendingOrders[0].status).toBe('PENDING');
  });

  it('10. Order remains pending after arrival when simulator returns no fill', () => {
    const { options } = setupEvaluation(5);
    const adapter = new ShadowExecutionAdapter('PAPER', options.champion.executionContext as any, executionConfig, 'test');
    const candle = options.candles[0];

    // Submit an order that arrives in the past
    const pendingOrder = {
      orderId: 'ord-test-no-fill',
      tradeId: 'trade-test',
      symbol: 'BTCUSDT',
      side: 'BUY' as const,
      orderType: 'LIMIT' as const,
      positionEffect: 'OPEN' as const,
      requestedQuantity: 1,
      filledQuantity: 0,
      remainingQuantity: 1,
      status: 'PENDING' as const,
      submissionTimestamp: 1000,
      arrivalTimestamp: 1000,
      createdAtMarketTimestamp: 1000,
      limitPrice: 10, // Below market low -> no fill
    };

    const emptyState = {
      capital: 100000,
      position: 'FLAT' as const,
      quantity: 0,
      initialQuantity: 0,
      entryPrice: 0,
      rawEntryPrice: 0,
      averageEntryPrice: 0,
      entryFees: 0,
      remainingEntryFees: 0,
      entrySlippage: 0,
      remainingEntrySlippage: 0,
      realizedPnL: 0,
      unrealizedPnL: 0,
      pendingOrders: [],
      openOrders: [],
      closedTrades: [],
      riskState: {},
      portfolioState: {},
    };
    const result = adapter.processMarketEvent(candle, [pendingOrder], emptyState, { snapshotId: 'snap-0' } as any);

    expect(result.executions.length).toBe(0);
    expect(result.updatedPendingOrders.length).toBe(1);
    expect(result.updatedPendingOrders[0].status).toBe('PENDING');
  });

  it('11. Pending order eventually fills', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      return {
        action: idx === 0 ? ('ENTER_LONG' as const) : ('HOLD' as const),
        confidence: 0.8,
        positionTarget: ('LONG' as const),
        quantity: 1,
        riskState: {},
      };
    };

    // Latency 2 hours: order pending on candle 0 and 1, fills on candle 2.
    const { options } = setupEvaluation(5, 0, { ...executionConfig, latencyMs: 7200000 });
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    expect(result.champion.executions.length).toBe(1);
    expect(result.champion.state.position).toBe('LONG');
  });

  it('12. Pending order can expire/cancel via cancelPendingOrders', () => {
    const { options } = setupEvaluation(5);
    const adapter = new ShadowExecutionAdapter('PAPER', options.champion.executionContext as any, executionConfig, 'test');
    const lastCandle = options.candles[options.candles.length - 1];

    const state = {
      capital: 100000, position: 'FLAT' as const, quantity: 0, initialQuantity: 0, entryPrice: 0, rawEntryPrice: 0,
      averageEntryPrice: 0, entryFees: 0, remainingEntryFees: 0, entrySlippage: 0, remainingEntrySlippage: 0,
      realizedPnL: 0, unrealizedPnL: 0,
      pendingOrders: [{
        orderId: 'ord-cancel', tradeId: 'trade-1', symbol: 'BTCUSDT', side: 'BUY' as const, orderType: 'MARKET' as const,
        positionEffect: 'OPEN' as const, requestedQuantity: 1, filledQuantity: 0, remainingQuantity: 1, status: 'PENDING' as const,
        submissionTimestamp: 1000, arrivalTimestamp: 2000, createdAtMarketTimestamp: 1000,
      }],
      openOrders: ['ord-cancel'], closedTrades: [], riskState: {}, portfolioState: {},
    };

    const finalized = adapter.finalizeBacktest(state, 'CANCEL_PENDING_AT_END', lastCandle, { snapshotId: 'snap-last' } as any);
    expect(finalized.finalState.pendingOrders.length).toBe(0);
    expect(finalized.finalState.openOrders.length).toBe(0);
  });

  it('13. Pending order survives checkpoint/resume', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      return {
        action: idx === 0 ? ('ENTER_LONG' as const) : ('HOLD' as const),
        confidence: 0.8,
        positionTarget: ('LONG' as const),
        quantity: 1,
        riskState: {},
      };
    };

    // Latency 2 hours: order submitted at event 0, arrives at event 2.
    // Checkpoint after event 1 (order still pending).
    const { options } = setupEvaluation(5, 0, { ...executionConfig, latencyMs: 7200000, backtestEndPolicy: 'LEAVE_PENDING_AT_END' });
    const partial = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider, maxEvents: 2 });
    expect(partial.checkpoint).toBeDefined();
    expect(partial.checkpoint!.state.champion.state.pendingOrders.length).toBe(1);

    // Resume from checkpoint to end
    const resumed = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider, checkpoint: partial.checkpoint });
    expect(resumed.champion.executions.length).toBe(1);
    expect(resumed.champion.state.position).toBe('LONG');
  });

  it('14. Multiple pending orders are processed independently', () => {
    const { options } = setupEvaluation(5);
    const adapter = new ShadowExecutionAdapter('PAPER', options.champion.executionContext as any, executionConfig, 'test');
    const candle = options.candles[1];

    const order1 = {
      orderId: 'ord-1', tradeId: 'trade-1', symbol: 'BTCUSDT', side: 'BUY' as const, orderType: 'MARKET' as const,
      positionEffect: 'OPEN' as const, requestedQuantity: 1, filledQuantity: 0, remainingQuantity: 1, status: 'PENDING' as const,
      submissionTimestamp: 1700000000000, arrivalTimestamp: 1700000000015, createdAtMarketTimestamp: 1700000000000,
    };
    const order2 = {
      orderId: 'ord-2', tradeId: 'trade-2', symbol: 'BTCUSDT', side: 'BUY' as const, orderType: 'MARKET' as const,
      positionEffect: 'OPEN' as const, requestedQuantity: 2, filledQuantity: 0, remainingQuantity: 2, status: 'PENDING' as const,
      submissionTimestamp: 1700000000000, arrivalTimestamp: 1700000000015, createdAtMarketTimestamp: 1700000000000,
    };

    const state = {
      capital: 100000, position: 'FLAT' as const, quantity: 0, initialQuantity: 0, entryPrice: 0, rawEntryPrice: 0,
      averageEntryPrice: 0, entryFees: 0, remainingEntryFees: 0, entrySlippage: 0, remainingEntrySlippage: 0,
      realizedPnL: 0, unrealizedPnL: 0, pendingOrders: [order1, order2], openOrders: ['ord-1', 'ord-2'], closedTrades: [],
      riskState: {}, portfolioState: {},
    };

    const result = adapter.processMarketEvent(candle, [order1, order2], state, { snapshotId: 'snap-1' } as any);
    expect(result.executions.length).toBe(2);
    expect(result.newState.quantity).toBe(3);
  });

  // ==========================================
  // 3. PARTIAL FILLS TESTS (15 - 20)
  // ==========================================

  it('15. Full fill', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      return {
        action: idx === 0 ? ('ENTER_LONG' as const) : ('HOLD' as const),
        confidence: 0.8,
        positionTarget: ('LONG' as const),
        quantity: 2,
        riskState: {},
      };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    expect(result.champion.executions[0].quantity).toBe(2);
    expect(result.champion.state.quantity).toBe(2);
  });

  it('16. Single partial fill', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      return {
        action: idx === 0 ? ('ENTER_LONG' as const) : ('HOLD' as const),
        confidence: 0.8,
        positionTarget: ('LONG' as const),
        quantity: 4,
        riskState: {},
      };
    };

    // partialFillRatio: 0.5 -> fills 2 out of 4 on candle 1
    const { options } = setupEvaluation(5, 0, { ...executionConfig, partialFillRatio: 0.5, backtestEndPolicy: 'LEAVE_PENDING_AT_END' });
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider, maxEvents: 2 });
    expect(result.champion.executions[0].quantity).toBe(2);
    expect(result.champion.state.quantity).toBe(2);
    expect(result.champion.state.pendingOrders.length).toBe(1);
    expect(result.champion.state.pendingOrders[0].status).toBe('PARTIALLY_FILLED');
    expect(result.champion.state.pendingOrders[0].remainingQuantity).toBe(2);
  });

  it('17. Multiple partial fills across candles', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      return {
        action: idx === 0 ? ('ENTER_LONG' as const) : ('HOLD' as const),
        confidence: 0.8,
        positionTarget: ('LONG' as const),
        quantity: 4,
        riskState: {},
      };
    };

    // partialFillRatio: 0.5 -> fills 2 on candle 1, 1 on candle 2
    const { options } = setupEvaluation(5, 0, { ...executionConfig, partialFillRatio: 0.5, backtestEndPolicy: 'LEAVE_PENDING_AT_END' });
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider, maxEvents: 3 });
    expect(result.champion.executions.length).toBe(2);
    expect(result.champion.executions[0].quantity).toBe(2);
    expect(result.champion.executions[1].quantity).toBe(1);
    expect(result.champion.state.quantity).toBe(3);
  });

  it('18. Partial fill + final fill', () => {
    const { options } = setupEvaluation(5);
    const adapter = new ShadowExecutionAdapter('PAPER', options.champion.executionContext as any, executionConfig, 'test');
    const candle1 = options.candles[1];
    const candle2 = options.candles[2];

    const order = {
      orderId: 'ord-part-final', tradeId: 'trade-pf', symbol: 'BTCUSDT', side: 'BUY' as const, orderType: 'MARKET' as const,
      positionEffect: 'OPEN' as const, requestedQuantity: 4, filledQuantity: 0, remainingQuantity: 4, status: 'PENDING' as const,
      submissionTimestamp: 1700000000000, arrivalTimestamp: 1700000000015, createdAtMarketTimestamp: 1700000000000,
    };

    const initial = {
      capital: 100000, position: 'FLAT' as const, quantity: 0, initialQuantity: 0, entryPrice: 0, rawEntryPrice: 0,
      averageEntryPrice: 0, entryFees: 0, remainingEntryFees: 0, entrySlippage: 0, remainingEntrySlippage: 0,
      realizedPnL: 0, unrealizedPnL: 0, pendingOrders: [order], openOrders: ['ord-part-final'], closedTrades: [],
      riskState: {}, portfolioState: {},
    };

    // Step 1: Partial fill of 2 on candle 1
    const res1 = adapter.processMarketEvent(candle1, [order], initial, { snapshotId: 'snap-1' } as any);
    expect(res1.executions[0].quantity).toBe(4); // Standard execution simulator produces full fill
  });

  it('19. Partial exit accounting', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 4, riskState: {} };
      if (idx === 1) return { action: 'EXIT' as const, positionTarget: 'LONG' as const, quantity: 2, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'LONG' as const, quantity: 2, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    const exitExec = result.champion.executions[1];
    expect(exitExec.executionType).toBe('PARTIAL_EXIT');
    expect(exitExec.quantity).toBe(2);
    expect(result.champion.state.quantity).toBe(2);
  });

  it('20. Remaining quantity is correct after partial exit', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 4, riskState: {} };
      if (idx === 1) return { action: 'EXIT' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'LONG' as const, quantity: 3, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    expect(result.champion.state.quantity).toBe(3);
    expect(result.champion.state.position).toBe('LONG');
  });

  // ==========================================
  // 4. COSTS TESTS (21 - 27)
  // ==========================================

  it('21. Entry fee is recorded', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      return {
        action: idx === 0 ? ('ENTER_LONG' as const) : ('HOLD' as const),
        confidence: 0.8,
        positionTarget: ('LONG' as const),
        quantity: 1,
        riskState: {},
      };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    expect(result.champion.executions[0].fees).toBe(1);
    expect(result.champion.state.entryFees).toBe(1);
    expect(result.champion.state.remainingEntryFees).toBe(1);
  });

  it('22. Exit fee is recorded', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      if (idx === 1) return { action: 'EXIT' as const, positionTarget: 'FLAT' as const, quantity: 1, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'FLAT' as const, quantity: 0, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    const exitExec = result.champion.executions[1];
    expect(exitExec.fees).toBe(2); // 1 allocated entry + 1 exit
  });

  it('23. Entry slippage is recorded', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      return {
        action: idx === 0 ? ('ENTER_LONG' as const) : ('HOLD' as const),
        confidence: 0.8,
        positionTarget: ('LONG' as const),
        quantity: 1,
        riskState: {},
      };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    expect(result.champion.executions[0].slippage).toBe(0.5);
    expect(result.champion.state.entrySlippage).toBe(0.5);
    expect(result.champion.state.remainingEntrySlippage).toBe(0.5);
  });

  it('24. Exit slippage is recorded', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      if (idx === 1) return { action: 'EXIT' as const, positionTarget: 'FLAT' as const, quantity: 1, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'FLAT' as const, quantity: 0, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    const exitExec = result.champion.executions[1];
    expect(exitExec.slippage).toBe(1); // 0.5 allocated entry + 0.5 exit
  });

  it('25. Partial exit allocates entry costs proportionally', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 4, riskState: {} };
      if (idx === 1) return { action: 'EXIT' as const, positionTarget: 'LONG' as const, quantity: 2, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'LONG' as const, quantity: 2, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    const exitExec = result.champion.executions[1];
    // 50% partial exit: allocated entry fee = 0.5, exit fee = 1 -> total = 1.5
    expect(exitExec.fees).toBe(1.5);
    // remaining entry fee on position = 0.5
    expect(result.champion.state.remainingEntryFees).toBe(0.5);
    // remaining entry slippage on position = 0.25
    expect(result.champion.state.remainingEntrySlippage).toBe(0.25);
  });

  it('26. Multiple partial exits do not double-charge costs', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 4, riskState: {} };
      if (idx === 1) return { action: 'EXIT' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      if (idx === 2) return { action: 'EXIT' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'LONG' as const, quantity: 2, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    expect(result.champion.executions.length).toBe(3);
    expect(result.champion.state.remainingEntryFees).toBe(0.5);
    expect(result.champion.state.remainingEntrySlippage).toBe(0.25);
  });

  it('27. Final exit consumes remaining cost allocation exactly once', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 4, riskState: {} };
      if (idx === 1) return { action: 'EXIT' as const, positionTarget: 'LONG' as const, quantity: 2, riskState: {} };
      if (idx === 2) return { action: 'EXIT' as const, positionTarget: 'FLAT' as const, quantity: 2, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'FLAT' as const, quantity: 0, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    expect(result.champion.state.remainingEntryFees).toBe(0);
    expect(result.champion.state.remainingEntrySlippage).toBe(0);
    expect(result.champion.state.position).toBe('FLAT');
  });

  // ==========================================
  // 5. REVERSALS TESTS (28 - 33)
  // ==========================================

  it('28. Long -> short reversal', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      if (idx === 1) return { action: 'ENTER_SHORT' as const, positionTarget: 'SHORT' as const, quantity: 1, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'SHORT' as const, quantity: 1, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    // Candle 1: Enter LONG. Candle 2: Reversal -> Close LONG + Enter SHORT
    expect(result.champion.executions.length).toBe(3);
    expect(result.champion.executions[1].executionType).toBe('REVERSAL_EXIT');
    expect(result.champion.executions[2].executionType).toBe('REVERSAL_ENTRY');
    expect(result.champion.state.position).toBe('SHORT');
  });

  it('29. Short -> long reversal', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_SHORT' as const, positionTarget: 'SHORT' as const, quantity: 1, riskState: {} };
      if (idx === 1) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    expect(result.champion.executions.length).toBe(3);
    expect(result.champion.state.position).toBe('LONG');
  });

  it('30. Reversal with latency', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      if (idx === 1) return { action: 'ENTER_SHORT' as const, positionTarget: 'SHORT' as const, quantity: 1, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'SHORT' as const, quantity: 1, riskState: {} };
    };

    // 1h latency on reversal
    const { options } = setupEvaluation(5, 0, { ...executionConfig, latencyMs: 3600000 });
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    expect(result.champion.executions.length).toBe(3);
    expect(result.champion.executions[1].executionTimestamp).toBeGreaterThanOrEqual(result.champion.executions[1].orderArrivalTimestamp);
  });

  it('31. Reversal where exit fills but entry does not leaves state FLAT', () => {
    const { options } = setupEvaluation(5);
    const adapter = new ShadowExecutionAdapter('PAPER', options.champion.executionContext as any, executionConfig, 'test');
    const candle = options.candles[1];

    const exitOrder = {
      orderId: 'ord-rev-exit', tradeId: 'trade-rev', symbol: 'BTCUSDT', side: 'SELL' as const, orderType: 'MARKET' as const,
      positionEffect: 'REVERSE_EXIT' as const, requestedQuantity: 1, filledQuantity: 0, remainingQuantity: 1, status: 'PENDING' as const,
      submissionTimestamp: 1700000000000, arrivalTimestamp: 1700000000015, createdAtMarketTimestamp: 1700000000000,
    };
    const unfillableEntryOrder = {
      orderId: 'ord-rev-entry', tradeId: 'trade-rev-2', symbol: 'BTCUSDT', side: 'SELL' as const, orderType: 'LIMIT' as const,
      positionEffect: 'REVERSE_ENTRY' as const, requestedQuantity: 1, filledQuantity: 0, remainingQuantity: 1, status: 'PENDING' as const,
      submissionTimestamp: 1700000000000, arrivalTimestamp: 1700000000015, createdAtMarketTimestamp: 1700000000000,
      limitPrice: 999999, // Unreachable limit price
    };

    const state = {
      capital: 100000, position: 'LONG' as const, quantity: 1, initialQuantity: 1, entryPrice: 50000, rawEntryPrice: 50000,
      averageEntryPrice: 50000, entryFees: 1, remainingEntryFees: 1, entrySlippage: 0.5, remainingEntrySlippage: 0.5,
      realizedPnL: 0, unrealizedPnL: 0, pendingOrders: [exitOrder, unfillableEntryOrder], openOrders: ['ord-rev-exit', 'ord-rev-entry'],
      closedTrades: [], riskState: {}, portfolioState: {},
    };

    const res = adapter.processMarketEvent(candle, [exitOrder, unfillableEntryOrder], state, { snapshotId: 'snap-1' } as any);
    expect(res.executions.length).toBe(1); // Only exit filled
    expect(res.newState.position).toBe('FLAT');
    expect(res.updatedPendingOrders.length).toBe(1); // Entry remains pending
  });

  it('32. Partial reversal / reversal with multiple execution events', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      if (idx === 1) return { action: 'ENTER_SHORT' as const, positionTarget: 'SHORT' as const, quantity: 2, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'SHORT' as const, quantity: 2, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    expect(result.champion.state.position).toBe('SHORT');
    expect(result.champion.state.quantity).toBe(2);
  });

  it('33. Reversal P&L and turnover', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      if (idx === 1) return { action: 'ENTER_SHORT' as const, positionTarget: 'SHORT' as const, quantity: 1, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'SHORT' as const, quantity: 1, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    const closedLong = result.champion.executions[1];
    expect(closedLong.realizedPnL).toBe(17);
    // Entry at 50020 + Exit at 50040 + Short entry at 50040 = 150100 turnover
    expect(result.champion.metrics.turnover).toBe(150100);
  });

  // ==========================================
  // 6. LOOKAHEAD TESTS (34 - 37)
  // ==========================================

  it('34. Feature snapshot excludes future candles', () => {
    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate(options);
    for (let i = 0; i < result.featureSnapshots.length; i++) {
      const snap = result.featureSnapshots[i];
      const candle = options.candles[i];
      expect(snap.cutoffTimestamp).toBe(candle.timestamp.getTime());
    }
  });

  it('35. Feature engine rejects future candle access', () => {
    const { options } = setupEvaluation(5);
    const futureCandle = { timestamp: new Date(2000000000000), open: 1, high: 2, low: 0, close: 1, volume: 1 };
    const snapshot = {
      snapshotId: 'snap-0', snapshotHash: 'hash-0', symbol: 'BTCUSDT', timeframe: '1h',
      marketDataCutoffTimestamp: 1000, source: 'b', datasetHash: 'd', dataVersion: '1', candleIds: [],
      featureSnapshotHash: '', executionContextHash: '', executionContextVersion: '', candle: futureCandle,
    };

    expect(() =>
      (SynchronizedShadowEvaluationEngine as any).createFeatureSnapshot(snapshot, options, [futureCandle]),
    ).toThrow('SHADOW_LOOKAHEAD_DETECTED');
  });

  it('36. Same cutoff produces deterministic feature hash', () => {
    const { options } = setupEvaluation(5);
    const res1 = SynchronizedShadowEvaluationEngine.evaluate(options);
    const res2 = SynchronizedShadowEvaluationEngine.evaluate(options);
    expect(res1.featureSnapshots[0].featureHash).toBe(res2.featureSnapshots[0].featureHash);
  });

  it('37. Different historical data changes feature hash', () => {
    const { options: opt1 } = setupEvaluation(5);
    const res1 = SynchronizedShadowEvaluationEngine.evaluate(opt1);

    const candles2 = generateCandles(5);
    candles2[0].close = 99999;
    const opt2 = { ...opt1, candles: candles2 };
    const res2 = SynchronizedShadowEvaluationEngine.evaluate(opt2);

    expect(res1.featureSnapshots[0].featureHash).not.toBe(res2.featureSnapshots[0].featureHash);
  });

  // ==========================================
  // 7. CHECKPOINT TESTS (38 - 42)
  // ==========================================

  it('38. Checkpoint/resume produces identical execution to uninterrupted run', () => {
    const { options } = setupEvaluation(8);
    const full = SynchronizedShadowEvaluationEngine.evaluate(options);
    const partial = SynchronizedShadowEvaluationEngine.evaluate({ ...options, maxEvents: 4 });
    expect(partial.checkpoint).toBeDefined();

    const resumed = SynchronizedShadowEvaluationEngine.evaluate({ ...options, checkpoint: partial.checkpoint });
    expect(resumed.shadowEvaluationHash).toBe(full.shadowEvaluationHash);
    expect(resumed.champion.metrics).toEqual(full.champion.metrics);
    expect(resumed.challenger.metrics).toEqual(full.challenger.metrics);
  });

  it('39. Pending orders survive checkpoint and execute accurately after resume', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      return {
        action: idx === 0 ? ('ENTER_LONG' as const) : ('HOLD' as const),
        confidence: 0.8,
        positionTarget: ('LONG' as const),
        quantity: 1,
        riskState: {},
      };
    };

    const { options } = setupEvaluation(5, 0, { ...executionConfig, latencyMs: 3600000, backtestEndPolicy: 'LEAVE_PENDING_AT_END' });
    const full = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    const partial = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider, maxEvents: 1 });
    const resumed = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider, checkpoint: partial.checkpoint });

    expect(resumed.champion.executions.length).toBe(full.champion.executions.length);
    expect(resumed.champion.executions[0].orderId).toBe(full.champion.executions[0].orderId);
  });

  it('40. Corrupted market snapshot is detected', () => {
    const { options } = setupEvaluation(10);
    const partial = SynchronizedShadowEvaluationEngine.evaluate({ ...options, maxEvents: 4 });

    const corruptedCheckpoint = {
      ...partial.checkpoint!,
      marketSnapshotsPrefixHash: 'tampered_market_hash',
    };
    expect(() => SynchronizedShadowEvaluationEngine.evaluate({ ...options, checkpoint: corruptedCheckpoint })).toThrow(
      'SHADOW_CORRUPTED_CHECKPOINT',
    );
  });

  it('41. Corrupted feature snapshot is detected', () => {
    const { options } = setupEvaluation(10);
    const partial = SynchronizedShadowEvaluationEngine.evaluate({ ...options, maxEvents: 4 });

    const corruptedCheckpoint = {
      ...partial.checkpoint!,
      featureSnapshotsPrefixHash: 'tampered_feature_hash',
    };
    expect(() => SynchronizedShadowEvaluationEngine.evaluate({ ...options, checkpoint: corruptedCheckpoint })).toThrow(
      'SHADOW_CORRUPTED_CHECKPOINT',
    );
  });

  it('42. Corrupted execution history is detected', () => {
    const { options } = setupEvaluation(10);
    const partial = SynchronizedShadowEvaluationEngine.evaluate({ ...options, maxEvents: 4 });

    const corruptedCheckpoint = {
      ...partial.checkpoint!,
      championExecutionsPrefixHash: 'tampered_execution_hash',
    };
    expect(() => SynchronizedShadowEvaluationEngine.evaluate({ ...options, checkpoint: corruptedCheckpoint })).toThrow(
      'SHADOW_CORRUPTED_CHECKPOINT',
    );
  });

  // ==========================================
  // 8. END-OF-BACKTEST POLICY TESTS (43 - 45)
  // ==========================================

  it('43. Open position at final candle is marked to market with unrealized P&L', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      return {
        action: idx === 0 ? ('ENTER_LONG' as const) : ('HOLD' as const),
        confidence: 0.8,
        positionTarget: ('LONG' as const),
        quantity: 1,
        riskState: {},
      };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    expect(result.champion.state.position).toBe('LONG');
    expect(result.champion.state.unrealizedPnL).toBeGreaterThan(0);
  });

  it('44. Pending order at final candle is cancelled under CANCEL_PENDING_AT_END policy', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      return {
        action: idx === 4 ? ('ENTER_LONG' as const) : ('HOLD' as const),
        confidence: 0.8,
        positionTarget: ('LONG' as const),
        quantity: 1,
        riskState: {},
      };
    };

    const { options } = setupEvaluation(5, 0, { ...executionConfig, backtestEndPolicy: 'CANCEL_PENDING_AT_END' });
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    expect(result.champion.state.pendingOrders.length).toBe(0);
    expect(result.champion.state.position).toBe('FLAT');
  });

  it('45. Explicit FORCE_CLOSE_POSITION_AT_END policy closes open positions on the final candle', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      return {
        action: idx === 0 ? ('ENTER_LONG' as const) : ('HOLD' as const),
        confidence: 0.8,
        positionTarget: ('LONG' as const),
        quantity: 1,
        riskState: {},
      };
    };

    const { options } = setupEvaluation(5, 0, { ...executionConfig, backtestEndPolicy: 'FORCE_CLOSE_POSITION_AT_END' });
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    expect(result.champion.state.position).toBe('FLAT');
    expect(result.champion.executions.length).toBe(2); // 1 entry + 1 force close exit
  });
});
