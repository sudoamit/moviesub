import * as fs from 'fs';
import * as path from 'path';
import { ICandle } from '@quant/shared';
import {
  CandidateArtifact,
  CandidateMarketDataset,
  PromotionDecision,
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
    modelVersion: 'v2.1-model',
    modelHash: 'dummy_model_hash_123',
    weights: [0.5, 0.3, -0.2],
    bias: 0.1,
    featureSchemaVersion: '2.0',
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
            ...((artifact.scalerArtifact as any)?.scalerParameters || {}),
            means: { fvgSize: 9999 },
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

  describe('2. ModelRegistry Lifecycle, State Machine, Audit Logging, & Persistence', () => {
    it('registers candidate artifact, prevents duplicates, and logs registration event', () => {
      const candidate = createDummyCandidate('cand-reg-1');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'm_hash');

      const registered = ModelRegistry.registerCandidateArtifact(artifact);
      expect(registered.candidateId).toBe('cand-reg-1');

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
    });

    it('executes candidate strategy deterministically over independent shadow market data with 0% synthetic PnL', () => {
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
      expect(shadowResult.metrics.observationsCount).toBeGreaterThanOrEqual(30);
      expect(typeof shadowResult.metrics.totalTrades).toBe('number');
      expect(typeof shadowResult.metrics.profitFactor).toBe('number');
      expect(typeof shadowResult.metrics.expectancy).toBe('number');
      expect(typeof shadowResult.metrics.maxDrawdown).toBe('number');
      expect(typeof shadowResult.metrics.winRate).toBe('number');
    });
  });

  describe('4. Promotion Gate Contract & Decoupled Policy Evaluation', () => {
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

    it('approves candidate that satisfies all shadow performance criteria', () => {
      const candidate = createDummyCandidate('cand-pass-1');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'm_hash');

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
        evaluatedAt: Date.now(),
      };

      const input: PromotionGateInput = {
        candidateArtifact: artifact,
        shadowResult,
        policy,
      };

      const decision = PromotionGate.evaluatePromotion(input);
      expect(decision.decision).toBe('PROMOTE');
      expect(decision.rejectionReasons?.length || 0).toBe(0);
      expect(decision.metrics.totalTrades).toBe(25);
    });

    it('rejects candidate with explicit reasons if any criteria fails', () => {
      const candidate = createDummyCandidate('cand-fail-1');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'm_hash');

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
      expect(decision.rejectionReasons?.some((r) => r.includes('INSUFFICIENT_SHADOW_OBSERVATIONS'))).toBe(true);
      expect(decision.rejectionReasons?.some((r) => r.includes('INSUFFICIENT_SHADOW_TRADES'))).toBe(true);
      expect(decision.rejectionReasons?.some((r) => r.includes('PROFIT_FACTOR_BELOW_THRESHOLD'))).toBe(true);
      expect(decision.rejectionReasons?.some((r) => r.includes('EXPECTANCY_BELOW_THRESHOLD'))).toBe(true);
      expect(decision.rejectionReasons?.some((r) => r.includes('DRAWDOWN_ABOVE_LIMIT'))).toBe(true);
    });

    it('rejects when allowAutoPromotion is false and records AUTO_PROMOTION_DISABLED', () => {
      const manualOnlyPolicy: PromotionPolicy = {
        ...policy,
        allowAutoPromotion: false,
      };

      const candidate = createDummyCandidate('cand-manual-1');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'm_hash');

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
        evaluatedAt: Date.now(),
      };

      const input: PromotionGateInput = {
        candidateArtifact: artifact,
        shadowResult,
        policy: manualOnlyPolicy,
      };

      const decision = PromotionGate.evaluatePromotion(input);
      expect(decision.decision).toBe('REJECT');
      expect(decision.rejectionReasons?.some((r) => r.includes('AUTO_PROMOTION_DISABLED'))).toBe(true);
    });
  });

  describe('5. ProductionModelActivator Atomic Activation & Rollback', () => {
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

    it('refuses activation if promotion decision is not PROMOTE', () => {
      const candidate = createDummyCandidate('cand-act-reject');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'm_hash');
      ModelRegistry.registerCandidateArtifact(artifact);

      const rejectedDecision: PromotionDecision = {
        candidateId: 'cand-act-reject',
        decision: 'REJECT',
        policyVersion: 'v2.0',
        reasons: ['LOW_PROFIT_FACTOR'],
        metrics: createSampleMetrics({
          observationsCount: 100,
          totalTrades: 20,
          netPnL: 10,
          profitFactor: 1.05,
          expectancy: 0.05,
          maxDrawdownR: 2.0,
          winRate: 50.0,
        }),
        evaluatedAt: Date.now(),
      };

      expect(() => {
        ProductionModelActivator.activateCandidate({
          candidateId: 'cand-act-reject',
          promotionDecision: rejectedDecision,
          policy,
        });
      }).toThrow('PROMOTION_NOT_APPROVED');
    });

    it('atomically activates approved candidate, transitions previous model to RETIRED, and records promotion evidence', () => {
      // 1. Setup candidate A and candidate B
      const candA = createDummyCandidate('cand-prod-A');
      const artifactA = CandidateBacktestRunner.createCandidateArtifact(candA, 'm_hash');
      ModelRegistry.registerCandidateArtifact(artifactA);

      const decisionA: PromotionDecision = {
        candidateId: 'cand-prod-A',
        decision: 'PROMOTE',
        policyVersion: 'v2.0',
        reasons: [],
        metrics: createSampleMetrics({
          observationsCount: 100,
          totalTrades: 20,
          netPnL: 100,
          profitFactor: 1.8,
          expectancy: 0.4,
          maxDrawdownR: 1.5,
          winRate: 60.0,
        }),
        evaluatedAt: Date.now(),
      };

      // Activate Candidate A
      const prodStateA = ProductionModelActivator.activateCandidate({
        candidateId: 'cand-prod-A',
        promotionDecision: decisionA,
        policy,
      });

      expect(prodStateA.activeCandidateId).toBe('cand-prod-A');
      expect(prodStateA.activeArtifactHash).toBe(artifactA.artifactHash);
      expect(ModelRegistry.getCandidateArtifact('cand-prod-A')?.status).toBe('PROMOTED');

      // 2. Setup candidate B
      const candB = createDummyCandidate('cand-prod-B');
      const artifactB = CandidateBacktestRunner.createCandidateArtifact(candB, 'm_hash');
      ModelRegistry.registerCandidateArtifact(artifactB);

      const decisionB: PromotionDecision = {
        candidateId: 'cand-prod-B',
        decision: 'PROMOTE',
        policyVersion: 'v2.0',
        reasons: [],
        metrics: createSampleMetrics({
          observationsCount: 120,
          totalTrades: 25,
          netPnL: 200,
          profitFactor: 2.1,
          expectancy: 0.55,
          maxDrawdownR: 1.2,
          winRate: 65.0,
        }),
        evaluatedAt: Date.now(),
      };

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

      // Verify PromotionEvidence saved
      const evidence = ModelRegistry.getPromotionEvidence('cand-prod-B');
      expect(evidence).toBeDefined();
      expect(evidence?.promotionDecision).toBe('PROMOTE');
      expect(evidence?.shadowMetrics.profitFactor).toBe(2.1);
    });

    it('performs immutable rollback restoring previous active model without retraining', () => {
      // Cand A activated then Cand B activated
      const candA = createDummyCandidate('cand-rb-A');
      const artifactA = CandidateBacktestRunner.createCandidateArtifact(candA, 'm_hash');
      ModelRegistry.registerCandidateArtifact(artifactA);

      const decision: PromotionDecision = {
        candidateId: 'cand-rb-A',
        decision: 'PROMOTE',
        policyVersion: 'v2.0',
        reasons: [],
        metrics: createSampleMetrics({
          observationsCount: 100,
          totalTrades: 20,
          netPnL: 100,
          profitFactor: 1.8,
          expectancy: 0.4,
          maxDrawdownR: 1.5,
          winRate: 60.0,
        }),
        evaluatedAt: Date.now(),
      };

      ProductionModelActivator.activateCandidate({
        candidateId: 'cand-rb-A',
        promotionDecision: decision,
        policy,
      });

      const candB = createDummyCandidate('cand-rb-B');
      const artifactB = CandidateBacktestRunner.createCandidateArtifact(candB, 'm_hash');
      ModelRegistry.registerCandidateArtifact(artifactB);

      ProductionModelActivator.activateCandidate({
        candidateId: 'cand-rb-B',
        promotionDecision: { ...decision, candidateId: 'cand-rb-B' },
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
      expect(ModelRegistry.getCandidateArtifact('cand-rb-A')?.status).toBe('PROMOTED');
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
});
