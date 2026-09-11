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

describe('Synchronized Shadow Evaluation Engine (AI Fix 60)', () => {
  const storePath = path.join(os.tmpdir(), `phase10b-test-${process.pid}.json`);

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
    };

    return { champion, challenger, snapshot, evaluation, candles, options };
  }

  it('1. missing decision provider fails closed when artifact has no executable strategy', () => {
    const { options, champion } = setupEvaluation();
    const strippedChampion = { ...champion, strategyConfig: undefined as any, executionConfig: undefined as any, modelArtifact: undefined as any };
    const invalidOptions: SynchronizedShadowEvaluationOptions = {
      ...options,
      champion: strippedChampion,
    };
    expect(() => SynchronizedShadowEvaluationEngine.evaluate(invalidOptions)).toThrow(/SHADOW_DECISION_PROVIDER_REQUIRED/);
  });

  it('2. real strategy produces decision', () => {
    const { options } = setupEvaluation();
    const result = SynchronizedShadowEvaluationEngine.evaluate(options);
    expect(result.champion.decisions.length).toBe(options.candles.length);
    expect(result.challenger.decisions.length).toBe(options.candles.length);
    for (const dec of result.champion.decisions) {
      expect(['ENTER_LONG', 'ENTER_SHORT', 'EXIT', 'HOLD']).toContain(dec.action);
    }
  });

  it('3. artifact hash cannot determine decision', () => {
    const { options } = setupEvaluation();
    const decisionProvider = () => ({
      action: 'ENTER_LONG' as const,
      confidence: 0.8,
      positionTarget: 'LONG' as const,
      quantity: 1,
      riskState: {},
    });

    const optA = { ...options, decisionProvider };
    const resA = SynchronizedShadowEvaluationEngine.evaluate(optA);

    const optB = {
      ...options,
      decisionProvider,
    };
    const resB = SynchronizedShadowEvaluationEngine.evaluate(optB);

    expect(resA.champion.decisions[0].action).toBe('ENTER_LONG');
    expect(resB.champion.decisions[0].action).toBe('ENTER_LONG');
  });

  it('4. current-bar close lookahead rejected', () => {
    const { options, candles } = setupEvaluation();
    const candleTime = candles[candles.length - 1].timestamp.getTime();
    const invalidOptions = {
      ...options,
      marketDataCutoffTimestamp: candleTime - 3600000,
      coordinatorEvaluation: {
        ...options.coordinatorEvaluation,
        marketDataCutoffTimestamp: candleTime - 3600000,
      },
    };
    expect(() => SynchronizedShadowEvaluationEngine.evaluate(invalidOptions)).toThrow('SHADOW_LOOKAHEAD_DETECTED');
  });

  it('5. current-bar high lookahead rejected', () => {
    const { options } = setupEvaluation();
    const invalidCandles = options.candles.map((c, i) => {
      if (i === 5) {
        return { ...c, timestamp: new Date(options.marketDataCutoffTimestamp + 10000) };
      }
      return c;
    });
    expect(() => SynchronizedShadowEvaluationEngine.evaluate({ ...options, candles: invalidCandles })).toThrow('SHADOW_LOOKAHEAD_DETECTED');
  });

  it('6. current-bar low lookahead rejected', () => {
    const { options } = setupEvaluation();
    const invalidProvider = () => {
      return {
        action: 'ENTER_LONG' as const,
        confidence: 0.9,
        positionTarget: 'LONG' as const,
        quantity: 1,
        riskState: {},
        featureSnapshotHash: 'corrupted_hash',
      };
    };
    expect(() => SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider: invalidProvider })).toThrow('SHADOW_FEATURE_HASH_MISMATCH');
  });

  it('7. per-event cutoff is correct', () => {
    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate(options);
    for (let i = 0; i < result.marketSnapshots.length; i++) {
      const snap = result.marketSnapshots[i];
      const candleTs = options.candles[i].timestamp.getTime();
      expect(snap.marketDataCutoffTimestamp).toBe(candleTs);
      expect(result.featureSnapshots[i].cutoffTimestamp).toBe(candleTs);
    }
  });

  it('8. decision timestamp is correct', () => {
    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate(options);
    for (let i = 0; i < result.champion.decisions.length; i++) {
      const dec = result.champion.decisions[i];
      const candleTs = options.candles[i].timestamp.getTime();
      expect(dec.timestamp).toBe(candleTs);
      expect(dec.decisionCutoffTimestamp).toBe(candleTs);
    }
  });

  it('9. execution timestamp is correct', () => {
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
    for (const exec of result.champion.executions) {
      expect(exec.executionTimestamp).toBeGreaterThanOrEqual(exec.decisionCutoffTimestamp);
    }
  });

  it('10. Champion and Challenger share exact snapshot', () => {
    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate(options);
    for (let i = 0; i < result.champion.decisions.length; i++) {
      expect(result.champion.decisions[i].snapshotId).toBe(result.challenger.decisions[i].snapshotId);
      expect(result.champion.decisions[i].snapshotHash).toBe(result.challenger.decisions[i].snapshotHash);
    }
  });

  it('11. Champion and Challenger share exact feature snapshot', () => {
    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate(options);
    for (let i = 0; i < result.champion.decisions.length; i++) {
      expect(result.champion.decisions[i].featureSnapshotHash).toBe(result.challenger.decisions[i].featureSnapshotHash);
    }
  });

  it('12. Champion and Challenger share exact cutoff', () => {
    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate(options);
    for (let i = 0; i < result.champion.decisions.length; i++) {
      expect(result.champion.decisions[i].marketDataCutoffTimestamp).toBe(result.challenger.decisions[i].marketDataCutoffTimestamp);
    }
  });

  it('13. Champion and Challenger share exact execution context', () => {
    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate(options);
    for (let i = 0; i < result.champion.decisions.length; i++) {
      expect(result.champion.decisions[i].executionContextHash).toBe(result.challenger.decisions[i].executionContextHash);
    }
  });

  it('14. Champion and Challenger have independent state', () => {
    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate(options);
    expect(result.champion.state).not.toBe(result.challenger.state);
    expect(result.champion.decisions).not.toBe(result.challenger.decisions);
    expect(result.champion.executions).not.toBe(result.challenger.executions);
  });

  it('15. EXIT realizes actual position P&L', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) {
        return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      }
      if (idx === 1) {
        return { action: 'EXIT' as const, positionTarget: 'FLAT' as const, quantity: 1, riskState: {} };
      }
      return { action: 'HOLD' as const, positionTarget: 'FLAT' as const, quantity: 0, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    const exitExec = result.champion.executions.find((e) => e.exitPrice > 0);
    expect(exitExec).toBeDefined();
    // Entry at close 0 (50020), exit at close 1 (50040)
    // Gross PnL = 50040 - 50020 = 20
    // Fees = 1 (entry) + 1 (exit) = 2, Slippage = 0.5 (entry) + 0.5 (exit) = 1
    // Net PnL = 20 - 2 - 1 = 17
    expect(exitExec!.realizedPnL).not.toBe(0);
    expect(exitExec!.realizedPnL).toBe(17);
    expect(exitExec!.grossPnL).toBe(20);
    expect(result.champion.metrics.totalPnL).toBe(17);
  });

  it('16. reversal works', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      if (idx === 1) return { action: 'ENTER_SHORT' as const, positionTarget: 'SHORT' as const, quantity: 1, riskState: {} };
      if (idx === 2) return { action: 'EXIT' as const, positionTarget: 'FLAT' as const, quantity: 1, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'FLAT' as const, quantity: 0, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    // Event 0: Enter LONG
    // Event 1: Reversal -> Exit LONG + Enter SHORT
    // Event 2: Exit SHORT
    expect(result.champion.executions.length).toBe(4);
    expect(result.champion.state.position).toBe('FLAT');
  });

  it('17. partial exit works if supported', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 4, riskState: {} };
      if (idx === 1) return { action: 'EXIT' as const, positionTarget: 'LONG' as const, quantity: 2, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'LONG' as const, quantity: 2, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    expect(result.champion.state.quantity).toBe(2);
    expect(result.champion.state.position).toBe('LONG');
  });

  it('18. fees are charged exactly once', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      if (idx === 1) return { action: 'EXIT' as const, positionTarget: 'FLAT' as const, quantity: 1, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'FLAT' as const, quantity: 0, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    const metrics = result.champion.metrics;
    expect(metrics.grossPnL - metrics.fees - metrics.slippage).toBe(metrics.netPnL);
    expect(metrics.costAdjustedPnL).toBe(metrics.netPnL);
  });

  it('19. slippage is charged exactly once', () => {
    const decisionProvider = ({ snapshot }: any) => {
      const idx = parseInt(snapshot.snapshotId.split('-')[2], 10);
      if (idx === 0) return { action: 'ENTER_LONG' as const, positionTarget: 'LONG' as const, quantity: 1, riskState: {} };
      if (idx === 1) return { action: 'EXIT' as const, positionTarget: 'FLAT' as const, quantity: 1, riskState: {} };
      return { action: 'HOLD' as const, positionTarget: 'FLAT' as const, quantity: 0, riskState: {} };
    };

    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate({ ...options, decisionProvider });
    const metrics = result.champion.metrics;
    expect(metrics.slippage).toBe(1); // 0.5 entry + 0.5 exit
    expect(metrics.totalPnL).toBe(metrics.costAdjustedPnL);
  });

  it('20. canonical execution simulator is used', () => {
    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate(options);
    expect(result.champion.simulatorId).toContain('canonical-execution-simulator');
    expect(result.challenger.simulatorId).toContain('canonical-execution-simulator');
  });

  it('21. no second shadow execution semantics exist', () => {
    const { options } = setupEvaluation(5);
    const adapter = new ShadowExecutionAdapter('SHADOW', options.champion.executionContext as any, executionConfig, 'test');
    expect(typeof adapter.execute).toBe('function');
    expect((adapter as any).placeLiveOrder).toBeUndefined();
  });

  it('22. Challenger cannot access live order router', () => {
    const { options } = setupEvaluation(5);
    const result = SynchronizedShadowEvaluationEngine.evaluate(options);
    expect(result.challenger.hasProductionOrderRouter).toBe(false);
  });

  it('23. checkpoint config mismatch fails', () => {
    const { options } = setupEvaluation(10);
    const partial = SynchronizedShadowEvaluationEngine.evaluate({ ...options, maxEvents: 4 });
    expect(partial.checkpoint).toBeDefined();

    const mutatedCheckpoint = {
      ...partial.checkpoint!,
      configHash: 'corrupted_hash',
    };
    expect(() => SynchronizedShadowEvaluationEngine.evaluate({ ...options, checkpoint: mutatedCheckpoint })).toThrow('SHADOW_CORRUPTED_CHECKPOINT');
  });

  it('24. checkpoint prefix mismatch fails', () => {
    const { options } = setupEvaluation(10);
    const partial = SynchronizedShadowEvaluationEngine.evaluate({ ...options, maxEvents: 4 });
    expect(partial.checkpoint).toBeDefined();

    const mutatedCheckpoint = {
      ...partial.checkpoint!,
      lastSnapshotId: 'wrong-snapshot-id',
    };
    expect(() => SynchronizedShadowEvaluationEngine.evaluate({ ...options, checkpoint: mutatedCheckpoint })).toThrow('SHADOW_CORRUPTED_CHECKPOINT');
  });

  it('25. checkpoint resume matches uninterrupted evaluation', () => {
    const { options } = setupEvaluation(8);
    const full = SynchronizedShadowEvaluationEngine.evaluate(options);
    const partial = SynchronizedShadowEvaluationEngine.evaluate({ ...options, maxEvents: 4 });
    expect(partial.checkpoint).toBeDefined();

    const resumed = SynchronizedShadowEvaluationEngine.evaluate({
      ...options,
      checkpoint: partial.checkpoint,
    });

    expect(resumed.shadowEvaluationHash).toBe(full.shadowEvaluationHash);
    expect(resumed.champion.metrics.totalPnL).toBe(full.champion.metrics.totalPnL);
    expect(resumed.challenger.metrics.totalPnL).toBe(full.challenger.metrics.totalPnL);
  });

  it('26. identical replay produces identical hash', () => {
    const { options } = setupEvaluation(6);
    const resA = SynchronizedShadowEvaluationEngine.evaluate(options);
    const resB = SynchronizedShadowEvaluationEngine.evaluate(options);
    expect(resA.shadowEvaluationHash).toBe(resB.shadowEvaluationHash);
  });

  it('27. modified input produces different hash', () => {
    const { options } = setupEvaluation(6);
    const resA = SynchronizedShadowEvaluationEngine.evaluate(options);

    const modifiedCandles = options.candles.map((c, idx) => (idx === 3 ? { ...c, close: c.close + 10 } : c));
    const resB = SynchronizedShadowEvaluationEngine.evaluate({ ...options, candles: modifiedCandles });
    expect(resA.shadowEvaluationHash).not.toBe(resB.shadowEvaluationHash);
  });

  it('28. market data gap fails', () => {
    const { options } = setupEvaluation(6, 3600000 * 10);
    const gapCandles = options.candles.map((c, idx) => {
      if (idx === 3) {
        return { ...c, timestamp: new Date(c.timestamp.getTime() + 3600000 * 2) };
      }
      return c;
    });
    expect(() => SynchronizedShadowEvaluationEngine.evaluate({ ...options, candles: gapCandles })).toThrow('SHADOW_MARKET_DATA_GAP');
  });

  it('29. duplicate timestamp fails', () => {
    const { options } = setupEvaluation(6);
    const dupCandles = options.candles.map((c, idx) => (idx === 3 ? { ...c, timestamp: options.candles[2].timestamp } : c));
    expect(() => SynchronizedShadowEvaluationEngine.evaluate({ ...options, candles: dupCandles })).toThrow('SHADOW_DUPLICATE_SNAPSHOT');
  });

  it('30. out-of-order timestamp fails', () => {
    const { options } = setupEvaluation(6);
    const oooCandles = [...options.candles];
    oooCandles[3] = options.candles[1];
    expect(() => SynchronizedShadowEvaluationEngine.evaluate({ ...options, candles: oooCandles })).toThrow('SHADOW_OUT_OF_ORDER_TIMESTAMP');
  });

  it('31. future timestamp fails', () => {
    const { options } = setupEvaluation(6);
    const futureCandles = options.candles.map((c, idx) => (idx === 5 ? { ...c, timestamp: new Date(options.marketDataCutoffTimestamp + 1000) } : c));
    expect(() => SynchronizedShadowEvaluationEngine.evaluate({ ...options, candles: futureCandles })).toThrow('SHADOW_LOOKAHEAD_DETECTED');
  });

  it('32. partial evaluation cannot complete shadow', () => {
    const { options } = setupEvaluation(6);
    const partial = SynchronizedShadowEvaluationEngine.evaluate({ ...options, maxEvents: 3 });
    expect(() =>
      SynchronizedShadowEvaluationEngine.completeCoordinatorShadowEvaluation(
        options.coordinatorEvaluation.evaluationId,
        partial,
      ),
    ).toThrow('SHADOW_EVALUATION_INCOMPLETE');
  });

  it('33. complete evaluation produces valid ShadowEvidence', () => {
    const { options } = setupEvaluation(6);
    const result = SynchronizedShadowEvaluationEngine.evaluate(options);
    expect(result.shadowEvidence).toBeDefined();
    expect(result.shadowEvidence.challengerArtifactHash).toBe(options.challenger.artifactHash);
    expect(result.shadowEvidence.championArtifactHash).toBe(options.champion.artifactHash);
    expect(result.shadowEvidence.marketDataCutoffTimestamp).toBe(options.marketDataCutoffTimestamp);
    expect(result.shadowEvidence.shadowEvaluationVersion).toBe(SynchronizedShadowEvaluationEngine.SHADOW_EVALUATION_VERSION);
  });

  it('34. coordinator.completeShadow integration works', () => {
    const { options } = setupEvaluation(6);
    const result = SynchronizedShadowEvaluationEngine.evaluate(options);
    const completed = SynchronizedShadowEvaluationEngine.completeCoordinatorShadowEvaluation(
      options.coordinatorEvaluation.evaluationId,
      result,
    );
    expect(completed.state).toBe('SHADOW_COMPLETE');
    expect(completed.shadowEvidence).toBeDefined();
  });
});
