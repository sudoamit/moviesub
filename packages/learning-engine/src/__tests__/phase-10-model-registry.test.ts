import {
  ModelRegistryService,
  ModelRecord,
  ChampionRecord,
  ChallengerRecord,
  EvaluationBundle,
  EvaluationIdentity,
  EvaluationMetrics,
  TradeStatistics,
  RiskStatistics,
  CostStatistics,
  createEvaluationIdentity,
  computeEvaluationFingerprint,
  createEvaluationBundle,
  FairComparisonEngine,
  PromotionEligibilityEvaluator,
  FairPromotionCriteria
} from '../champion-challenger/index';

describe('Phase 10 — Champion vs Challenger (AI Fix 82)', () => {
  let registryService: ModelRegistryService;

  const mockModelMetadata = { architecture: 'xgboost', hyperparameters: { depth: 6, lr: 0.05 } };
  const mockDataset = 'train_features_v1_canonical_data';

  const baseMetricsChampion: EvaluationMetrics = {
    netPnL: 15000,
    totalReturn: 0.15,
    maxDrawdownPercent: 6.5,
    profitFactor: 1.8,
    winRate: 0.58,
    tradeCount: 120,
    averageTrade: 125,
    averageWin: 350,
    averageLoss: -185,
    expectancy: 1.25,
    fees: 450,
    slippage: 300,
    sharpeRatio: 1.85,
    sortinoRatio: 2.40,
    cagr: 0.22
  };

  const baseTradeStats: TradeStatistics = {
    grossProfit: 24500,
    grossLoss: 8750,
    winningTrades: 70,
    losingTrades: 50,
    maxConsecutiveWins: 6,
    maxConsecutiveLosses: 3,
    averageHoldingPeriodMs: 3600000
  };

  const baseRiskStats: RiskStatistics = {
    maxDrawdownAmount: 6500,
    maxDrawdownPercent: 6.5,
    valueAtRisk95: 1200,
    conditionalVaR95: 1800
  };

  const baseCostStats: CostStatistics = {
    totalFees: 450,
    totalSlippage: 300,
    feeDragPercent: 0.03,
    slippageDragPercent: 0.02
  };

  beforeEach(() => {
    registryService = new ModelRegistryService();
  });

  describe('Invariant 1: ONE_ACTIVE_CHAMPION_PER_SLOT', () => {
    it('guarantees strictly one active Champion per strategy slot and transitions previous champion to RETIRED', () => {
      const slotId = 'slot-eurusd-m15';

      const model1 = registryService.registerModel({
        modelId: 'model-v1',
        modelVersion: '1.0.0',
        modelType: 'xgboost',
        artifactLocation: '/models/v1.bin',
        artifactData: 'model-weights-binary-v1',
        trainingRunId: 'run-001',
        datasetVersion: 'ds-v1',
        featureVersion: 'feat-v1',
        labelVersion: 'lbl-v1'
      });

      const model2 = registryService.registerModel({
        modelId: 'model-v2',
        modelVersion: '2.0.0',
        modelType: 'xgboost',
        artifactLocation: '/models/v2.bin',
        artifactData: 'model-weights-binary-v2',
        trainingRunId: 'run-002',
        datasetVersion: 'ds-v1',
        featureVersion: 'feat-v1',
        labelVersion: 'lbl-v1'
      });

      // Assign model1 as champion
      const champ1 = registryService.assignChampion(slotId, model1.modelId);
      expect(champ1.slotId).toBe(slotId);
      expect(champ1.modelId).toBe(model1.modelId);
      expect(registryService.getModel(model1.modelId)?.status).toBe('CHAMPION');
      expect(registryService.getActiveChampion(slotId)?.modelId).toBe(model1.modelId);

      // Assign model2 as champion for same slot
      const champ2 = registryService.assignChampion(slotId, model2.modelId);
      expect(champ2.slotId).toBe(slotId);
      expect(champ2.modelId).toBe(model2.modelId);
      expect(registryService.getActiveChampion(slotId)?.modelId).toBe(model2.modelId);

      // Model 1 must now be RETIRED
      expect(registryService.getModel(model1.modelId)?.status).toBe('RETIRED');
      expect(registryService.getModel(model2.modelId)?.status).toBe('CHAMPION');

      // Only one champion in active champions map for this slot
      const activeChampions = registryService.listActiveChampions();
      expect(activeChampions.filter((c: ChampionRecord) => c.slotId === slotId).length).toBe(1);
      expect(activeChampions[0].modelId).toBe(model2.modelId);
    });
  });

  describe('Invariant 2: MODEL_ARTIFACT_IDENTITY_IS_UNIQUE', () => {
    it('computes deterministic SHA-256 hash and prevents duplicate modelId registration', () => {
      const artifactData = 'deterministic-weights-data-xyz';
      const expectedHash = ModelRegistryService.computeArtifactHash(artifactData);

      const model = registryService.registerModel({
        modelId: 'unique-model-101',
        modelVersion: '1.0.0',
        modelType: 'random-forest',
        artifactLocation: '/models/rf101.bin',
        artifactData,
        trainingRunId: 'run-101',
        datasetVersion: 'ds-1',
        featureVersion: 'feat-1',
        labelVersion: 'lbl-1'
      });

      expect(model.artifactHash).toBe(expectedHash);
      expect(model.artifactHash.length).toBe(64); // SHA-256 hex string

      // Attempting duplicate registration must throw
      expect(() => {
        registryService.registerModel({
          modelId: 'unique-model-101',
          modelVersion: '1.0.1',
          modelType: 'random-forest',
          artifactLocation: '/models/rf101-dup.bin',
          artifactData: 'different-data',
          trainingRunId: 'run-102',
          datasetVersion: 'ds-1',
          featureVersion: 'feat-1',
          labelVersion: 'lbl-1'
        });
      }).toThrow(/DUPLICATE_MODEL_ID/);
    });
  });

  describe('Invariant 3: EVALUATION_IDENTITY_IS_IMMUTABLE', () => {
    it('deep-freezes evaluation identity and bundle, throwing on mutation attempts', () => {
      const identity = createEvaluationIdentity({
        evaluationId: 'eval-001',
        modelId: 'model-v1',
        modelVersion: '1.0.0',
        artifactHash: 'hash123',
        trainingRunId: 'run-001',
        datasetVersion: 'ds-1',
        datasetHash: 'dshash1',
        featureVersion: 'feat-1',
        featureSchemaHash: 'fshash1',
        labelVersion: 'lbl-1',
        codeCommit: 'commit-abc',
        walkForwardConfigVersion: 'wf-1',
        executionConfigVersion: 'exec-1',
        executionConfigHash: 'exechash1',
        riskConfigVersion: 'risk-1',
        riskConfigHash: 'riskhash1',
        costConfigVersion: 'cost-1',
        costConfigHash: 'costhash1',
        partialExitPolicyVersion: 'pep-1',
        strategyConfigVersion: 'strat-1',
        evaluationWindowStart: 1700000000000,
        evaluationWindowEnd: 1705000000000,
        randomSeed: 42
      });

      const bundle = createEvaluationBundle({
        evaluationIdentity: identity,
        modelMetadata: mockModelMetadata,
        metrics: baseMetricsChampion,
        tradeStatistics: baseTradeStats,
        riskStatistics: baseRiskStats,
        costStatistics: baseCostStats
      });

      expect(Object.isFrozen(identity)).toBe(true);
      expect(Object.isFrozen(bundle)).toBe(true);
      expect(Object.isFrozen(bundle.metrics)).toBe(true);

      // Mutation attempt must fail in strict mode
      expect(() => {
        (bundle as any).metrics.netPnL = 999999;
      }).toThrow();

      expect(() => {
        (bundle as any).evaluationFingerprint = 'hacked';
      }).toThrow();
    });
  });

  describe('Invariant 4: EVALUATION_FINGERPRINT_IS_DETERMINISTIC', () => {
    it('generates identical fingerprints for identical identities and different fingerprints for divergent parameters', () => {
      const baseParams = {
        evaluationId: 'eval-deterministic',
        modelId: 'model-x',
        modelVersion: '1.0.0',
        artifactHash: 'hash-abc',
        trainingRunId: 'run-abc',
        datasetVersion: 'ds-1',
        datasetHash: 'datahash-99',
        featureVersion: 'feat-1',
        featureSchemaHash: 'featschema-99',
        labelVersion: 'lbl-1',
        codeCommit: 'git-rev-1',
        walkForwardConfigVersion: 'wf-v1',
        executionConfigVersion: 'exec-v1',
        executionConfigHash: 'exhash-99',
        riskConfigVersion: 'risk-v1',
        riskConfigHash: 'riskhash-99',
        costConfigVersion: 'cost-v1',
        costConfigHash: 'costhash-99',
        partialExitPolicyVersion: 'pep-v1',
        strategyConfigVersion: 'strat-v1',
        evaluationWindowStart: 1700000000000,
        evaluationWindowEnd: 1705000000000,
        randomSeed: 1337,
        createdAt: 1705000100000
      };

      const fp1 = computeEvaluationFingerprint(baseParams);
      const fp2 = computeEvaluationFingerprint({ ...baseParams });

      expect(fp1).toBe(fp2);

      // Seed change changes fingerprint
      const fpSeed = computeEvaluationFingerprint({ ...baseParams, randomSeed: 1338 });
      expect(fpSeed).not.toBe(fp1);

      // Window change changes fingerprint
      const fpWindow = computeEvaluationFingerprint({ ...baseParams, evaluationWindowEnd: 1705000000001 });
      expect(fpWindow).not.toBe(fp1);

      // Dataset hash change changes fingerprint
      const fpData = computeEvaluationFingerprint({ ...baseParams, datasetHash: 'datahash-100' });
      expect(fpData).not.toBe(fp1);
    });
  });

  describe('Invariant 5: CHAMPION_AND_CHALLENGER_MUST_BE_COMPARABLE', () => {
    it('returns isComparable = true and calculates accurate metric deltas when environment is identical', () => {
      const sharedEnv = {
        datasetVersion: 'ds-canonical-2024',
        datasetHash: 'hash-data-canon',
        featureVersion: 'feat-v2',
        featureSchemaHash: 'hash-feat-schema',
        labelVersion: 'lbl-triple-barrier-v1',
        codeCommit: 'commit-prod-01',
        walkForwardConfigVersion: 'wf-anchored-6m',
        executionConfigVersion: 'exec-sim-v2',
        executionConfigHash: 'hash-exec-sim',
        riskConfigVersion: 'risk-std-v1',
        riskConfigHash: 'hash-risk-std',
        costConfigVersion: 'cost-binance-vip0',
        costConfigHash: 'hash-cost-model',
        partialExitPolicyVersion: 'pep-2tp-v1',
        strategyConfigVersion: 'strat-smc-v2',
        evaluationWindowStart: 1700000000000,
        evaluationWindowEnd: 1705000000000,
        randomSeed: 42
      };

      const championIdentity = createEvaluationIdentity({
        evaluationId: 'eval-champ',
        modelId: 'champ-model',
        modelVersion: '1.0.0',
        artifactHash: 'hash-champ-art',
        trainingRunId: 'run-champ-01',
        ...sharedEnv
      });

      const challengerIdentity = createEvaluationIdentity({
        evaluationId: 'eval-chall',
        modelId: 'chall-model',
        modelVersion: '2.0.0',
        artifactHash: 'hash-chall-art',
        trainingRunId: 'run-chall-02',
        ...sharedEnv
      });

      const challengerMetrics: EvaluationMetrics = {
        netPnL: 18500,
        totalReturn: 0.185,
        maxDrawdownPercent: 5.2, // Improved drawdown (lower)
        profitFactor: 2.1,
        winRate: 0.62,
        tradeCount: 135,
        averageTrade: 137,
        averageWin: 370,
        averageLoss: -175,
        expectancy: 1.45,
        fees: 480,
        slippage: 310,
        sharpeRatio: 2.15,
        sortinoRatio: 2.85,
        cagr: 0.28
      };

      const champBundle = createEvaluationBundle({
        evaluationIdentity: championIdentity,
        modelMetadata: mockModelMetadata,
        metrics: baseMetricsChampion,
        tradeStatistics: baseTradeStats,
        riskStatistics: baseRiskStats,
        costStatistics: baseCostStats
      });

      const challBundle = createEvaluationBundle({
        evaluationIdentity: challengerIdentity,
        modelMetadata: mockModelMetadata,
        metrics: challengerMetrics,
        tradeStatistics: { ...baseTradeStats, winningTrades: 84, losingTrades: 51 },
        riskStatistics: { ...baseRiskStats, maxDrawdownPercent: 5.2 },
        costStatistics: { ...baseCostStats, totalFees: 480, totalSlippage: 310 }
      });

      const comparison = FairComparisonEngine.compareEvaluations(champBundle, challBundle);

      expect(comparison.isComparable).toBe(true);
      expect(comparison.violationReasons.length).toBe(0);
      expect(comparison.deltas).toBeDefined();

      if (comparison.deltas) {
        expect(comparison.deltas.netPnlDelta).toBe(18500 - 15000); // +3500
        expect(comparison.deltas.returnDelta).toBeCloseTo(0.035, 5);
        expect(comparison.deltas.drawdownDelta).toBeCloseTo(5.2 - 6.5, 5); // -1.3% (improved)
        expect(comparison.deltas.expectancyDelta).toBeCloseTo(1.45 - 1.25, 5); // +0.20
        expect(comparison.deltas.winRateDelta).toBeCloseTo(0.62 - 0.58, 5); // +0.04
        expect(comparison.deltas.tradeCountDelta).toBe(15);
        expect(comparison.deltas.sharpeDelta).toBeCloseTo(2.15 - 1.85, 5);
        expect(comparison.deltas.costDelta).toBe((480 + 310) - (450 + 300));
      }
    });
  });

  describe('Invariant 6: INCOMPARABLE_EVALUATIONS_MUST_NOT_BE_COMPARED', () => {
    it('fails closed when any environment parameter diverges, omitting deltas', () => {
      const baseEnv = {
        datasetVersion: 'ds-v1',
        datasetHash: 'hash-data-1',
        featureVersion: 'feat-v1',
        featureSchemaHash: 'hash-feat-1',
        labelVersion: 'lbl-v1',
        codeCommit: 'commit-1',
        walkForwardConfigVersion: 'wf-1',
        executionConfigVersion: 'exec-1',
        executionConfigHash: 'hash-exec-1',
        riskConfigVersion: 'risk-1',
        riskConfigHash: 'hash-risk-1',
        costConfigVersion: 'cost-1',
        costConfigHash: 'hash-cost-1',
        partialExitPolicyVersion: 'pep-1',
        strategyConfigVersion: 'strat-1',
        evaluationWindowStart: 1700000000000,
        evaluationWindowEnd: 1705000000000,
        randomSeed: 42
      };

      const champIdentity = createEvaluationIdentity({
        evaluationId: 'eval-champ',
        modelId: 'champ-model',
        modelVersion: '1.0.0',
        artifactHash: 'hash-champ',
        trainingRunId: 'run-1',
        ...baseEnv
      });

      const champBundle = createEvaluationBundle({
        evaluationIdentity: champIdentity,
        modelMetadata: mockModelMetadata,
        metrics: baseMetricsChampion,
        tradeStatistics: baseTradeStats,
        riskStatistics: baseRiskStats,
        costStatistics: baseCostStats
      });

      // Divergent dataset hash
      const challIdentityDivergentData = createEvaluationIdentity({
        evaluationId: 'eval-chall-data',
        modelId: 'chall-model',
        modelVersion: '2.0.0',
        artifactHash: 'hash-chall',
        trainingRunId: 'run-2',
        ...baseEnv,
        datasetHash: 'hash-data-DIVERGENT'
      });

      const challBundleDivergentData = createEvaluationBundle({
        evaluationIdentity: challIdentityDivergentData,
        modelMetadata: mockModelMetadata,
        metrics: baseMetricsChampion,
        tradeStatistics: baseTradeStats,
        riskStatistics: baseRiskStats,
        costStatistics: baseCostStats
      });

      const comp1 = FairComparisonEngine.compareEvaluations(champBundle, challBundleDivergentData);
      expect(comp1.isComparable).toBe(false);
      expect(comp1.violationReasons.some((r: string) => r.includes('Dataset hash mismatch'))).toBe(true);
      expect(comp1.deltas).toBeUndefined();

      // Divergent random seed
      const challIdentityDivergentSeed = createEvaluationIdentity({
        evaluationId: 'eval-chall-seed',
        modelId: 'chall-model',
        modelVersion: '2.0.0',
        artifactHash: 'hash-chall',
        trainingRunId: 'run-2',
        ...baseEnv,
        randomSeed: 9999
      });

      const challBundleDivergentSeed = createEvaluationBundle({
        evaluationIdentity: challIdentityDivergentSeed,
        modelMetadata: mockModelMetadata,
        metrics: baseMetricsChampion,
        tradeStatistics: baseTradeStats,
        riskStatistics: baseRiskStats,
        costStatistics: baseCostStats
      });

      const comp2 = FairComparisonEngine.compareEvaluations(champBundle, challBundleDivergentSeed);
      expect(comp2.isComparable).toBe(false);
      expect(comp2.violationReasons.some((r: string) => r.includes('Random seed mismatch'))).toBe(true);
      expect(comp2.deltas).toBeUndefined();
    });
  });

  describe('Invariant 7: PROMOTION_ELIGIBILITY_HAS_NO_SIDE_EFFECTS', () => {
    it('computes promotion criteria purely without modifying registry, models, or comparison bundles', () => {
      const slotId = 'slot-alpha';
      const champ = registryService.registerModel({
        modelId: 'champ-alpha',
        modelVersion: '1.0.0',
        modelType: 'catboost',
        artifactLocation: '/art/c1',
        artifactData: 'weights-c1',
        trainingRunId: 'run-c1',
        datasetVersion: 'd1',
        featureVersion: 'f1',
        labelVersion: 'l1'
      });
      registryService.assignChampion(slotId, champ.modelId);

      const chall = registryService.registerModel({
        modelId: 'chall-alpha',
        modelVersion: '2.0.0',
        modelType: 'catboost',
        artifactLocation: '/art/c2',
        artifactData: 'weights-c2',
        trainingRunId: 'run-c2',
        datasetVersion: 'd1',
        featureVersion: 'f1',
        labelVersion: 'l1'
      });
      registryService.registerChallenger(slotId, chall.modelId, 'run-c2');

      const sharedEnv = {
        datasetVersion: 'd1',
        datasetHash: 'dhash',
        featureVersion: 'f1',
        featureSchemaHash: 'fhash',
        labelVersion: 'l1',
        codeCommit: 'c1',
        walkForwardConfigVersion: 'wf1',
        executionConfigVersion: 'e1',
        executionConfigHash: 'ehash',
        riskConfigVersion: 'r1',
        riskConfigHash: 'rhash',
        costConfigVersion: 'co1',
        costConfigHash: 'cohash',
        partialExitPolicyVersion: 'p1',
        strategyConfigVersion: 's1',
        evaluationWindowStart: 1000,
        evaluationWindowEnd: 2000,
        randomSeed: 7
      };

      const champBundle = createEvaluationBundle({
        evaluationIdentity: createEvaluationIdentity({
          evaluationId: 'e-champ',
          modelId: champ.modelId,
          modelVersion: champ.modelVersion,
          artifactHash: champ.artifactHash,
          trainingRunId: champ.trainingRunId,
          ...sharedEnv
        }),
        modelMetadata: {},
        metrics: baseMetricsChampion,
        tradeStatistics: baseTradeStats,
        riskStatistics: baseRiskStats,
        costStatistics: baseCostStats
      });

      const challBundle = createEvaluationBundle({
        evaluationIdentity: createEvaluationIdentity({
          evaluationId: 'e-chall',
          modelId: chall.modelId,
          modelVersion: chall.modelVersion,
          artifactHash: chall.artifactHash,
          trainingRunId: chall.trainingRunId,
          ...sharedEnv
        }),
        modelMetadata: {},
        metrics: {
          ...baseMetricsChampion,
          expectancy: 1.55, // +0.30 expectancy
          maxDrawdownPercent: 7.0, // +0.5% drawdown deterioration (within 1.0% tolerance)
          tradeCount: 150,
          winRate: 0.60,
          sharpeRatio: 2.10,
          profitFactor: 2.0
        },
        tradeStatistics: baseTradeStats,
        riskStatistics: baseRiskStats,
        costStatistics: baseCostStats
      });

      const comparison = FairComparisonEngine.compareEvaluations(champBundle, challBundle);
      expect(comparison.isComparable).toBe(true);

      const criteria: FairPromotionCriteria = {
        minTradeCount: 100,
        minExpectancyDelta: 0.10,
        maxDrawdownDeteriorationPercent: 1.0,
        minWinRateDelta: 0.01,
        minSharpeDelta: 0.15,
        minProfitFactor: 1.9
      };

      const initialRegistryModels = registryService.listModels();
      const initialChampion = registryService.getActiveChampion(slotId);

      const eligibility = PromotionEligibilityEvaluator.calculatePromotionEligibility(comparison, criteria);

      expect(eligibility.eligible).toBe(true);
      expect(eligibility.criteriaMet.minTradeCount).toBe(true);
      expect(eligibility.criteriaMet.minExpectancyDelta).toBe(true);
      expect(eligibility.criteriaMet.maxDrawdownDeterioration).toBe(true);
      expect(eligibility.criteriaMet.minSharpeDelta).toBe(true);

      // Verify ZERO side effects
      expect(registryService.getActiveChampion(slotId)?.modelId).toBe(initialChampion?.modelId);
      expect(registryService.getModel(chall.modelId)?.status).toBe('CHALLENGER');
      expect(registryService.getModel(champ.modelId)?.status).toBe('CHAMPION');
      expect(registryService.listModels()).toEqual(initialRegistryModels);
    });
  });

  describe('Invariant 8: CHALLENGER_CANNOT_AUTOMATICALLY_BECOME_CHAMPION', () => {
    it('leaves active champion unchanged even when promotion eligibility is calculated as eligible', () => {
      const slotId = 'slot-beta';
      const champ = registryService.registerModel({
        modelId: 'champ-beta',
        modelVersion: '1.0.0',
        modelType: 'xgboost',
        artifactLocation: '/m/b1',
        artifactData: 'w-b1',
        trainingRunId: 'r-b1',
        datasetVersion: 'd1',
        featureVersion: 'f1',
        labelVersion: 'l1'
      });
      registryService.assignChampion(slotId, champ.modelId);

      const chall = registryService.registerModel({
        modelId: 'chall-beta',
        modelVersion: '2.0.0',
        modelType: 'xgboost',
        artifactLocation: '/m/b2',
        artifactData: 'w-b2',
        trainingRunId: 'r-b2',
        datasetVersion: 'd1',
        featureVersion: 'f1',
        labelVersion: 'l1'
      });
      registryService.registerChallenger(slotId, chall.modelId, 'r-b2');

      const sharedEnv = {
        datasetVersion: 'd1',
        datasetHash: 'dhash',
        featureVersion: 'f1',
        featureSchemaHash: 'fhash',
        labelVersion: 'l1',
        codeCommit: 'c1',
        walkForwardConfigVersion: 'wf1',
        executionConfigVersion: 'e1',
        executionConfigHash: 'ehash',
        riskConfigVersion: 'r1',
        riskConfigHash: 'rhash',
        costConfigVersion: 'co1',
        costConfigHash: 'cohash',
        partialExitPolicyVersion: 'p1',
        strategyConfigVersion: 's1',
        evaluationWindowStart: 1000,
        evaluationWindowEnd: 2000,
        randomSeed: 7
      };

      const champBundle = createEvaluationBundle({
        evaluationIdentity: createEvaluationIdentity({
          evaluationId: 'e-champ-b',
          modelId: champ.modelId,
          modelVersion: champ.modelVersion,
          artifactHash: champ.artifactHash,
          trainingRunId: champ.trainingRunId,
          ...sharedEnv
        }),
        modelMetadata: {},
        metrics: baseMetricsChampion,
        tradeStatistics: baseTradeStats,
        riskStatistics: baseRiskStats,
        costStatistics: baseCostStats
      });

      const challBundle = createEvaluationBundle({
        evaluationIdentity: createEvaluationIdentity({
          evaluationId: 'e-chall-b',
          modelId: chall.modelId,
          modelVersion: chall.modelVersion,
          artifactHash: chall.artifactHash,
          trainingRunId: chall.trainingRunId,
          ...sharedEnv
        }),
        modelMetadata: {},
        metrics: {
          ...baseMetricsChampion,
          expectancy: 2.50, // Massive improvement
          tradeCount: 200
        },
        tradeStatistics: baseTradeStats,
        riskStatistics: baseRiskStats,
        costStatistics: baseCostStats
      });

      const comparison = FairComparisonEngine.compareEvaluations(champBundle, challBundle);
      const eligibility = PromotionEligibilityEvaluator.calculatePromotionEligibility(comparison, {
        minTradeCount: 50,
        minExpectancyDelta: 0.10,
        maxDrawdownDeteriorationPercent: 2.0
      });

      expect(eligibility.eligible).toBe(true);

      // Model status must still be CHALLENGER and active champion must remain champ-beta
      expect(registryService.getActiveChampion(slotId)?.modelId).toBe('champ-beta');
      expect(registryService.getModel(chall.modelId)?.status).toBe('CHALLENGER');
      expect(registryService.getChallengersForSlot(slotId)[0].modelId).toBe(chall.modelId);
    });
  });

  describe('Invariant 9: CHAMPION_IDENTITY_CANNOT_CHANGE_DURING_EVALUATION', () => {
    it('preserves champion identity across multiple challenger evaluations', () => {
      const slotId = 'slot-gamma';
      const champ = registryService.registerModel({
        modelId: 'champ-gamma',
        modelVersion: '1.0.0',
        modelType: 'lightgbm',
        artifactLocation: '/m/g1',
        artifactData: 'w-g1',
        trainingRunId: 'r-g1',
        datasetVersion: 'd1',
        featureVersion: 'f1',
        labelVersion: 'l1'
      });
      const championRecord = registryService.assignChampion(slotId, champ.modelId);

      // Verify champion record
      expect(championRecord.modelId).toBe('champ-gamma');
      expect(championRecord.artifactHash).toBe(champ.artifactHash);

      // Register multiple challengers
      for (let i = 1; i <= 5; i++) {
        const chall = registryService.registerModel({
          modelId: `chall-gamma-${i}`,
          modelVersion: `${i}.0.0`,
          modelType: 'lightgbm',
          artifactLocation: `/m/g-chall-${i}`,
          artifactData: `w-g-chall-${i}`,
          trainingRunId: `r-g-chall-${i}`,
          datasetVersion: 'd1',
          featureVersion: 'f1',
          labelVersion: 'l1'
        });
        registryService.registerChallenger(slotId, chall.modelId, `r-g-chall-${i}`);
      }

      // Champion is strictly invariant
      const currentChampion = registryService.getActiveChampion(slotId);
      expect(currentChampion).toEqual(championRecord);
      expect(registryService.getChallengersForSlot(slotId).length).toBe(5);
    });
  });

  describe('Invariant 10 & 11: EVALUATION_USES_EXACT_MODEL_ARTIFACT & CONFIG_VERSIONS', () => {
    it('verifies exact artifact hash and full suite of configuration versions/hashes in evaluation bundle', () => {
      const artifactData = 'exact-model-weights-binary-456';
      const expectedArtifactHash = ModelRegistryService.computeArtifactHash(artifactData);

      const model = registryService.registerModel({
        modelId: 'exact-model-prod',
        modelVersion: '3.1.4',
        modelType: 'dnn',
        artifactLocation: '/models/exact.bin',
        artifactData,
        trainingRunId: 'run-exact-99',
        datasetVersion: 'ds-canonical-2024',
        featureVersion: 'feat-schema-v3',
        labelVersion: 'lbl-regime-v2'
      });

      expect(model.artifactHash).toBe(expectedArtifactHash);

      const evalIdentity = createEvaluationIdentity({
        evaluationId: 'eval-exact-101',
        modelId: model.modelId,
        modelVersion: model.modelVersion,
        artifactHash: model.artifactHash,
        trainingRunId: model.trainingRunId,
        datasetVersion: model.datasetVersion,
        datasetHash: 'hash-ds-canon-2024',
        featureVersion: model.featureVersion,
        featureSchemaHash: 'hash-feat-schema-v3',
        labelVersion: model.labelVersion,
        codeCommit: 'commit-sha-prod-abcdef',
        walkForwardConfigVersion: 'wf-anchored-v3',
        executionConfigVersion: 'exec-fill-v4',
        executionConfigHash: 'hash-exec-fill-v4',
        riskConfigVersion: 'risk-limits-v2',
        riskConfigHash: 'hash-risk-limits-v2',
        costConfigVersion: 'cost-tier1-v1',
        costConfigHash: 'hash-cost-tier1-v1',
        partialExitPolicyVersion: 'pep-scaleout-v2',
        strategyConfigVersion: 'strat-momentum-v5',
        evaluationWindowStart: 1700000000000,
        evaluationWindowEnd: 1705000000000,
        randomSeed: 2024
      });

      const bundle = createEvaluationBundle({
        evaluationIdentity: evalIdentity,
        modelMetadata: { paramCount: 500000 },
        metrics: baseMetricsChampion,
        tradeStatistics: baseTradeStats,
        riskStatistics: baseRiskStats,
        costStatistics: baseCostStats
      });

      // Verify exact bindings
      expect(bundle.evaluationIdentity.artifactHash).toBe(model.artifactHash);
      expect(bundle.evaluationIdentity.modelId).toBe(model.modelId);
      expect(bundle.evaluationIdentity.modelVersion).toBe(model.modelVersion);
      expect(bundle.evaluationIdentity.walkForwardConfigVersion).toBe('wf-anchored-v3');
      expect(bundle.evaluationIdentity.executionConfigHash).toBe('hash-exec-fill-v4');
      expect(bundle.evaluationIdentity.riskConfigHash).toBe('hash-risk-limits-v2');
      expect(bundle.evaluationIdentity.costConfigHash).toBe('hash-cost-tier1-v1');
      expect(bundle.evaluationIdentity.partialExitPolicyVersion).toBe('pep-scaleout-v2');
      expect(bundle.evaluationIdentity.strategyConfigVersion).toBe('strat-momentum-v5');
      expect(bundle.evaluationIdentity.randomSeed).toBe(2024);
    });
  });
});
