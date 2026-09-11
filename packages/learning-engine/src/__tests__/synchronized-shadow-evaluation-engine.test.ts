import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ICandle } from '@quant/shared';
import { CandidateArtifactBuilder } from '../candidate-artifact-builder';
import {
  ChampionChallengerCoordinator,
} from '../champion-challenger';
import { ModelRegistry } from '../model-registry';
import {
  SynchronizedShadowEvaluationEngine,
  SynchronizedShadowEvaluationOptions,
  ShadowExecutionConfig,
  ShadowExecutionAdapter,
  ShadowDecision,
} from '../synchronized-shadow-evaluation-engine';
import { StrategyCandidate } from '../types';

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

describe('Synchronized Shadow Evaluation Engine (AI Fix 61)', () => {
  const storePath = path.join(os.tmpdir(), `phase10b-fix61-test-${process.pid}.json`);

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

  function setupEvaluation(candlesCount = 10, cutoffOffset = 0) {
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
      executionConfig,
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

  it('1. current-bar fill is rejected when execution violates arrival causality', () => {
    const { options } = setupEvaluation(5);
    const adapter = new ShadowExecutionAdapter('PAPER', options.champion.executionContext as any, executionConfig, 'test-adapter');
    const snapshot = {
      snapshotId: 'snap-1',
      snapshotHash: 'hash-1',
      symbol: 'BTCUSDT',
      timeframe: '1h',
      marketDataCutoffTimestamp: 1000,
      source: 'binance',
      datasetHash: 'ds-1',
      dataVersion: '1.0',
      candleIds: ['1'],
      featureSnapshotHash: 'feat-1',
      executionContextHash: options.champion.executionContextHash,
      executionContextVersion: options.champion.executionContextVersion,
      candle: { timestamp: new Date(1000), open: 100, high: 105, low: 95, close: 102, volume: 10 },
    };

    // Decision claiming to execute in the past before decisionCutoff
    const invalidDecision: ShadowDecision = {
      decisionId: 'dec-1',
      timestamp: 900,
      decisionCutoffTimestamp: 1000,
      action: 'ENTER_LONG',
      symbol: 'BTCUSDT',
      timeframe: '1h',
      positionTarget: 'LONG',
      quantity: 1,
      riskState: {},
      featureSnapshotHash: 'feat-1',
      snapshotId: 'snap-1',
      snapshotHash: 'hash-1',
      marketDataCutoffTimestamp: 1000,
      executionContextHash: options.champion.executionContextHash,
    };

    expect(() => adapter.execute(invalidDecision, snapshot)).toThrow('SHADOW_LOOKAHEAD_DETECTED');
  });

  it('2. next-bar fill is accepted', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      return {
        action: idx === 0 ? ('ENTER_LONG' as const) : idx === 1 ? ('EXIT' as const) : ('HOLD' as const),
        confidence: 0.8,
        positionTarget: idx === 0 ? ('LONG' as const) : ('FLAT' as const),
        quantity: 1,
        riskState: {},
      };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    expect(result.champion.executions.length).toBe(2);
    expect(result.champion.executions[0].executionTimestamp).toBeGreaterThanOrEqual(
      result.champion.executions[0].orderArrivalTimestamp,
    );
    expect(result.champion.executions[1].executionTimestamp).toBeGreaterThanOrEqual(
      result.champion.executions[1].orderArrivalTimestamp,
    );
  });

  it('3. latency is respected (orderArrivalTimestamp = submissionTimestamp + latencyMs)', () => {
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
    const exec = result.champion.executions[0];
    expect(exec.orderArrivalTimestamp).toBe(exec.orderSubmissionTimestamp + 15);
  });

  it('4. execution timestamp is after order arrival', () => {
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
    const exec = result.champion.executions[0];
    expect(exec.executionTimestamp).toBeGreaterThanOrEqual(exec.orderArrivalTimestamp);
  });

  it('5. no-fill does not become fallback fill', () => {
    const { options } = setupEvaluation(5);
    const adapter = new ShadowExecutionAdapter('PAPER', options.champion.executionContext as any, executionConfig, 'test-adapter');
    const snapshot = {
      snapshotId: 'snap-1',
      snapshotHash: 'hash-1',
      symbol: 'BTCUSDT',
      timeframe: '1h',
      marketDataCutoffTimestamp: 1000,
      source: 'binance',
      datasetHash: 'ds-1',
      dataVersion: '1.0',
      candleIds: ['1'],
      featureSnapshotHash: 'feat-1',
      executionContextHash: options.champion.executionContextHash,
      executionContextVersion: options.champion.executionContextVersion,
      candle: { timestamp: new Date(1000), open: 100, high: 105, low: 95, close: 102, volume: 10 },
    };

    const holdDecision: ShadowDecision = {
      decisionId: 'dec-1',
      timestamp: 1000,
      decisionCutoffTimestamp: 1000,
      action: 'HOLD',
      symbol: 'BTCUSDT',
      timeframe: '1h',
      positionTarget: 'FLAT',
      quantity: 0,
      riskState: {},
      featureSnapshotHash: 'feat-1',
      snapshotId: 'snap-1',
      snapshotHash: 'hash-1',
      marketDataCutoffTimestamp: 1000,
      executionContextHash: options.champion.executionContextHash,
    };

    const results = adapter.execute(holdDecision, snapshot);
    expect(results.length).toBe(0);
  });

  it('6. full exit cost allocation', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      if (idx === 1) return { action: 'EXIT' as const, positionTarget: 'FLAT' as const, quantity: 1, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'FLAT' as const, quantity: 0, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    const exitExec = result.champion.executions.find((e) => e.exitPrice > 0);
    expect(exitExec).toBeDefined();
    expect(exitExec!.fees).toBe(2); // 1 entry + 1 exit
    expect(exitExec!.slippage).toBe(1); // 0.5 entry + 0.5 exit
    expect(result.champion.state.remainingEntryFees).toBe(0);
    expect(result.champion.state.remainingEntrySlippage).toBe(0);
  });

  it('7. 50% partial exit cost allocation', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 4, riskState: {} };
      if (idx === 1) return { action: 'EXIT' as const, positionTarget: 'LONG' as const, quantity: 2, riskState: {} };
      if (idx === 2) return { action: 'EXIT' as const, positionTarget: 'FLAT' as const, quantity: 2, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'FLAT' as const, quantity: 0, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    const exits = result.champion.executions.filter((e) => e.exitPrice > 0);
    expect(exits.length).toBe(2);

    // Initial entry: fee 1, slippage 0.5
    // Exit 1 (50%): allocated entry fee 0.5 + exit fee 1 = 1.5. allocated entry slip 0.25 + exit slip 0.5 = 0.75
    expect(exits[0].fees).toBe(1.5);
    expect(exits[0].slippage).toBe(0.75);

    // Exit 2 (remaining 50%): remaining entry fee 0.5 + exit fee 1 = 1.5. remaining slip 0.25 + exit slip 0.5 = 0.75
    expect(exits[1].fees).toBe(1.5);
    expect(exits[1].slippage).toBe(0.75);

    // Total allocated entry costs equal original entry costs (1 and 0.5)
    const totalAllocatedEntryFees = exits[0].fees - 1 + (exits[1].fees - 1);
    const totalAllocatedEntrySlippage = exits[0].slippage - 0.5 + (exits[1].slippage - 0.5);
    expect(totalAllocatedEntryFees).toBe(1);
    expect(totalAllocatedEntrySlippage).toBe(0.5);
  });

  it('8. multiple partial exits (25% + 25% + 50%)', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 4, riskState: {} };
      if (idx === 1) return { action: 'EXIT' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      if (idx === 2) return { action: 'EXIT' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      if (idx === 3) return { action: 'EXIT' as const, positionTarget: 'FLAT' as const, quantity: 2, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'FLAT' as const, quantity: 0, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    const exits = result.champion.executions.filter((e) => e.exitPrice > 0);
    expect(exits.length).toBe(3);

    // Entry costs: fee = 1, slippage = 0.5
    // Exit 1 (1/4): allocated fee = 0.25, slip = 0.125
    // Exit 2 (1/3 of rem 3 = 1): allocated fee = 0.25, slip = 0.125
    // Exit 3 (rem 2): allocated fee = 0.5, slip = 0.25
    const totalAllocatedEntryFees = exits[0].fees - 1 + (exits[1].fees - 1) + (exits[2].fees - 1);
    const totalAllocatedEntrySlippage = exits[0].slippage - 0.5 + (exits[1].slippage - 0.5) + (exits[2].slippage - 0.5);
    expect(totalAllocatedEntryFees).toBeCloseTo(1, 6);
    expect(totalAllocatedEntrySlippage).toBeCloseTo(0.5, 6);
  });

  it('9. reversal atomicity (one closed trade + one new position)', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      if (idx === 1) return { action: 'ENTER_SHORT' as const, positionTarget: 'SHORT' as const, quantity: 1, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'SHORT' as const, quantity: 1, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    // Event 0: Enter LONG
    // Event 1: Reversal -> Close LONG + Enter SHORT
    expect(result.champion.executions.length).toBe(3);
    expect(result.champion.state.position).toBe('SHORT');
    expect(result.champion.state.quantity).toBe(1);
    expect(result.champion.state.closedTrades.length).toBe(1);
  });

  it('10. reversal P&L', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      if (idx === 1) return { action: 'ENTER_SHORT' as const, positionTarget: 'SHORT' as const, quantity: 1, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'SHORT' as const, quantity: 1, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    const closedLong = result.champion.executions[1];
    expect(closedLong.exitPrice).toBeGreaterThan(0);
    // Entry at 50020, exit at 50040. Gross PnL = 20, fee = 2, slip = 1 -> Net = 17
    expect(closedLong.realizedPnL).toBe(17);
  });

  it('11. reversal fees', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      if (idx === 1) return { action: 'ENTER_SHORT' as const, positionTarget: 'SHORT' as const, quantity: 1, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'SHORT' as const, quantity: 1, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    const closedLong = result.champion.executions[1];
    const newShort = result.champion.executions[2];
    expect(closedLong.fees).toBe(2); // entry + exit
    expect(newShort.fees).toBe(1); // new entry
  });

  it('12. reversal slippage', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      if (idx === 1) return { action: 'ENTER_SHORT' as const, positionTarget: 'SHORT' as const, quantity: 1, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'SHORT' as const, quantity: 1, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    const closedLong = result.champion.executions[1];
    const newShort = result.champion.executions[2];
    expect(closedLong.slippage).toBe(1); // 0.5 entry + 0.5 exit
    expect(newShort.slippage).toBe(0.5); // new entry
  });

  it('13. incomplete artifact configuration fails with SHADOW_INCOMPLETE_ARTIFACT_CONFIGURATION', () => {
    const { options, champion } = setupEvaluation(5);
    const incompleteArtifact = {
      ...champion,
      strategyConfig: { scoringWeights: undefined as any, strategyMode: undefined as any },
      modelArtifact: undefined as any,
    };
    expect(() => SynchronizedShadowEvaluationEngine.evaluate({ ...options, champion: incompleteArtifact })).toThrow(
      'SHADOW_INCOMPLETE_ARTIFACT_CONFIGURATION',
    );
  });

  it('14. feature pipeline hash is bound in FeatureSnapshot and ShadowEvidence', () => {
    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate(options);
    for (const snap of result.featureSnapshots) {
      expect(snap.featurePipelineVersion).toBe('canonical-feature-pipeline-v2');
      expect(snap.featureSchemaHash).toBeDefined();
      expect(snap.canonicalMLFeatureHash).toBeDefined();
    }
    expect(result.shadowEvidence.shadowEvaluationVersion).toBe(SynchronizedShadowEvaluationEngine.SHADOW_EVALUATION_VERSION);
  });

  it('15. ML feature vector hash is bound', () => {
    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate(options);
    expect(result.featureSnapshots[0].canonicalMLFeatureHash).toBeDefined();
  });

  it('16. maxDrawdownR uses risk unit (maxDrawdown / riskUnit)', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_SHORT' as const, positionTarget: 'SHORT' as const, quantity: 1, riskState: {} };
      if (idx === 1) return { action: 'EXIT' as const, positionTarget: 'FLAT' as const, quantity: 1, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'FLAT' as const, quantity: 0, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    const metrics = result.champion.metrics;
    // Loss: Entry SHORT at 50020, Exit at 50040. Gross = -20, Fees = 2, Slip = 1 -> Net = -23
    // MaxDrawdown = 23. Risk unit = 100000 * 0.01 = 1000
    // MaxDrawdownR = 23 / 1000 = 0.023
    expect(metrics.maxDrawdown).toBe(23);
    expect(metrics.maxDrawdownR).toBe(0.023);
  });

  it('17. turnover includes both sides (entry + exit notional)', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      if (idx === 1) return { action: 'EXIT' as const, positionTarget: 'FLAT' as const, quantity: 1, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'FLAT' as const, quantity: 0, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    const metrics = result.champion.metrics;
    // Entry at 50020 (qty 1) + Exit at 50040 (qty 1) = 100060 turnover
    expect(metrics.turnover).toBe(100060);
  });

  it('18. partial exit turnover', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 4, riskState: {} };
      if (idx === 1) return { action: 'EXIT' as const, positionTarget: 'LONG' as const, quantity: 2, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'LONG' as const, quantity: 2, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    const metrics = result.champion.metrics;
    // Entry: 4 * 50020 = 200080
    // Partial Exit: 2 * 50040 = 100080
    // Total = 300160
    expect(metrics.turnover).toBe(300160);
  });

  it('19. reversal turnover', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      if (idx === 1) return { action: 'ENTER_SHORT' as const, positionTarget: 'SHORT' as const, quantity: 1, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'SHORT' as const, quantity: 1, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    const metrics = result.champion.metrics;
    // Entry LONG: 1 * 50020 = 50020
    // Exit LONG: 1 * 50040 = 50040
    // Entry SHORT: 1 * 50040 = 50040
    // Total = 150100
    expect(metrics.turnover).toBe(150100);
  });

  it('20. checkpoint decision prefix integrity', () => {
    const { options } = setupEvaluation(10);
    const partial = SynchronizedShadowEvaluationEngine.evaluate({ ...options, maxEvents: 4 });
    expect(partial.checkpoint).toBeDefined();

    const corruptedCheckpoint = {
      ...partial.checkpoint!,
      championDecisionsPrefixHash: 'tampered_prefix_hash',
    };
    expect(() => SynchronizedShadowEvaluationEngine.evaluate({ ...options, checkpoint: corruptedCheckpoint })).toThrow(
      'SHADOW_CORRUPTED_CHECKPOINT',
    );
  });

  it('21. checkpoint execution prefix integrity', () => {
    const { options } = setupEvaluation(10);
    const partial = SynchronizedShadowEvaluationEngine.evaluate({ ...options, maxEvents: 4 });
    expect(partial.checkpoint).toBeDefined();

    const corruptedCheckpoint = {
      ...partial.checkpoint!,
      championExecutionsPrefixHash: 'tampered_execution_hash',
    };
    expect(() => SynchronizedShadowEvaluationEngine.evaluate({ ...options, checkpoint: corruptedCheckpoint })).toThrow(
      'SHADOW_CORRUPTED_CHECKPOINT',
    );
  });

  it('22. checkpoint feature prefix integrity', () => {
    const { options } = setupEvaluation(10);
    const partial = SynchronizedShadowEvaluationEngine.evaluate({ ...options, maxEvents: 4 });
    expect(partial.checkpoint).toBeDefined();

    const corruptedCheckpoint = {
      ...partial.checkpoint!,
      featureSnapshotsPrefixHash: 'tampered_feature_hash',
    };
    expect(() => SynchronizedShadowEvaluationEngine.evaluate({ ...options, checkpoint: corruptedCheckpoint })).toThrow(
      'SHADOW_CORRUPTED_CHECKPOINT',
    );
  });

  it('23. identical uninterrupted/resumed results', () => {
    const { options } = setupEvaluation(8);
    const full = SynchronizedShadowEvaluationEngine.evaluate(options);
    const partial = SynchronizedShadowEvaluationEngine.evaluate({ ...options, maxEvents: 4 });

    const resumed = SynchronizedShadowEvaluationEngine.evaluate({
      ...options,
      checkpoint: partial.checkpoint,
    });

    expect(resumed.shadowEvaluationHash).toBe(full.shadowEvaluationHash);
    expect(resumed.champion.metrics.totalPnL).toBe(full.champion.metrics.totalPnL);
    expect(resumed.challenger.metrics.totalPnL).toBe(full.challenger.metrics.totalPnL);
    expect(resumed.champion.metrics.turnover).toBe(full.champion.metrics.turnover);
  });

  it('24. canonical simulator controls fill price', () => {
    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate(options);
    expect(result.champion.simulatorId).toContain('canonical-execution-simulator');
  });

  it('25. no synthetic fill path exists', () => {
    const { options } = setupEvaluation(5);
    const adapter = new ShadowExecutionAdapter('SHADOW', options.champion.executionContext as any, executionConfig, 'test');
    expect((adapter as any).createFallbackFill).toBeUndefined();
    expect((adapter as any).defaultFill).toBeUndefined();
  });

  it('26. no synthetic decision path exists', () => {
    const { options, champion } = setupEvaluation(5);
    const strippedArtifact = {
      ...champion,
      strategyConfig: undefined as any,
      modelArtifact: undefined as any,
      executionConfig: undefined as any,
    };
    expect(() => SynchronizedShadowEvaluationEngine.evaluate({ ...options, champion: strippedArtifact })).toThrow(
      'SHADOW_INCOMPLETE_ARTIFACT_CONFIGURATION',
    );
  });
});
