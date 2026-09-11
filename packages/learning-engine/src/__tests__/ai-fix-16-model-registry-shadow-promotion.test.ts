import * as fs from 'fs';
import * as path from 'path';
import { ICandle } from '@quant/shared';
import {
  CandidateArtifact,
  CandidateMarketDataset,
  PromotionDecision,
  PromotionEvidence,
  PromotionGateInput,
  PromotionPolicy,
  ShadowEvaluationMetrics,
  ShadowEvaluationResult,
  ShadowEvaluationWindow,
  StrategyCandidate,
} from '../types';
import { ITrainedModelArtifact } from '../model-trainer';
import { CandidateBacktestRunner } from '../candidate-backtest-runner';
import { ModelRegistry } from '../model-registry';
import { ShadowEvaluator } from '../shadow-evaluator';
import { PromotionGate } from '../promotion-gate';
import { ProductionModelActivator } from '../production-model-activator';
import { TemporalFeatureScaler } from '../feature-scaler';
import { DatasetManager } from '../dataset-manager';
import { LearningEngine } from '../learning-engine';
import { ExperienceStore } from '../experience-store';

function generateContinuousCandles(
  startTimestamp: number,
  count: number = 50,
  intervalMs: number = 900000,
): ICandle[] {
  const candles: ICandle[] = [];
  for (let i = 0; i < count; i++) {
    const t = startTimestamp + i * intervalMs;
    const base = 100 + Math.sin(i * 0.2) * 5;
    candles.push({
      timestamp: new Date(t),
      open: base,
      high: base + 1.5,
      low: base - 1.5,
      close: base + 0.5,
      volume: 1000 + i * 10,
    });
  }
  return candles;
}

function createDummyModelArtifact(): ITrainedModelArtifact {
  return {
    modelId: 'model_dummy_1',
    modelVersion: 'v2.1-model',
    modelHash: 'dummy_model_hash_123',
    weights: [0.5, 0.3, -0.2],
    bias: 0.1,
    featureSchemaVersion: '2.0',
    featureSchemaHash: 'dummy_feature_schema_hash_123',
    sampleCount: 200,
    trainLoss: 0.15,
    trainedAt: new Date(1700000000000),
  };
}

function createDummyCandidate(id = 'cand-test-1'): StrategyCandidate {
  const model = createDummyModelArtifact();
  const scaler = new TemporalFeatureScaler();
  return {
    id,
    candidateVersion: 'v2.1-test',
    baseStrategyVersion: 'v2.0-smc-quant',
    type: 'FILTER',
    description: 'Test Strategy Candidate',
    change: {
      component: 'ENTRY_FILTER',
      type: 'PARAM_TWEAK',
      before: { minConfidence: 0.6 },
      after: { minConfidence: 0.75 },
      rationale: 'Improve win rate and reduce drawdown',
      modelArtifact: model,
      scalerArtifact: { scalerParameters: scaler.getParameters() } as any,
      selectedFeatures: ['fvgSize', 'obStrength', 'rsi14'],
      minMtfScore: 70,
      stopLossAtrMultiplier: 1.0,
      sizingMultiplier: 1.0,
      fillModel: 'OHLC_PATH',
      ambiguityMode: 'CONSERVATIVE',
      latencyMs: 50,
      trainingDatasetHash: 'hash_train_exp_default',
      datasetHash: 'hash_mkt_dev_default',
      symbol: 'BTCUSDT',
      riskConfig: {
        initialCapital: 100000,
        maxRiskPerTrade: 0.01,
        partialExitPolicy: {
          tp1Ratio: 0.33,
          tp2Ratio: 0.33,
          tp3Ratio: 0.34,
          moveStopToBreakevenOnTp1: true,
          trailStopOnTp2: true,
          trailStopOffsetR: 1.0,
        },
      },
    },
    evidence: {
      sampleSize: 100,
      expectancyBefore: 0.1,
      expectancyAfterHistorical: 0.45,
      pValue: 0.01,
    },
    status: 'TRAINED',
    createdAt: new Date(1700000000000),
  };
}

function createSampleMetrics(overrides: Partial<ShadowEvaluationMetrics> = {}): ShadowEvaluationMetrics {
  return {
    totalTrades: 20,
    wins: 12,
    losses: 8,
    winRate: 60.0,
    grossPnL: 300,
    netPnL: 250,
    pnlR: 5.0,
    profitFactor: 1.8,
    maxDrawdown: 50,
    maxDrawdownR: 1.5,
    expectancy: 0.45,
    averageR: 0.25,
    medianR: 0.20,
    largestLoss: -20,
    largestWin: 45,
    fees: 10,
    slippage: 5,
    observationsCount: 100,
    ...overrides,
  };
}

describe('AI Fix 16 — Model Registry, Independent Shadow Evaluation, & Promotion Gate', () => {
  const testArtifactDir = path.join(__dirname, 'test_artifacts_fix16');

  beforeEach(() => {
    ModelRegistry.clear();
    ExperienceStore.clear();
    if (fs.existsSync(testArtifactDir)) {
      fs.rmSync(testArtifactDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testArtifactDir)) {
      fs.rmSync(testArtifactDir, { recursive: true, force: true });
    }
  });

  describe('1. CandidateArtifact Deterministic Cryptographic Content-Addressing & Integrity', () => {
    it('creates a fully hashed CandidateArtifact with deterministic sub-hashes and artifactHash', () => {
      const candidate = createDummyCandidate('cand-101');

      const artifact = CandidateBacktestRunner.createCandidateArtifact(
        candidate,
        'hash_mkt_dev_999',
        42,
        {
          trainingDatasetHash: 'hash_train_exp_123',
          validationDatasetHash: 'hash_val_exp_456',
          oosDatasetHash: 'hash_oos_exp_789',
          marketDatasetHash: 'hash_mkt_dev_999',
          createdBy: 'TestRunner',
        },
      );

      expect(artifact.candidateId).toBe('cand-101');
      expect(artifact.artifactHash).toBeDefined();
      expect(artifact.artifactHash.length).toBe(64);
      expect(artifact.modelHash).toBeDefined();
      expect(artifact.scalerHash).toBeDefined();
      expect(artifact.featureSchemaHash).toBeDefined();
      expect(artifact.selectedFeatureHash).toBeDefined();
      expect(artifact.status).toBe('TRAINED');

      // Validate integrity
      const validation = CandidateBacktestRunner.validateArtifactIntegrity(artifact);
      expect(validation.isValid).toBe(true);
      expect(validation.reason).toBeUndefined();
    });

    it('ensures zero fake fallback strings (no_scaler, no_model, all_features) in candidate artifacts', () => {
      const candidate: StrategyCandidate = {
        id: 'cand-clean-prov',
        candidateVersion: 'v2.0',
        baseStrategyVersion: 'v2.0',
        type: 'FILTER',
        description: 'Clean provenance candidate',
        symbol: 'BTCUSDT',
        riskConfig: {
          initialCapital: 100000,
          maxRiskPerTrade: 0.01,
          partialExitPolicy: {
            tp1Ratio: 0.33,
            tp2Ratio: 0.33,
            tp3Ratio: 0.34,
            moveStopToBreakevenOnTp1: true,
            trailStopOnTp2: true,
            trailStopOffsetR: 1.0,
          },
        },
        change: {
          component: 'ENTRY_FILTER',
          type: 'PARAM_TWEAK',
          minMtfScore: 70,
          stopLossAtrMultiplier: 1.0,
          sizingMultiplier: 1.0,
          fillModel: 'OHLC_PATH',
          ambiguityMode: 'CONSERVATIVE',
          latencyMs: 50,
          symbol: 'BTCUSDT',
        },
        evidence: { sampleSize: 10, expectancyBefore: 0, expectancyAfterHistorical: 0 },
        status: 'GENERATED',
        createdAt: new Date(),
      };

      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'm_hash');
      expect(artifact.scalerHash).not.toBe('no_scaler');
      expect(artifact.modelHash).not.toBe('no_model');
      expect(artifact.selectedFeatures).not.toContain('all_features');
      expect(artifact.scalerHash).toBe('none');
      expect(artifact.modelHash).toBe('none');
      expect(artifact.artifactHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('generates identical artifactHash given identical contents (deterministic reproducibility)', () => {
      const candidateA = createDummyCandidate('cand-determ');
      const candidateB = createDummyCandidate('cand-determ');

      const artifactA = CandidateBacktestRunner.createCandidateArtifact(
        candidateA,
        'mkt_hash_1',
        42,
        {
          trainingDatasetHash: 'train_hash_1',
          validationDatasetHash: 'val_hash_1',
          oosDatasetHash: 'oos_hash_1',
          marketDatasetHash: 'mkt_hash_1',
        },
      );

      const artifactB = CandidateBacktestRunner.createCandidateArtifact(
        candidateB,
        'mkt_hash_1',
        42,
        {
          trainingDatasetHash: 'train_hash_1',
          validationDatasetHash: 'val_hash_1',
          oosDatasetHash: 'oos_hash_1',
          marketDatasetHash: 'mkt_hash_1',
        },
      );

      expect(artifactA.artifactHash).toBe(artifactB.artifactHash);
      expect(artifactA.modelHash).toBe(artifactB.modelHash);
      expect(artifactA.scalerHash).toBe(artifactB.scalerHash);
    });

    it('detects tampering with model weights and fails closed', () => {
      const candidate = createDummyCandidate('cand-tamper-model');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'm_hash');

      // Tamper model weights
      const tamperedArtifact: CandidateArtifact = {
        ...artifact,
        modelArtifact: {
          ...(artifact.modelArtifact as any),
          weights: [999.9, 888.8],
        },
      };

      const result = CandidateBacktestRunner.validateArtifactIntegrity(tamperedArtifact);
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('MODEL_HASH_MISMATCH');
    });

    it('detects tampering with scaler state and fails closed', () => {
      const candidate = createDummyCandidate('cand-tamper-scaler');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'm_hash');

      // Tamper scaler state
      const tamperedArtifact: CandidateArtifact = {
        ...artifact,
        scalerArtifact: {
          ...(artifact.scalerArtifact as any),
          scalerParameters: {
            fvgSize: { mean: 9999, std: 1, min: 0, max: 10 },
          },
        },
      };

      const result = CandidateBacktestRunner.validateArtifactIntegrity(tamperedArtifact);
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('SCALER_HASH_MISMATCH');
    });

    it('detects tampering with parameters or config and fails closed on artifactHash verification', () => {
      const candidate = createDummyCandidate('cand-tamper-params');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'm_hash');

      // Tamper strategyConfig
      const tamperedArtifact: CandidateArtifact = {
        ...artifact,
        strategyConfig: {
          ...artifact.strategyConfig,
          tamperedParam: true,
        },
      };

      const result = CandidateBacktestRunner.validateArtifactIntegrity(tamperedArtifact);
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('ARTIFACT_HASH_MISMATCH');
    });
  });

  describe('2. ModelRegistry Lifecycle, Inherent Persistence, & State Machine', () => {
    it('registers candidate artifact, prevents duplicates, auto-persists to disk, and logs registration event', () => {
      fs.mkdirSync(testArtifactDir, { recursive: true });
      const persistPath = path.join(testArtifactDir, 'auto-registry.json');
      ModelRegistry.setPersistencePath(persistPath);

      const candidate = createDummyCandidate('cand-reg-1');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'm_hash');

      const registered = ModelRegistry.registerCandidateArtifact(artifact);
      expect(registered.candidateId).toBe('cand-reg-1');

      // Verify file was written to disk automatically
      expect(fs.existsSync(persistPath)).toBe(true);

      // Duplicate registration must throw
      expect(() => ModelRegistry.registerCandidateArtifact(artifact)).toThrow('DUPLICATE_CANDIDATE_ARTIFACT');

      // Verify retrieval
      const fetched = ModelRegistry.getCandidateArtifact('cand-reg-1');
      expect(fetched).toBeDefined();
      expect(fetched?.candidateId).toBe('cand-reg-1');

      // Verify retrieval by artifactHash
      const fetchedByHash = ModelRegistry.getByArtifactHash(artifact.artifactHash);
      expect(fetchedByHash).toBeDefined();
      expect(fetchedByHash?.candidateId).toBe('cand-reg-1');

      // Verify audit events
      const events = ModelRegistry.getEventHistory('cand-reg-1');
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].eventType).toBe('CANDIDATE_REGISTERED');
    });

    it('manages candidate status transitions and logs lifecycle audit events', () => {
      const candidate = createDummyCandidate('cand-lifecycle-1');
      candidate.status = 'SHADOW_PENDING';
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'm_hash');

      ModelRegistry.registerCandidateArtifact(artifact);

      // Transition to SHADOW_ACTIVE
      const active = ModelRegistry.updateCandidateStatus('cand-lifecycle-1', 'SHADOW_ACTIVE', 'Started live shadow trading');
      expect(active.status).toBe('SHADOW_ACTIVE');

      // Transition to PROMOTION_ELIGIBLE
      const eligible = ModelRegistry.updateCandidateStatus(
        'cand-lifecycle-1',
        'PROMOTION_ELIGIBLE',
        'Completed shadow period with positive expectancy',
      );
      expect(eligible.status).toBe('PROMOTION_ELIGIBLE');

      const history = ModelRegistry.getEventHistory('cand-lifecycle-1');
      expect(history.length).toBe(3); // REGISTERED -> SHADOW_STARTED -> PROMOTION_ELIGIBLE
      expect(history[1].eventType).toBe('SHADOW_STARTED');
      expect(history[2].eventType).toBe('PROMOTION_ELIGIBLE');
    });

    it('persists and hydrates model registry state to and from JSON file', () => {
      fs.mkdirSync(testArtifactDir, { recursive: true });
      const persistPath = path.join(testArtifactDir, 'model-registry.json');

      const candidate = createDummyCandidate('cand-persist-1');
      candidate.status = 'SHADOW_ACTIVE';
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'm_hash');

      ModelRegistry.registerCandidateArtifact(artifact);
      ModelRegistry.saveToFile(persistPath);

      expect(fs.existsSync(persistPath)).toBe(true);

      // Clear memory and rehydrate
      ModelRegistry.clear();
      expect(ModelRegistry.getCandidateArtifact('cand-persist-1')).toBeUndefined();

      ModelRegistry.loadFromFile(persistPath);
      const restored = ModelRegistry.getCandidateArtifact('cand-persist-1');
      expect(restored).toBeDefined();
      expect(restored?.candidateId).toBe('cand-persist-1');
      expect(restored?.status).toBe('SHADOW_ACTIVE');
    });
  });

  describe('3. Independent Shadow Evaluator & Temporal Non-Overlap', () => {
    const oosEndTs = 1700000000000;
    const shadowStartTs = oosEndTs + 900000; // 1 bar after OOS end
    const shadowEndTs = shadowStartTs + 50 * 900000;

    it('fails closed when shadow window overlaps with OOS window (temporal leakage violation)', () => {
      const candidate = createDummyCandidate('cand-shadow-overlap');
      const overlappingWindow: ShadowEvaluationWindow = {
        candidateId: 'cand-shadow-overlap',
        marketDatasetHash: 'dummy_hash',
        startTimestamp: oosEndTs - 1000, // OVERLAPPING WITH OOS END
        endTimestamp: shadowEndTs,
        minimumObservations: 10,
        minimumTrades: 5,
      };

      const candles = generateContinuousCandles(overlappingWindow.startTimestamp, 40, 900000);
      const datasetHash = DatasetManager.requireCanonicalMarketDatasetHash(candles, '15m');
      const marketDataset: CandidateMarketDataset = {
        executionCandles: candles,
        datasetHash,
        timeframe: '15m',
        symbol: 'BTCUSDT',
        startTimestamp: overlappingWindow.startTimestamp,
        endTimestamp: overlappingWindow.endTimestamp,
        isContinuous: true,
        expectedIntervalMs: 900000,
      };

      const result = ShadowEvaluator.evaluateShadowWindow(candidate, {
        marketDataset,
        shadowWindow: overlappingWindow,
        oosEndTimestamp: oosEndTs,
      });

      expect(result.passed).toBe(false);
      expect(result.rejectionReason).toContain('SHADOW_WINDOW_OVERLAP');
      expect(result.shadowDatasetHash).toBe(datasetHash);
    });

    it('executes candidate strategy deterministically over independent shadow market data with authoritative provenance', () => {
      const candidate = createDummyCandidate('cand-shadow-clean');
      const candles = generateContinuousCandles(shadowStartTs, 60, 900000);
      const datasetHash = DatasetManager.requireCanonicalMarketDatasetHash(candles, '15m');

      const shadowWindow: ShadowEvaluationWindow = {
        candidateId: 'cand-shadow-clean',
        marketDatasetHash: datasetHash,
        startTimestamp: shadowStartTs,
        endTimestamp: shadowEndTs,
        minimumObservations: 30,
        minimumTrades: 5,
      };

      const marketDataset: CandidateMarketDataset = {
        executionCandles: candles,
        datasetHash,
        timeframe: '15m',
        symbol: 'BTCUSDT',
        startTimestamp: shadowStartTs,
        endTimestamp: shadowEndTs,
        isContinuous: true,
        expectedIntervalMs: 900000,
      };

      const shadowResult = ShadowEvaluator.evaluateShadowWindow(candidate, {
        marketDataset,
        shadowWindow,
        oosEndTimestamp: oosEndTs,
      });

      expect(shadowResult.candidateId).toBe('cand-shadow-clean');
      expect(shadowResult.shadowDatasetHash).toBe(datasetHash);
      expect(shadowResult.shadowStartTimestamp).toBe(shadowStartTs);
      expect(shadowResult.shadowEndTimestamp).toBe(shadowEndTs);
      expect(shadowResult.metrics.observationsCount).toBeGreaterThanOrEqual(30);
      expect(typeof shadowResult.metrics.totalTrades).toBe('number');
      expect(typeof shadowResult.metrics.profitFactor).toBe('number');
      expect(typeof shadowResult.metrics.expectancy).toBe('number');
      expect(typeof shadowResult.metrics.maxDrawdown).toBe('number');
      expect(typeof shadowResult.metrics.winRate).toBe('number');
    });
  });

  describe('4. Promotion Gate Contract & Stored Promotion Evidence', () => {
    const policy: PromotionPolicy = {
      minimumShadowObservations: 50,
      minimumShadowTrades: 10,
      minimumProfitFactor: 1.25,
      minimumExpectancyR: 0.15,
      maximumDrawdownR: 3.0,
      minimumWinRate: 45.0,
      requirePositiveNetPnl: true,
      requireIndependentShadowWindow: true,
      allowAutoPromotion: true,
    };

    it('approves candidate, transitions status to PROMOTION_ELIGIBLE, and stores authoritative PromotionEvidence', () => {
      const candidate = createDummyCandidate('cand-pass-1');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'm_hash');
      ModelRegistry.registerCandidateArtifact(artifact);
      ModelRegistry.updateCandidateStatus('cand-pass-1', 'OOS_VALIDATED');
      ModelRegistry.updateCandidateStatus('cand-pass-1', 'SHADOW_ACTIVE');

      const shadowResult: ShadowEvaluationResult = {
        candidateId: 'cand-pass-1',
        passed: true,
        metrics: createSampleMetrics({
          observationsCount: 100,
          totalTrades: 25,
          netPnL: 500,
          profitFactor: 1.85,
          expectancy: 0.45,
          maxDrawdownR: 1.2,
          winRate: 60.0,
        }),
        reasons: [],
        window: {
          candidateId: 'cand-pass-1',
          marketDatasetHash: 'm_hash',
          startTimestamp: 1700000000000,
          endTimestamp: 1700050000000,
          minimumObservations: 50,
          minimumTrades: 10,
        },
        shadowDatasetHash: 'm_hash',
        shadowStartTimestamp: 1700000000000,
        shadowEndTimestamp: 1700050000000,
        evaluatedAt: Date.now(),
      };

      const input: PromotionGateInput = {
        candidateArtifact: artifact,
        shadowResult,
        policy,
      };

      const decision = PromotionGate.evaluatePromotion(input);
      expect(decision.decision).toBe('PROMOTE');
      expect(decision.evidenceId).toBeDefined();

      // Verify PromotionEvidence was persisted in registry
      const storedEvidence = ModelRegistry.getPromotionEvidence('cand-pass-1');
      expect(storedEvidence).toBeDefined();
      expect(storedEvidence?.evidenceId).toBe(decision.evidenceId);
      expect(storedEvidence?.shadowDatasetHash).toBe('m_hash');
      expect(storedEvidence?.shadowWindowStart).toBe(1700000000000);
      expect(storedEvidence?.shadowWindowEnd).toBe(1700050000000);

      // Verify candidate transitioned to PROMOTION_ELIGIBLE
      expect(ModelRegistry.getCandidateArtifact('cand-pass-1')?.status).toBe('PROMOTION_ELIGIBLE');
    });

    it('rejects candidate with explicit reasons if any criteria fails and transitions status to REJECTED', () => {
      const candidate = createDummyCandidate('cand-fail-1');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'm_hash');
      ModelRegistry.registerCandidateArtifact(artifact);
      ModelRegistry.updateCandidateStatus('cand-fail-1', 'OOS_VALIDATED');
      ModelRegistry.updateCandidateStatus('cand-fail-1', 'SHADOW_ACTIVE');

      const failingShadowResult: ShadowEvaluationResult = {
        candidateId: 'cand-fail-1',
        passed: true,
        metrics: createSampleMetrics({
          observationsCount: 20, // Failed (< 50)
          totalTrades: 5, // Failed (< 10)
          netPnL: -50,
          profitFactor: 0.8, // Failed (< 1.25)
          expectancy: -0.2, // Failed (< 0.15)
          maxDrawdownR: 5.0, // Failed (> 3.0)
          winRate: 30.0, // Failed (< 45.0)
        }),
        reasons: [],
        window: {
          candidateId: 'cand-fail-1',
          marketDatasetHash: 'm_hash',
          startTimestamp: 1700000000000,
          endTimestamp: 1700050000000,
          minimumObservations: 50,
          minimumTrades: 10,
        },
        shadowDatasetHash: 'm_hash',
        shadowStartTimestamp: 1700000000000,
        shadowEndTimestamp: 1700050000000,
        evaluatedAt: Date.now(),
      };

      const input: PromotionGateInput = {
        candidateArtifact: artifact,
        shadowResult: failingShadowResult,
        policy,
      };

      const decision = PromotionGate.evaluatePromotion(input);
      expect(decision.decision).toBe('REJECT');
      expect(decision.rejectionReasons?.length).toBeGreaterThanOrEqual(5);
      expect(decision.rejectionReasons?.some((r: string) => r.includes('INSUFFICIENT_SHADOW_OBSERVATIONS'))).toBe(true);
      expect(decision.rejectionReasons?.some((r: string) => r.includes('INSUFFICIENT_SHADOW_TRADES'))).toBe(true);
      expect(decision.rejectionReasons?.some((r: string) => r.includes('PROFIT_FACTOR_BELOW_THRESHOLD'))).toBe(true);
      expect(decision.rejectionReasons?.some((r: string) => r.includes('EXPECTANCY_BELOW_THRESHOLD'))).toBe(true);
      expect(decision.rejectionReasons?.some((r: string) => r.includes('DRAWDOWN_ABOVE_LIMIT'))).toBe(true);

      // Verify candidate transitioned to REJECTED
      expect(ModelRegistry.getCandidateArtifact('cand-fail-1')?.status).toBe('REJECTED');
    });

    it('rejects when allowAutoPromotion is false and records AUTO_PROMOTION_DISABLED while setting PROMOTION_ELIGIBLE', () => {
      const manualOnlyPolicy: PromotionPolicy = {
        ...policy,
        allowAutoPromotion: false,
      };

      const candidate = createDummyCandidate('cand-manual-1');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'm_hash');
      ModelRegistry.registerCandidateArtifact(artifact);
      ModelRegistry.updateCandidateStatus('cand-manual-1', 'OOS_VALIDATED');
      ModelRegistry.updateCandidateStatus('cand-manual-1', 'SHADOW_ACTIVE');

      const shadowResult: ShadowEvaluationResult = {
        candidateId: 'cand-manual-1',
        passed: true,
        metrics: createSampleMetrics({
          observationsCount: 100,
          totalTrades: 25,
          netPnL: 500,
          profitFactor: 2.0,
          expectancy: 0.5,
          maxDrawdownR: 1.0,
          winRate: 65.0,
        }),
        reasons: [],
        window: {
          candidateId: 'cand-manual-1',
          marketDatasetHash: 'm_hash',
          startTimestamp: 1700000000000,
          endTimestamp: 1700050000000,
          minimumObservations: 50,
          minimumTrades: 10,
        },
        shadowDatasetHash: 'm_hash',
        shadowStartTimestamp: 1700000000000,
        shadowEndTimestamp: 1700050000000,
        evaluatedAt: Date.now(),
      };

      const input: PromotionGateInput = {
        candidateArtifact: artifact,
        shadowResult,
        policy: manualOnlyPolicy,
      };

      const decision = PromotionGate.evaluatePromotion(input);
      expect(decision.decision).toBe('REJECT');
      expect(decision.rejectionReasons?.some((r: string) => r.includes('AUTO_PROMOTION_DISABLED'))).toBe(true);
      expect(ModelRegistry.getCandidateArtifact('cand-manual-1')?.status).toBe('PROMOTION_ELIGIBLE');
    });
  });

  describe('5. ProductionModelActivator Transactional Activation, Status Gating, & Rollback', () => {
    const policy: PromotionPolicy = {
      minimumShadowObservations: 50,
      minimumShadowTrades: 10,
      minimumProfitFactor: 1.25,
      minimumExpectancyR: 0.15,
      maximumDrawdownR: 3.0,
      minimumWinRate: 45.0,
      requirePositiveNetPnl: true,
      requireIndependentShadowWindow: true,
      allowAutoPromotion: true,
    };

    it('refuses activation if candidate is not in PROMOTION_ELIGIBLE state', () => {
      const candidate = createDummyCandidate('cand-not-eligible');
      candidate.status = 'SHADOW_ACTIVE';
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'm_hash');
      ModelRegistry.registerCandidateArtifact(artifact);

      const decision: PromotionDecision = {
        candidateId: 'cand-not-eligible',
        decision: 'PROMOTE',
        policyVersion: 'v2.0',
        reasons: [],
        metrics: createSampleMetrics(),
        evaluatedAt: Date.now(),
      };

      expect(() => {
        ProductionModelActivator.activateCandidate({
          candidateId: 'cand-not-eligible',
          promotionDecision: decision,
          policy,
        });
      }).toThrow('INVALID_CANDIDATE_STATUS');
    });

    it('refuses activation if promotion evidence is missing or decision was not PROMOTE', () => {
      const candidate = createDummyCandidate('cand-no-evidence');
      candidate.status = 'PROMOTION_ELIGIBLE';
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'm_hash');
      ModelRegistry.registerCandidateArtifact(artifact);

      const decision: PromotionDecision = {
        candidateId: 'cand-no-evidence',
        decision: 'PROMOTE',
        policyVersion: 'v2.0',
        reasons: [],
        metrics: createSampleMetrics(),
        evaluatedAt: Date.now(),
      };

      expect(() => {
        ProductionModelActivator.activateCandidate({
          candidateId: 'cand-no-evidence',
          promotionDecision: decision,
          policy,
        });
      }).toThrow('PROMOTION_EVIDENCE_NOT_FOUND');
    });

    it('atomically activates approved candidate in PROMOTION_ELIGIBLE state and verifies evidence', () => {
      // 1. Setup and evaluate Candidate A
      const candA = createDummyCandidate('cand-prod-A');
      const artifactA = CandidateBacktestRunner.createCandidateArtifact(candA, 'm_hash');
      ModelRegistry.registerCandidateArtifact(artifactA);
      ModelRegistry.updateCandidateStatus('cand-prod-A', 'OOS_VALIDATED');
      ModelRegistry.updateCandidateStatus('cand-prod-A', 'SHADOW_ACTIVE');

      const shadowResultA: ShadowEvaluationResult = {
        candidateId: 'cand-prod-A',
        passed: true,
        metrics: createSampleMetrics({
          observationsCount: 100,
          totalTrades: 20,
          netPnL: 100,
          profitFactor: 1.8,
          expectancy: 0.4,
          maxDrawdownR: 1.5,
          winRate: 60.0,
        }),
        reasons: [],
        window: {
          candidateId: 'cand-prod-A',
          marketDatasetHash: 'm_hash',
          startTimestamp: 1700000000000,
          endTimestamp: 1700050000000,
          minimumObservations: 50,
          minimumTrades: 10,
        },
        shadowDatasetHash: 'm_hash',
        shadowStartTimestamp: 1700000000000,
        shadowEndTimestamp: 1700050000000,
        evaluatedAt: Date.now(),
      };

      const decisionA = PromotionGate.evaluatePromotion({
        candidateArtifact: artifactA,
        shadowResult: shadowResultA,
        policy,
      });

      // Activate Candidate A
      const prodStateA = ProductionModelActivator.activateCandidate({
        candidateId: 'cand-prod-A',
        promotionDecision: decisionA,
        policy,
      });

      expect(prodStateA.activeCandidateId).toBe('cand-prod-A');
      expect(prodStateA.activeArtifactHash).toBe(artifactA.artifactHash);
      expect(ModelRegistry.getCandidateArtifact('cand-prod-A')?.status).toBe('PROMOTED');

      // 2. Setup and evaluate Candidate B
      const candB = createDummyCandidate('cand-prod-B');
      const artifactB = CandidateBacktestRunner.createCandidateArtifact(candB, 'm_hash');
      ModelRegistry.registerCandidateArtifact(artifactB);
      ModelRegistry.updateCandidateStatus('cand-prod-B', 'OOS_VALIDATED');
      ModelRegistry.updateCandidateStatus('cand-prod-B', 'SHADOW_ACTIVE');

      const shadowResultB: ShadowEvaluationResult = {
        candidateId: 'cand-prod-B',
        passed: true,
        metrics: createSampleMetrics({
          observationsCount: 120,
          totalTrades: 25,
          netPnL: 200,
          profitFactor: 2.1,
          expectancy: 0.55,
          maxDrawdownR: 1.2,
          winRate: 65.0,
        }),
        reasons: [],
        window: {
          candidateId: 'cand-prod-B',
          marketDatasetHash: 'm_hash',
          startTimestamp: 1700000000000,
          endTimestamp: 1700050000000,
          minimumObservations: 50,
          minimumTrades: 10,
        },
        shadowDatasetHash: 'm_hash',
        shadowStartTimestamp: 1700000000000,
        shadowEndTimestamp: 1700050000000,
        evaluatedAt: Date.now(),
      };

      const decisionB = PromotionGate.evaluatePromotion({
        candidateArtifact: artifactB,
        shadowResult: shadowResultB,
        policy,
      });

      // Activate Candidate B
      const prodStateB = ProductionModelActivator.activateCandidate({
        candidateId: 'cand-prod-B',
        promotionDecision: decisionB,
        policy,
      });

      expect(prodStateB.activeCandidateId).toBe('cand-prod-B');
      expect(prodStateB.previousCandidateId).toBe('cand-prod-A');
      expect(ModelRegistry.getCandidateArtifact('cand-prod-B')?.status).toBe('PROMOTED');
      expect(ModelRegistry.getCandidateArtifact('cand-prod-A')?.status).toBe('RETIRED');
    });

    it('performs immutable rollback restoring previous active model transactionally', () => {
      // Cand A activated then Cand B activated
      const candA = createDummyCandidate('cand-rb-A');
      const artifactA = CandidateBacktestRunner.createCandidateArtifact(candA, 'm_hash');
      ModelRegistry.registerCandidateArtifact(artifactA);
      ModelRegistry.updateCandidateStatus('cand-rb-A', 'OOS_VALIDATED');
      ModelRegistry.updateCandidateStatus('cand-rb-A', 'SHADOW_ACTIVE');

      const shadowResultA: ShadowEvaluationResult = {
        candidateId: 'cand-rb-A',
        passed: true,
        metrics: createSampleMetrics(),
        reasons: [],
        window: {
          candidateId: 'cand-rb-A',
          marketDatasetHash: 'm_hash',
          startTimestamp: 1700000000000,
          endTimestamp: 1700050000000,
          minimumObservations: 50,
          minimumTrades: 10,
        },
        shadowDatasetHash: 'm_hash',
        shadowStartTimestamp: 1700000000000,
        shadowEndTimestamp: 1700050000000,
        evaluatedAt: Date.now(),
      };

      const decisionA = PromotionGate.evaluatePromotion({
        candidateArtifact: artifactA,
        shadowResult: shadowResultA,
        policy,
      });

      ProductionModelActivator.activateCandidate({
        candidateId: 'cand-rb-A',
        promotionDecision: decisionA,
        policy,
      });

      const candB = createDummyCandidate('cand-rb-B');
      const artifactB = CandidateBacktestRunner.createCandidateArtifact(candB, 'm_hash');
      ModelRegistry.registerCandidateArtifact(artifactB);
      ModelRegistry.updateCandidateStatus('cand-rb-B', 'OOS_VALIDATED');
      ModelRegistry.updateCandidateStatus('cand-rb-B', 'SHADOW_ACTIVE');

      const shadowResultB: ShadowEvaluationResult = {
        candidateId: 'cand-rb-B',
        passed: true,
        metrics: createSampleMetrics(),
        reasons: [],
        window: {
          candidateId: 'cand-rb-B',
          marketDatasetHash: 'm_hash',
          startTimestamp: 1700000000000,
          endTimestamp: 1700050000000,
          minimumObservations: 50,
          minimumTrades: 10,
        },
        shadowDatasetHash: 'm_hash',
        shadowStartTimestamp: 1700000000000,
        shadowEndTimestamp: 1700050000000,
        evaluatedAt: Date.now(),
      };

      const decisionB = PromotionGate.evaluatePromotion({
        candidateArtifact: artifactB,
        shadowResult: shadowResultB,
        policy,
      });

      ProductionModelActivator.activateCandidate({
        candidateId: 'cand-rb-B',
        promotionDecision: decisionB,
        policy,
      });

      expect(ModelRegistry.getProductionState()?.activeCandidateId).toBe('cand-rb-B');

      // Execute Rollback
      const rollbackState = ProductionModelActivator.rollbackProduction({
        reason: 'Anomaly detected in live execution metrics',
      });

      expect(rollbackState.activeCandidateId).toBe('cand-rb-A');
      expect(rollbackState.previousCandidateId).toBe('cand-rb-B');
      expect(ModelRegistry.getCandidateArtifact('cand-rb-B')?.status).toBe('ROLLED_BACK');
      expect(ModelRegistry.getCandidateArtifact('cand-rb-A')?.status).toBe('REACTIVATED');
    });
  });

  describe('6. Decoupled LearningEngine Cycle Invariant', () => {
    it('verifies LearningEngine.runLearningCycle does NOT promote candidates in the same cycle', async () => {
      // Ingest experiences for learning cycle
      const baseTime = 1700000000000;
      for (let i = 0; i < 20; i++) {
        const t = baseTime + i * 900000;
        (ExperienceStore as any).experiences.set(`exp-${i}`, {
          id: `exp-${i}`,
          tradeId: `trade-${i}`,
          timestamp: new Date(t),
          decisionTimestamp: t,
          featureTimestamp: t,
          labelStartTimestamp: t + 1000,
          labelEndTimestamp: t + 900000,
          instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
          marketState: {
            smc: { orderBlocks: [], fairValueGaps: [], liquiditySweeps: [], bosStructures: [] } as any,
            quant: { fvgSize: 1.2, obStrength: 0.8, rsi14: 55 },
          },
          decision: { action: 'BUY', score: 0.8 },
          marketContext: { regime: 'TRENDING_BULLISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 } as any,
          strategyVersion: 'v2.0-smc-quant',
          risk: { stopLoss: 95 },
          prediction: { expectedR: 1.5 },
          execution: {
            entryPrice: 100,
            entryTime: new Date(t),
          },
          outcome: {
            status: i % 2 === 0 ? 'WIN' : 'LOSS',
            pnl: i % 2 === 0 ? 150 : -100,
            pnlR: i % 2 === 0 ? 1.5 : -1.0,
            maxFavorableExcursion: 1.8,
            maxAdverseExcursion: 0.2,
            holdingTimeSeconds: 3600,
          },
          outcomeClassification: 'CLEAN_WIN',
          reasons: [],
          failureReasons: [],
          label: i % 2 === 0 ? 1 : 0,
          labelBinary: i % 2 === 0 ? 1 : 0,
        });
      }

      const candles = generateContinuousCandles(baseTime, 60, 900000);

      const report = await LearningEngine.runLearningCycle({
        baseStrategyVersion: 'v2.0-smc-quant',
        autoPromote: true,
        candles,
      });

      // Candidates generated should NOT be promoted immediately
      expect(report.candidatesPromoted).toBe(0);

      // Verify that no production activation occurred during the learning cycle
      const events = ModelRegistry.getEventHistory();
      expect(events.every((e) => e.eventType !== 'PRODUCTION_ACTIVATED')).toBe(true);
    });
  });

  describe('7. Phase 3 Invariant Hardening: Mandatory Persistence, Deep Freeze, State Matrix & Legacy Disable', () => {
    const policy: PromotionPolicy = {
      minimumShadowObservations: 50,
      minimumShadowTrades: 10,
      minimumProfitFactor: 1.25,
      minimumExpectancyR: 0.15,
      maximumDrawdownR: 3.0,
      minimumWinRate: 50.0,
      requirePositiveNetPnl: true,
      requireIndependentShadowWindow: true,
      allowAutoPromotion: true,
    };

    beforeEach(() => {
      if (!fs.existsSync(testArtifactDir)) {
        fs.mkdirSync(testArtifactDir, { recursive: true });
      }
      ModelRegistry.setPersistencePath(path.join(testArtifactDir, 'model-registry.json'));
    });

    it('P0 #1: registration, activation, transactions, and promotion outcome recording strictly fail closed without persistence', () => {
      ModelRegistry.setPersistencePath(null);

      expect(() => {
        ModelRegistry.executeTransaction(() => {
          return 42;
        });
      }).toThrow('PERSISTENCE_NOT_CONFIGURED');

      // Candidate registration itself must fail closed without persistence
      const candidate = createDummyCandidate('cand-no-persist');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'mkt_hash');
      expect(() => {
        ModelRegistry.registerCandidateArtifact(artifact);
      }).toThrow('PERSISTENCE_NOT_CONFIGURED');
    });

    it('P0 #2: throws LEGACY_MODEL_PROMOTION_DISABLED and LEGACY_MODEL_ROLLBACK_DISABLED when legacy bypass methods are called', () => {
      expect(() => {
        ModelRegistry.promoteModel('v2.0-ml-canonical');
      }).toThrow('LEGACY_MODEL_PROMOTION_DISABLED');

      expect(() => {
        ModelRegistry.rollbackModel('v2.0-ml-canonical');
      }).toThrow('LEGACY_MODEL_ROLLBACK_DISABLED');
    });

    it('P1 #3: deeply freezes registered candidate artifacts against nested mutation', () => {
      const candidate = createDummyCandidate('cand-deep-freeze');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'mkt_hash');
      const registered = ModelRegistry.registerCandidateArtifact(artifact);

      expect(Object.isFrozen(registered)).toBe(true);
      expect(Object.isFrozen(registered.modelArtifact)).toBe(true);
      expect(Object.isFrozen(registered.strategyConfig)).toBe(true);
      expect(Object.isFrozen(registered.riskConfig)).toBe(true);
      expect(Object.isFrozen(registered.executionConfig)).toBe(true);
    });

    it('P1 #4: validates promotion evidence at the ModelRegistry boundary', () => {
      const candidate = createDummyCandidate('cand-ev-boundary');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'mkt_hash');
      ModelRegistry.registerCandidateArtifact(artifact);

      // Candidate not in registry must be rejected
      const evidenceForMissing: PromotionEvidence = {
        evidenceId: 'ev-missing',
        candidateId: 'non-existent-cand',
        artifactHash: 'dummy_hash',
        trainingDatasetHash: 'dummy_train',
        validationDatasetHash: 'dummy_val',
        oosDatasetHash: 'dummy_oos',
        shadowDatasetHash: 'shadow_hash_1',
        shadowWindowStart: 1700000000000,
        shadowWindowEnd: 1700050000000,
        shadowMetrics: createSampleMetrics(),
        promotionPolicyVersion: 'v2.0',
        promotionDecision: 'PROMOTE',
        decisionReasons: ['All thresholds passed'],
        evaluatedAt: Date.now(),
        executionContextHash: 'missing-context',
        executionContextVersion: '1.0',
      };

      expect(() => {
        ModelRegistry.savePromotionEvidence(evidenceForMissing);
      }).toThrow('INVALID_PROMOTION_EVIDENCE');

      const evidence: PromotionEvidence = {
        evidenceId: 'ev-valid-1',
        candidateId: 'cand-ev-boundary',
        artifactHash: artifact.artifactHash,
        trainingDatasetHash: artifact.trainingDatasetHash,
        validationDatasetHash: artifact.validationDatasetHash,
        oosDatasetHash: artifact.oosDatasetHash,
        shadowDatasetHash: 'shadow_hash_1',
        shadowWindowStart: 1700000000000,
        shadowWindowEnd: 1700050000000,
        shadowMetrics: createSampleMetrics(),
        promotionPolicyVersion: 'v2.0',
        promotionDecision: 'PROMOTE',
        decisionReasons: ['All thresholds passed'],
        evaluatedAt: Date.now(),
        executionContextHash: artifact.executionContextHash,
        executionContextVersion: artifact.executionContextVersion,
      };

      // Evidence with wrong artifactHash must be rejected
      expect(() => {
        ModelRegistry.savePromotionEvidence({
          ...evidence,
          artifactHash: 'wrong_tampered_hash',
        });
      }).toThrow('INVALID_PROMOTION_EVIDENCE');

      // Valid evidence succeeds
      expect(() => {
        ModelRegistry.savePromotionEvidence(evidence);
      }).not.toThrow();
    });

    it('P1 #5: strictly enforces state machine transition matrix in ModelRegistry.updateCandidateStatus', () => {
      const candidate = createDummyCandidate('cand-matrix');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'mkt_hash');
      ModelRegistry.registerCandidateArtifact(artifact);

      // Illegal: TRAINED -> PROMOTED directly
      expect(() => {
        ModelRegistry.updateCandidateStatus('cand-matrix', 'PROMOTED');
      }).toThrow('ILLEGAL_STATE_TRANSITION');

      // Illegal: TRAINED -> SHADOW_ACTIVE directly
      expect(() => {
        ModelRegistry.updateCandidateStatus('cand-matrix', 'SHADOW_ACTIVE');
      }).toThrow('ILLEGAL_STATE_TRANSITION');

      // Legal: TRAINED -> OOS_VALIDATED -> SHADOW_PENDING -> SHADOW_ACTIVE -> PROMOTION_ELIGIBLE -> PROMOTED
      expect(() => {
        ModelRegistry.updateCandidateStatus('cand-matrix', 'OOS_VALIDATED');
        ModelRegistry.updateCandidateStatus('cand-matrix', 'SHADOW_PENDING');
        ModelRegistry.updateCandidateStatus('cand-matrix', 'SHADOW_ACTIVE');
        ModelRegistry.updateCandidateStatus('cand-matrix', 'PROMOTION_ELIGIBLE');
        ModelRegistry.updateCandidateStatus('cand-matrix', 'PROMOTED');
      }).not.toThrow();

      // Legal: PROMOTED -> RETIRED
      expect(() => {
        ModelRegistry.updateCandidateStatus('cand-matrix', 'RETIRED');
      }).not.toThrow();

      // Illegal: RETIRED -> PROMOTED directly (must be REACTIVATED for unambiguous rollback audit trail)
      expect(() => {
        ModelRegistry.updateCandidateStatus('cand-matrix', 'PROMOTED');
      }).toThrow('ILLEGAL_STATE_TRANSITION');

      // Legal: RETIRED -> REACTIVATED
      expect(() => {
        ModelRegistry.updateCandidateStatus('cand-matrix', 'REACTIVATED');
      }).not.toThrow();
    });

    it('P1 #6: direct evidence mutation cannot bypass promotion lifecycle', () => {
      const candidate = createDummyCandidate('cand-ev-bypass');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'mkt_hash');
      ModelRegistry.registerCandidateArtifact(artifact);

      const evidence: PromotionEvidence = {
        evidenceId: 'ev-bypass-1',
        candidateId: 'cand-ev-bypass',
        artifactHash: artifact.artifactHash,
        trainingDatasetHash: artifact.trainingDatasetHash,
        validationDatasetHash: artifact.validationDatasetHash,
        oosDatasetHash: artifact.oosDatasetHash,
        shadowDatasetHash: 'shadow_hash_1',
        shadowWindowStart: 1700000000000,
        shadowWindowEnd: 1700050000000,
        shadowMetrics: createSampleMetrics(),
        promotionPolicyVersion: 'v2.0',
        promotionDecision: 'PROMOTE',
        decisionReasons: ['All thresholds passed'],
        evaluatedAt: Date.now(),
        executionContextHash: artifact.executionContextHash,
        executionContextVersion: artifact.executionContextVersion,
      };

      const invalidDecision: PromotionDecision = {
        decision: 'PROMOTE',
        candidateId: 'different-candidate-id',
        evidenceId: 'ev-bypass-1',
        evaluatedAt: Date.now(),
        metrics: createSampleMetrics(),
        policyVersion: 'v2.0',
        reasons: ['All metrics passed'],
      };

      expect(() => {
        ModelRegistry.recordPromotionOutcome('cand-ev-bypass', evidence, invalidDecision);
      }).toThrow('INVALID_PROMOTION_DECISION');
    });

    it('P1 #7: records promotion outcome in exactly one atomic persistence commit', () => {
      const candidate = createDummyCandidate('cand-single-commit');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'mkt_hash');
      ModelRegistry.registerCandidateArtifact(artifact);
      ModelRegistry.updateCandidateStatus('cand-single-commit', 'OOS_VALIDATED');
      ModelRegistry.updateCandidateStatus('cand-single-commit', 'SHADOW_ACTIVE');

      const shadowResult: ShadowEvaluationResult = {
        candidateId: 'cand-single-commit',
        passed: true,
        metrics: createSampleMetrics({ totalTrades: 25, profitFactor: 2.0, expectancy: 0.4 }),
        reasons: [],
        window: {
          candidateId: 'cand-single-commit',
          marketDatasetHash: 'mkt_hash',
          startTimestamp: 1700000000000,
          endTimestamp: 1700050000000,
          minimumObservations: 50,
          minimumTrades: 10,
        },
        shadowDatasetHash: 'mkt_hash',
        shadowStartTimestamp: 1700000000000,
        shadowEndTimestamp: 1700050000000,
        evaluatedAt: Date.now(),
      };

      const saveSpy = jest.spyOn(ModelRegistry as any, 'saveToFile');
      saveSpy.mockClear();

      PromotionGate.evaluatePromotion({
        candidateArtifact: artifact,
        shadowResult,
        policy,
      });

      // Exactly ONE persistence commit for the entire compound outcome
      expect(saveSpy).toHaveBeenCalledTimes(1);
      saveSpy.mockRestore();
    });

    it('P1 #8: loadFromFile authoritatively revalidates all artifacts, evidence, and production bindings, rejecting corrupt files', () => {
      const corruptFilePath = path.join(testArtifactDir, 'corrupt-registry.json');

      // Test 0: Missing mandatory top-level fields rejected
      fs.writeFileSync(corruptFilePath, JSON.stringify({}, null, 2), 'utf-8');
      expect(() => {
        ModelRegistry.loadFromFile(corruptFilePath);
      }).toThrow('MODEL_REGISTRY_CORRUPT');

      const unsupportedVersionData = {
        version: '1.0',
        artifacts: [],
        promotionEvidences: [],
        productionState: [],
        events: [],
        models: [],
        activeModelVersion: 'v2.0-ml-canonical',
      };
      fs.writeFileSync(corruptFilePath, JSON.stringify(unsupportedVersionData, null, 2), 'utf-8');
      expect(() => {
        ModelRegistry.loadFromFile(corruptFilePath);
      }).toThrow('MODEL_REGISTRY_CORRUPT');

      const partialData = {
        version: '2.0',
        artifacts: [],
        productionState: [],
        // missing promotionEvidences, events, models, activeModelVersion
      };
      fs.writeFileSync(corruptFilePath, JSON.stringify(partialData, null, 2), 'utf-8');
      expect(() => {
        ModelRegistry.loadFromFile(corruptFilePath);
      }).toThrow('MODEL_REGISTRY_CORRUPT');

      // Test 1: Tampered artifact hash rejected
      const tamperedArtifactData = {
        version: '2.0',
        artifacts: [
          [
            'cand-tampered-1',
            {
              candidateId: 'cand-tampered-1',
              artifactHash: 'wrong_tampered_hash_123',
              modelHash: 'hash_1',
              scalerHash: 'hash_2',
              featureSchemaHash: 'hash_3',
              selectedFeatureHash: 'hash_4',
              trainingDatasetHash: 'hash_5',
              validationDatasetHash: 'hash_6',
              oosDatasetHash: 'hash_7',
              marketDatasetHash: 'hash_8',
              status: 'PROMOTION_ELIGIBLE',
              createdAt: Date.now(),
              modelVersion: 'v2.1',
              strategyVersion: 'v2.0',
              featureSchemaVersion: 'v2.0',
              modelArtifact: { modelVersion: 'v2.1' },
              strategyConfig: { parameters: {} },
              riskConfig: {},
              executionConfig: {},
            },
          ],
        ],
        productionState: [],
        promotionEvidences: [],
        events: [],
        models: [],
        activeModelVersion: 'v2.0-ml-canonical',
      };

      fs.writeFileSync(corruptFilePath, JSON.stringify(tamperedArtifactData, null, 2), 'utf-8');
      expect(() => {
        ModelRegistry.loadFromFile(corruptFilePath);
      }).toThrow('MODEL_REGISTRY_CORRUPT');

      // Test 2: Orphaned promotion evidence rejected
      const candidate = createDummyCandidate('cand-valid-rec');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'mkt_hash');
      const orphanedEvidenceData = {
        version: '2.0',
        artifacts: [[artifact.candidateId, artifact]],
        promotionEvidences: [
          [
            'non-existent-candidate',
            {
              evidenceId: 'ev-orphan',
              candidateId: 'non-existent-candidate',
              artifactHash: 'dummy_hash',
              shadowDatasetHash: 'mkt_shadow',
              shadowMetrics: createSampleMetrics(),
              promotionDecision: 'PROMOTE',
            },
          ],
        ],
        productionState: [],
        events: [],
        models: [],
        activeModelVersion: 'v2.0-ml-canonical',
      };

      fs.writeFileSync(corruptFilePath, JSON.stringify(orphanedEvidenceData, null, 2), 'utf-8');
      expect(() => {
        ModelRegistry.loadFromFile(corruptFilePath);
      }).toThrow('MODEL_REGISTRY_CORRUPT');

      // Test 3: Production state referring to non-promoted candidate rejected
      const invalidProdData = {
        version: '2.0',
        artifacts: [[artifact.candidateId, { ...artifact, status: 'TRAINED' }]],
        productionState: [
          [
            'smc-quant-baseline:paper',
            {
              strategyId: 'smc-quant-baseline',
              environment: 'paper',
              activeCandidateId: artifact.candidateId,
              activeArtifactHash: artifact.artifactHash,
            },
          ],
        ],
        promotionEvidences: [],
        events: [],
        models: [],
        activeModelVersion: 'v2.0-ml-canonical',
      };

      fs.writeFileSync(corruptFilePath, JSON.stringify(invalidProdData, null, 2), 'utf-8');
      expect(() => {
        ModelRegistry.loadFromFile(corruptFilePath);
      }).toThrow('MODEL_REGISTRY_CORRUPT');

      // Test 4: Production state without verified promotion evidence rejected
      const prodMissingEvidence = {
        version: '2.0',
        artifacts: [[artifact.candidateId, { ...artifact, status: 'PROMOTED' }]],
        productionState: [
          [
            'smc-quant-baseline:paper',
            {
              strategyId: 'smc-quant-baseline',
              environment: 'paper',
              activeCandidateId: artifact.candidateId,
              activeArtifactHash: artifact.artifactHash,
            },
          ],
        ],
        promotionEvidences: [], // Missing required PromotionEvidence
        events: [],
        models: [],
        activeModelVersion: 'v2.0-ml-canonical',
      };

      fs.writeFileSync(corruptFilePath, JSON.stringify(prodMissingEvidence, null, 2), 'utf-8');
      expect(() => {
        ModelRegistry.loadFromFile(corruptFilePath);
      }).toThrow('MODEL_REGISTRY_CORRUPT');

      // Test 5: Semantic audit event referring to non-existent candidate rejected
      const corruptEventData = {
        version: '2.0',
        artifacts: [[artifact.candidateId, artifact]],
        promotionEvidences: [],
        productionState: [],
        events: [
          {
            eventId: 'evt-1',
            candidateId: 'unknown-cand-xyz',
            eventType: 'CANDIDATE_REGISTERED',
            timestamp: Date.now(),
          },
        ],
        models: [],
        activeModelVersion: 'v2.0-ml-canonical',
      };

      fs.writeFileSync(corruptFilePath, JSON.stringify(corruptEventData, null, 2), 'utf-8');
      expect(() => {
        ModelRegistry.loadFromFile(corruptFilePath);
      }).toThrow('MODEL_REGISTRY_CORRUPT');
    });
  });
});
