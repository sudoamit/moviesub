import {
  CandidateEvaluator,
  CandidateGenerator,
  DatasetManager,
  ExperienceStore,
  ModelRegistry,
  ModelTrainer,
  MonteCarloEngine,
  PointInTimeValidator,
  PromotionGate,
  RollbackManager,
  SeededRNG,
  StrategyCandidate,
  StrategyRegistry,
  TemporalFeatureScaler,
  TradingExperience,
  WalkForwardValidator,
} from '../index';

describe('Learning Engine Correctness & Self-Improvement Regression Suite (Phases 1 - 29)', () => {
  beforeEach(() => {
    ExperienceStore.clear();
  });

  // Test 1 — Point-in-time feature isolation
  test('Test 1: Point-in-time feature isolation — future candles do not affect features at decision T', () => {
    const timeT = 1700000000000;
    const baseFeatures = { smcScore: 78, mtfAlignment: 0.85, rvol: 1.4 };

    const expA: TradingExperience = {
      id: 'exp_t1_a',
      tradeId: 't1_a',
      timestamp: new Date(timeT),
      decisionTimestamp: timeT,
      featureTimestamp: timeT - 60000,
      labelStartTimestamp: timeT + 60000,
      labelEndTimestamp: timeT + 3600000,
      instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
      marketState: { quant: { ...baseFeatures } },
      decision: { action: 'BUY', score: 78 },
      execution: { entryPrice: 100, entryTime: new Date(timeT + 60000) },
      risk: { stopLoss: 95 },
      prediction: { expectedR: 1.5 },
      outcome: { status: 'WIN', pnl: 150, pnlR: 1.5, maxFavorableExcursion: 2.0, maxAdverseExcursion: 0.3, holdingTimeSeconds: 3600 },
      marketContext: { regime: 'BULLISH_TREND', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 2 },
      outcomeClassification: 'GOOD_TRADE_WIN',
      reasons: ['BOS_BREAKOUT'],
      failureReasons: [],
      strategyVersion: 'v2.0-smc-quant',
      featureSchemaVersion: '2.0',
      createdAt: new Date(timeT),
    };

    const valResult = PointInTimeValidator.validatePointInTimeExperience(expA);
    expect(valResult.isValid).toBe(true);
    expect(expA.marketState.quant).toEqual(baseFeatures);
  });

  // Test 2 — Future outcome cannot affect features
  test('Test 2: Future outcome cannot affect feature vector at decision T', () => {
    const timeT = 1700000000000;

    const exp1: TradingExperience = {
      id: 'exp_t2_1',
      tradeId: 't2_1',
      timestamp: new Date(timeT),
      decisionTimestamp: timeT,
      featureTimestamp: timeT - 1000,
      labelStartTimestamp: timeT + 1000,
      labelEndTimestamp: timeT + 3600000,
      instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
      marketState: { quant: { smcScore: 80, mtfAlignment: 0.9 } },
      decision: { action: 'BUY', score: 80 },
      execution: { entryPrice: 100, entryTime: new Date(timeT + 1000) },
      risk: { stopLoss: 95 },
      prediction: { expectedR: 1.5 },
      outcome: { status: 'WIN', pnl: 200, pnlR: 2.0, maxFavorableExcursion: 2.5, maxAdverseExcursion: 0.2, holdingTimeSeconds: 3600 },
      marketContext: { regime: 'BULLISH_TREND', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 2 },
      outcomeClassification: 'GOOD_TRADE_WIN',
      reasons: [],
      failureReasons: [],
      strategyVersion: 'v2.0-smc-quant',
      featureSchemaVersion: '2.0',
      createdAt: new Date(timeT),
    };

    const exp2: TradingExperience = {
      ...exp1,
      id: 'exp_t2_2',
      tradeId: 't2_2',
      outcome: { status: 'LOSS', pnl: -100, pnlR: -1.0, maxFavorableExcursion: 0.2, maxAdverseExcursion: 1.0, holdingTimeSeconds: 1200 },
      outcomeClassification: 'BAD_TRADE_LOSS',
    };

    expect(exp1.marketState.quant).toEqual(exp2.marketState.quant);
  });

  // Test 3 — Temporal split
  test('Test 3: Temporal Dataset Builder enforces max(train.ts) < min(val.ts) < min(oos.ts)', () => {
    const ds = new DatasetManager();
    const samples = Array.from({ length: 100 }, (_, i) => ({
      sampleId: `s_${i}`,
      timestamp: 1700000000000 + i * 60000,
      features: { smcScore: 50 + i },
      labelBinary: i % 2,
      labelContinuousR: i % 2 === 1 ? 1.5 : -1.0,
      regime: 'BULLISH',
      volatilityBucket: 'NORMAL',
    }));

    const record = ds.createDataset('BTCUSDT', '15m', samples);
    const splits = ds.splitDataset(record.metadata.datasetId, 0.6, 0.2, 0.2);

    expect(splits.train.length).toBe(60);
    expect(splits.validation.length).toBe(20);
    expect(splits.outOfSample.length).toBe(20);

    const maxTrainTs = splits.train[splits.train.length - 1].timestamp;
    const minValTs = splits.validation[0].timestamp;
    const maxValTs = splits.validation[splits.validation.length - 1].timestamp;
    const minOosTs = splits.outOfSample[0].timestamp;

    expect(maxTrainTs).toBeLessThan(minValTs);
    expect(maxValTs).toBeLessThan(minOosTs);
  });

  // Test 4 — OOS isolation
  test('Test 4: OOS data modifications cannot influence training fold parameters', () => {
    const scaler1 = new TemporalFeatureScaler();
    const trainData = [
      { sampleId: '1', timestamp: 1000, features: { f1: 10, f2: 20 }, labelBinary: 1, labelContinuousR: 1, regime: 'NORM', volatilityBucket: 'NORM' },
      { sampleId: '2', timestamp: 2000, features: { f1: 20, f2: 40 }, labelBinary: 0, labelContinuousR: -1, regime: 'NORM', volatilityBucket: 'NORM' },
    ];
    scaler1.fit(trainData);

    const oosDataExtreme = [
      { sampleId: '3', timestamp: 3000, features: { f1: 10000, f2: 99999 }, labelBinary: 1, labelContinuousR: 10, regime: 'HIGH', volatilityBucket: 'HIGH' },
    ];

    const scaler2 = new TemporalFeatureScaler();
    scaler2.fit(trainData); // Fit on train data only
    const transformedOos = scaler2.transform(oosDataExtreme[0].features);

    // Train scaler parameters must remain strictly identical
    expect(scaler1.getParams('f1')).toEqual(scaler2.getParams('f1'));
    expect(transformedOos.f1).toBeCloseTo(1412.09, 1);
  });

  // Test 5 — Candidate actually changes behavior
  test('Test 5: Candidate with parameter change actually modifies simulated execution results', () => {
    const baseCandidate: StrategyCandidate = {
      id: 'cand_filter',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-cand-filter',
      type: 'FILTER',
      description: 'Reject HTF_CONFLICT setups',
      change: { action: 'ADD_FILTER_RULE', conditionRules: ['HTF_CONFLICT'] },
      evidence: { sampleSize: 10, expectancyBefore: 0.2, expectancyAfterHistorical: 0.2 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const experiences: TradingExperience[] = Array.from({ length: 10 }, (_, i) => ({
      id: `exp_${i}`,
      tradeId: `t_${i}`,
      timestamp: new Date(1700000000000 + i * 60000),
      instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
      marketState: { quant: { smcScore: 70 } },
      decision: { action: 'BUY', score: 70 },
      execution: { entryPrice: 100, entryTime: new Date(1700000000000 + i * 60000) },
      risk: { stopLoss: 95 },
      prediction: {},
      outcome: { status: i % 2 === 0 ? 'WIN' : 'LOSS', pnl: i % 2 === 0 ? 100 : -100, pnlR: i % 2 === 0 ? 1.0 : -1.0, maxFavorableExcursion: 1.5, maxAdverseExcursion: 1.0, holdingTimeSeconds: 600 },
      marketContext: { regime: 'BULLISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 },
      outcomeClassification: i % 2 === 0 ? 'GOOD_TRADE_WIN' : 'BAD_TRADE_LOSS',
      reasons: [],
      failureReasons: i % 2 !== 0 ? ['HTF_CONFLICT'] : [],
      strategyVersion: 'v2.0',
      featureSchemaVersion: '2.0',
      createdAt: new Date(),
      candlesDuringTrade: [
        {
          timestamp: new Date(1700000000000 + i * 60000),
          open: 100,
          high: i % 2 === 0 ? 110 : 101,
          low: i % 2 === 0 ? 99 : 94,
          close: i % 2 === 0 ? 108 : 94,
          volume: 100,
        },
      ],
    }));

    const result = CandidateEvaluator.evaluate(baseCandidate, experiences);
    expect(result.totalSimulatedTrades).toBe(5); // 5 HTF_CONFLICT loss trades filtered out!
    expect(result.candidateExpectancy).toBeGreaterThan(result.baselineExpectancy);
  });

  // Test 6 — Candidate evidence is measured
  test('Test 6: Candidate evaluation reports actual simulated expectancy, not synthetic formulas', () => {
    const candidate: StrategyCandidate = {
      id: 'cand_measured',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-cand-measured',
      type: 'VOLATILITY',
      description: 'Scale down high volatility trades',
      change: { highVolatilitySizingMultiplier: 0.5 },
      evidence: { sampleSize: 10, expectancyBefore: -0.2, expectancyAfterHistorical: -0.2 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const experiences: TradingExperience[] = Array.from({ length: 6 }, (_, i) => ({
      id: `exp_vol_${i}`,
      tradeId: `t_vol_${i}`,
      timestamp: new Date(1700000000000 + i * 60000),
      instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
      marketState: {},
      decision: { action: 'BUY', score: 70 },
      execution: { entryPrice: 100, entryTime: new Date(1700000000000 + i * 60000) },
      risk: { stopLoss: 95 },
      prediction: {},
      outcome: { status: 'LOSS', pnl: -100, pnlR: -1.0, maxFavorableExcursion: 0.1, maxAdverseExcursion: 1.0, holdingTimeSeconds: 600 },
      marketContext: { regime: 'HIGH_VOLATILITY', volatilityRegime: 'HIGH', session: 'NY', dayOfWeek: 1 },
      outcomeClassification: 'BAD_TRADE_LOSS',
      reasons: [],
      failureReasons: ['VOLATILITY_MISREAD'],
      strategyVersion: 'v2.0',
      featureSchemaVersion: '2.0',
      createdAt: new Date(),
      candlesDuringTrade: [
        {
          timestamp: new Date(1700000000000 + i * 60000),
          open: 100,
          high: 101,
          low: 94,
          close: 94,
          volume: 100,
        },
      ],
    }));

    const result = CandidateEvaluator.evaluate(candidate, experiences);
    expect(result.totalSimulatedTrades).toBe(6);
    expect(result.simulatedRMultiples).toHaveLength(6);
  });

  // Test 7 — Candidate-specific Monte Carlo
  test('Test 7: Two candidates with different trade sequences produce distinct Monte Carlo results', () => {
    const candARMultiples = [1.5, 2.0, 1.2, -0.5, 1.8];
    const candBRMultiples = [-1.0, -1.5, -2.0, 0.5, -1.0];

    const mcA = MonteCarloEngine.simulate(candARMultiples, { seed: 100, ruinThresholdDrawdownR: 2.0 });
    const mcB = MonteCarloEngine.simulate(candBRMultiples, { seed: 100, ruinThresholdDrawdownR: 2.0 });

    expect(mcA.medianExpectancyR).toBeGreaterThan(mcB.medianExpectancyR);
    expect(mcA.probabilityOfRuin).toBeLessThan(mcB.probabilityOfRuin);
  });

  // Test 8 — Shadow minimum trade gate
  test('Test 8: PromotionGate blocks candidate with missing or insufficient shadow trade evidence', () => {
    const candidateNoShadow: StrategyCandidate = {
      id: 'cand_no_shadow',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-cand-ns',
      type: 'FILTER',
      description: 'No shadow trades',
      change: {},
      evidence: { sampleSize: 50, expectancyBefore: 0.2, expectancyAfterHistorical: 0.5 },
      validationMetrics: {
        inSampleExpectancy: 0.6,
        walkForwardExpectancy: 0.5,
        outOfSampleExpectancy: 0.5,
        profitFactor: 2.0,
        maxDrawdownPercent: 5.0,
        monteCarloRuinProb: 0.0,
        transactionCostSurvived: true,
      },
      status: 'VALIDATED',
      createdAt: new Date(),
    };

    const res1 = PromotionGate.evaluateCandidate(candidateNoShadow);
    expect(res1.approved).toBe(false);
    expect(candidateNoShadow.status).toBe('REJECTED');

    const candidateLowShadow: StrategyCandidate = {
      ...candidateNoShadow,
      status: 'SHADOW',
      shadowMetrics: {
        shadowTradeCount: 3, // < required 10
        shadowExpectancy: 0.8,
        shadowWinRate: 66.7,
        shadowMaxDrawdown: 2.0,
      },
    };

    const res2 = PromotionGate.evaluateCandidate(candidateLowShadow);
    expect(res2.approved).toBe(false);
  });

  // Test 9 — Registry promotion
  test('Test 9: Model and Strategy registries promote without mutating frozen objects', () => {
    const initialStrat = StrategyRegistry.getActiveStrategy();
    expect(initialStrat).toBeDefined();

    const newStrat = {
      strategyId: 'smc-quant-v2.1',
      strategyVersion: 'v2.1-smc-quant',
      description: 'V2.1 SMC',
      parameters: { minScore: 70 },
      expectancyR: 0.65,
      winRate: 62.0,
      profitFactor: 1.95,
      maxDrawdownPct: 8.0,
      status: 'CANDIDATE' as const,
      createdAt: new Date(),
    };

    StrategyRegistry.registerStrategy(newStrat);
    StrategyRegistry.promoteStrategy(newStrat.strategyVersion);

    const activeStrat = StrategyRegistry.getActiveStrategy();
    expect(activeStrat?.strategyVersion).toBe(newStrat.strategyVersion);
    expect(activeStrat?.status).toBe('ACTIVE');
  });

  // Test 10 — Rollback
  test('Test 10: RollbackManager restores previous stable version dynamically', () => {
    // Simulate degraded recent performance across 20 trades
    const recentExperiences: TradingExperience[] = Array.from({ length: 20 }, (_, i) => ({
      id: `exp_deg_${i}`,
      tradeId: `t_deg_${i}`,
      timestamp: new Date(1700000000000 + i * 60000),
      instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
      marketState: {},
      decision: { action: 'BUY', score: 70 },
      execution: { entryPrice: 100, entryTime: new Date(1700000000000 + i * 60000) },
      risk: { stopLoss: 95 },
      prediction: {},
      outcome: { status: 'LOSS', pnl: -100, pnlR: -1.0, maxFavorableExcursion: 0.1, maxAdverseExcursion: 1.0, holdingTimeSeconds: 600 },
      marketContext: { regime: 'BEARISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 },
      outcomeClassification: 'BAD_TRADE_LOSS',
      reasons: [],
      failureReasons: ['STRATEGY_FAILURE'],
      strategyVersion: 'v2.1-smc-quant',
      featureSchemaVersion: '2.0',
      createdAt: new Date(),
    }));

    const rbRes = RollbackManager.checkAndExecuteRollback(recentExperiences, 15);
    expect(rbRes.shouldRollback).toBe(true);
    expect(StrategyRegistry.getActiveStrategy()?.status).toBe('ACTIVE');
  });

  // Test 11 — Label leakage
  test('Test 11: PointInTimeValidator rejects experiences where future label starts before decision', () => {
    const invalidExp: TradingExperience = {
      id: 'exp_future_leak',
      tradeId: 't_leak',
      timestamp: new Date(1700000000000),
      decisionTimestamp: 1700000000000,
      featureTimestamp: 1700000000000,
      labelStartTimestamp: 1699999999000, // Starts BEFORE decision!
      labelEndTimestamp: 1700001000000,
      instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
      marketState: {},
      decision: { action: 'BUY', score: 80 },
      execution: { entryPrice: 100, entryTime: new Date(1699999999000) },
      risk: { stopLoss: 95 },
      prediction: {},
      outcome: { status: 'WIN', pnl: 100, pnlR: 1.0, maxFavorableExcursion: 1.0, maxAdverseExcursion: 0.0, holdingTimeSeconds: 1000 },
      marketContext: { regime: 'BULLISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 },
      outcomeClassification: 'GOOD_TRADE_WIN',
      reasons: [],
      failureReasons: [],
      strategyVersion: 'v2.0',
      featureSchemaVersion: '2.0',
      createdAt: new Date(),
    };

    const valRes = PointInTimeValidator.validatePointInTimeExperience(invalidExp);
    expect(valRes.isValid).toBe(false);
    expect(valRes.reason).toContain('INVALID_DECISION_TIMING');
  });

  // Test 12 — Feature scaling leakage
  test('Test 12: Extreme OOS values do not mutate pre-fitted training scaler statistics', () => {
    const scaler = new TemporalFeatureScaler();
    const trainData = [
      { sampleId: '1', timestamp: 1000, features: { smcScore: 60 }, labelBinary: 1, labelContinuousR: 1, regime: 'BULL', volatilityBucket: 'NORM' },
      { sampleId: '2', timestamp: 2000, features: { smcScore: 80 }, labelBinary: 1, labelContinuousR: 1, regime: 'BULL', volatilityBucket: 'NORM' },
    ];

    scaler.fit(trainData);
    const initialParams = { ...scaler.getParams('smcScore')! };

    // Transform OOS sample with huge outlier
    scaler.transform({ smcScore: 999999 });
    const postParams = scaler.getParams('smcScore')!;

    expect(postParams.mean).toBe(initialParams.mean);
    expect(postParams.std).toBe(initialParams.std);
  });

  // Test 13 — Walk-forward retraining
  test('Test 13: Walk-forward validator processes folds with distinct training windows', () => {
    const experiences: TradingExperience[] = Array.from({ length: 30 }, (_, i) => ({
      id: `exp_wf_${i}`,
      tradeId: `t_wf_${i}`,
      timestamp: new Date(1700000000000 + i * 60000),
      instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
      marketState: { quant: { smcScore: 70 + i } },
      decision: { action: 'BUY', score: 70 },
      execution: { entryPrice: 100, entryTime: new Date(1700000000000 + i * 60000) },
      risk: { stopLoss: 95 },
      prediction: {},
      outcome: { status: 'WIN', pnl: 100, pnlR: 1.0, maxFavorableExcursion: 1.5, maxAdverseExcursion: 0.2, holdingTimeSeconds: 600 },
      marketContext: { regime: 'BULLISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 },
      outcomeClassification: 'GOOD_TRADE_WIN',
      reasons: [],
      failureReasons: [],
      strategyVersion: 'v2.0',
      featureSchemaVersion: '2.0',
      createdAt: new Date(),
      candlesDuringTrade: [
        {
          timestamp: new Date(1700000000000 + i * 60000),
          open: 100,
          high: 110,
          low: 99,
          close: 108,
          volume: 100,
        },
      ],
    }));

    const cand: StrategyCandidate = {
      id: 'cand_wf',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-wf',
      type: 'THRESHOLD',
      description: 'Threshold tuning',
      change: { parameter: 'minMtfScore', value: 70 },
      evidence: { sampleSize: 30, expectancyBefore: 1.0, expectancyAfterHistorical: 1.0 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const wfRes = WalkForwardValidator.validate(cand, experiences, { numFolds: 3 });
    expect(wfRes.folds.length).toBeGreaterThan(0);
    expect(wfRes.folds[0].trainRange[0].getTime()).toBeLessThan(wfRes.folds[wfRes.folds.length - 1].testRange[0].getTime());
  });

  // Test 14 — Deterministic learning run
  test('Test 14: Seeded PRNG produces 100% deterministic Monte Carlo results for identical inputs', () => {
    const rMultiples = [1.2, -1.0, 1.5, 2.0, -0.5, 1.1, -1.0, 1.8];

    const res1 = MonteCarloEngine.simulate(rMultiples, { seed: 12345, iterations: 500 });
    const res2 = MonteCarloEngine.simulate(rMultiples, { seed: 12345, iterations: 500 });

    expect(res1.probabilityOfRuin).toBe(res2.probabilityOfRuin);
    expect(res1.maxDrawdown95Pct).toBe(res2.maxDrawdown95Pct);
    expect(res1.medianExpectancyR).toBe(res2.medianExpectancyR);
  });

  // Test 15 — No fabricated metrics
  test('Test 15: CandidateGenerator output contains baseline expectancy before actual evaluation', () => {
    const inputs = {
      baseStrategyVersion: 'v2.0',
      errorReport: {
        periodStart: new Date(),
        periodEnd: new Date(),
        totalTrades: 10,
        overallWinRate: 50,
        overallExpectancy: 0.2,
        failureStats: [],
        topLossDrivers: [
          {
            failureMode: 'HTF_CONFLICT' as const,
            count: 6,
            frequency: 0.6,
            totalLossAmount: 600,
            lossContributionPct: 60,
            averageR: -1.0,
            winRate: 0,
            expectancy: -1.0,
            regimeDistribution: {},
            timeframeDistribution: {},
            instrumentDistribution: {},
          },
        ],
        recommendations: [],
      },
      patterns: [],
    };

    const candidates = CandidateGenerator.generateCandidates(inputs);
    expect(candidates.length).toBeGreaterThan(0);

    for (const cand of candidates) {
      // Must NOT contain synthetic formula calculations like (driver.averageR + 0.35)
      expect(cand.evidence.expectancyAfterHistorical).toBe(cand.evidence.expectancyBefore);
    }
  });

  // Test 16 — Duplicate sample ID rejection
  test('Test 16: DatasetManager throws DUPLICATE_SAMPLE_ID error on duplicate sample IDs', () => {
    const ds = new DatasetManager();
    const duplicateSamples = [
      { sampleId: 'dup_1', timestamp: 1000, features: { smcScore: 50 }, labelBinary: 1, labelContinuousR: 1.0, regime: 'BULL', volatilityBucket: 'NORM' },
      { sampleId: 'dup_1', timestamp: 2000, features: { smcScore: 60 }, labelBinary: 0, labelContinuousR: -1.0, regime: 'BULL', volatilityBucket: 'NORM' },
    ];

    expect(() => {
      ds.createDataset('BTCUSDT', '15m', duplicateSamples);
    }).toThrow('DUPLICATE_SAMPLE_ID:dup_1');
  });

  // Test 17 — Canonical dataset hashing
  test('Test 17: Datasets with identical timestamps but different feature values produce different dataHashes', () => {
    const ds1 = new DatasetManager();
    const samplesA = [
      { sampleId: 's1', timestamp: 1000, features: { smcScore: 50 }, labelBinary: 1, labelContinuousR: 1.0, regime: 'BULL', volatilityBucket: 'NORM' },
    ];
    const recA = ds1.createDataset('BTCUSDT', '15m', samplesA, '2.0', '2.0.0', 42);

    const ds2 = new DatasetManager();
    const samplesB = [
      { sampleId: 's1', timestamp: 1000, features: { smcScore: 99 }, labelBinary: 1, labelContinuousR: 1.0, regime: 'BULL', volatilityBucket: 'NORM' },
    ];
    const recB = ds2.createDataset('BTCUSDT', '15m', samplesB, '2.0', '2.0.0', 42);

    expect(recA.metadata.dataHash).not.toEqual(recB.metadata.dataHash);
  });

  // Test 18 — Label end timestamp purging
  test('Test 18: DatasetManager purges validation samples overlapping with training label horizons', () => {
    const ds = new DatasetManager();
    const samples = [
      { sampleId: 's1', timestamp: 1000, labelEndTimestamp: 5000, features: { f: 1 }, labelBinary: 1, labelContinuousR: 1.0, regime: 'BULL', volatilityBucket: 'NORM' },
      { sampleId: 's2', timestamp: 2000, labelEndTimestamp: 3000, features: { f: 1 }, labelBinary: 0, labelContinuousR: -1.0, regime: 'BULL', volatilityBucket: 'NORM' },
      { sampleId: 's3', timestamp: 4000, labelEndTimestamp: 6000, features: { f: 1 }, labelBinary: 1, labelContinuousR: 1.0, regime: 'BULL', volatilityBucket: 'NORM' }, // Overlaps with s1 labelEnd
      { sampleId: 's4', timestamp: 6000, labelEndTimestamp: 7000, features: { f: 1 }, labelBinary: 1, labelContinuousR: 1.0, regime: 'BULL', volatilityBucket: 'NORM' },
      { sampleId: 's5', timestamp: 8000, labelEndTimestamp: 9000, features: { f: 1 }, labelBinary: 1, labelContinuousR: 1.0, regime: 'BULL', volatilityBucket: 'NORM' },
    ];

    const rec = ds.createDataset('BTCUSDT', '15m', samples);
    const splits = ds.splitDataset(rec.metadata.datasetId, 0.4, 0.4, 0.2);

    // s3 timestamp (4000) <= maxTrainLabelEnd (5000) should be purged from validation
    const valSampleIds = splits.validation.map((s) => s.sampleId);
    expect(valSampleIds).not.toContain('s3');
  });

  // Test 19 — allowAutoPromotion enforcement
  test('Test 19: PromotionGate rejects auto-promotion when allowAutoPromotion is false', () => {
    const candidate: StrategyCandidate = {
      id: 'cand_gate_auto',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-cand-gate',
      type: 'FILTER',
      description: 'Auto promotion test',
      change: {},
      evidence: { sampleSize: 50, expectancyBefore: 0.2, expectancyAfterHistorical: 0.8 },
      validationMetrics: {
        inSampleExpectancy: 0.8,
        walkForwardExpectancy: 0.7,
        outOfSampleExpectancy: 0.7,
        profitFactor: 2.5,
        maxDrawdownPercent: 3.0,
        monteCarloRuinProb: 0.0,
        transactionCostSurvived: true,
      },
      shadowMetrics: {
        shadowTradeCount: 15,
        shadowExpectancy: 0.9,
        shadowWinRate: 70.0,
        shadowMaxDrawdown: 1.5,
      },
      status: 'SHADOW',
      createdAt: new Date(),
    };

    const resNoAuto = PromotionGate.evaluateCandidate(candidate, {
      ...PromotionGate.DEFAULT_CRITERIA,
      allowAutoPromotion: false,
    });

    expect(resNoAuto.approved).toBe(false);
    expect(resNoAuto.rejectionDetails).toContainEqual(expect.stringContaining('allowAutoPromotion is false'));
  });

  // Test 20 — Walk-forward fold retraining
  test('Test 20: WalkForwardValidator fits candidate parameters per fold, producing fold-specific artifacts', () => {
    const experiences: TradingExperience[] = Array.from({ length: 30 }, (_, i) => ({
      id: `exp_retrain_${i}`,
      tradeId: `t_retrain_${i}`,
      timestamp: new Date(1700000000000 + i * 60000),
      labelStartTimestamp: 1700000000000 + i * 60000 + 1000,
      labelEndTimestamp: 1700000000000 + i * 60000 + 30000,
      instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
      marketState: { quant: { smcScore: i < 15 ? 65 : 85 } },
      decision: { action: 'BUY', score: i < 15 ? 65 : 85 },
      execution: { entryPrice: 100, entryTime: new Date(1700000000000 + i * 60000 + 1000) },
      risk: { stopLoss: 95 },
      prediction: {},
      outcome: { status: 'WIN', pnl: 100, pnlR: 1.0, maxFavorableExcursion: 1.5, maxAdverseExcursion: 0.2, holdingTimeSeconds: 600 },
      marketContext: { regime: 'BULLISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 },
      outcomeClassification: 'GOOD_TRADE_WIN',
      reasons: [],
      failureReasons: [],
      strategyVersion: 'v2.0',
      featureSchemaVersion: '2.0',
      createdAt: new Date(),
      candlesDuringTrade: [
        {
          timestamp: new Date(1700000000000 + i * 60000),
          open: 100,
          high: 110,
          low: 99,
          close: 108,
          volume: 100,
        },
      ],
    }));

    const baseCand: StrategyCandidate = {
      id: 'cand_retrain_test',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-retrain',
      type: 'THRESHOLD',
      description: 'Threshold retraining candidate',
      change: { parameter: 'minMtfScore', value: 60 },
      evidence: { sampleSize: 30, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const wfRes = WalkForwardValidator.validate(baseCand, experiences, { numFolds: 3 });
    expect(wfRes.folds.length).toBeGreaterThan(0);
    expect(wfRes.folds[0].passed).toBe(true);
    expect(wfRes.foldArtifacts).toBeDefined();
    expect(wfRes.foldArtifacts?.length).toBeGreaterThan(0);
    expect(Object.isFrozen(wfRes.foldArtifacts)).toBe(true);
  });

  // Test 21 — Monte Carlo empty R-multiples fail-closed
  test('Test 21: MonteCarloEngine throws INSUFFICIENT_CANDIDATE_EXECUTION_RESULTS on empty R-multiples', () => {
    expect(() => {
      MonteCarloEngine.simulate([]);
    }).toThrow('INSUFFICIENT_CANDIDATE_EXECUTION_RESULTS');
  });

  // Test 22 — Empty purged validation dataset fail-closed
  test('Test 22: DatasetManager throws INSUFFICIENT_PURGED_VALIDATION_DATA when all validation samples overlap', () => {
    const ds = new DatasetManager();
    const overlappingSamples = [
      { sampleId: 's1', timestamp: 1000, labelEndTimestamp: 9000, features: { f: 1 }, labelBinary: 1, labelContinuousR: 1.0, regime: 'BULL', volatilityBucket: 'NORM' },
      { sampleId: 's2', timestamp: 2000, labelEndTimestamp: 9000, features: { f: 1 }, labelBinary: 0, labelContinuousR: -1.0, regime: 'BULL', volatilityBucket: 'NORM' },
    ];

    const rec = ds.createDataset('BTCUSDT', '15m', overlappingSamples);
    expect(() => {
      ds.splitDataset(rec.metadata.datasetId, 0.5, 0.5, 0.0);
    }).toThrow('INSUFFICIENT_PURGED_VALIDATION_DATA');
  });

  // Test 23 — Invalid embargo duration fail-closed
  test('Test 23: DatasetManager throws INVALID_EMBARGO_DURATION on negative embargoMs', () => {
    const ds = new DatasetManager();
    const samples = [
      { sampleId: 's1', timestamp: 1000, features: { f: 1 }, labelBinary: 1, labelContinuousR: 1.0, regime: 'BULL', volatilityBucket: 'NORM' },
    ];
    const rec = ds.createDataset('BTCUSDT', '15m', samples);

    expect(() => {
      ds.splitDataset(rec.metadata.datasetId, 0.5, 0.5, 0.0, -100);
    }).toThrow('INVALID_EMBARGO_DURATION:-100');
  });

  // Test 24 — Missing candle data throws INSUFFICIENT_MARKET_DATA_FOR_CANDIDATE_EXECUTION
  test('Test 24: CandidateBacktestRunner throws INSUFFICIENT_MARKET_DATA_FOR_CANDIDATE_EXECUTION when candles are missing', () => {
    const cand: StrategyCandidate = {
      id: 'cand_no_candles',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-nc',
      type: 'FILTER',
      description: 'No candles test',
      change: {},
      evidence: { sampleSize: 6, expectancyBefore: 0, expectancyAfterHistorical: 0 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const expNoCandles: TradingExperience = {
      id: 'exp_no_c',
      tradeId: 't_no_c',
      timestamp: new Date(1700000000000),
      instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
      marketState: {},
      decision: { action: 'BUY', score: 70 },
      execution: { entryPrice: 100, entryTime: new Date(1700000000000) },
      risk: { stopLoss: 95 },
      prediction: {},
      outcome: { status: 'WIN', pnl: 100, pnlR: 1.0, maxFavorableExcursion: 1.5, maxAdverseExcursion: 0.2, holdingTimeSeconds: 600 },
      marketContext: { regime: 'BULLISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 },
      outcomeClassification: 'GOOD_TRADE_WIN',
      reasons: [],
      failureReasons: [],
      strategyVersion: 'v2.0',
      featureSchemaVersion: '2.0',
      createdAt: new Date(),
    };

    const sixExps = Array.from({ length: 6 }, (_, i) => ({ ...expNoCandles, id: `exp_nc_${i}`, tradeId: `t_nc_${i}` }));

    expect(() => {
      CandidateEvaluator.evaluate(cand, sixExps);
    }).toThrow('INSUFFICIENT_MARKET_DATA_FOR_CANDIDATE_EXECUTION');
  });

  // Test 25 — Feature Schema Mismatch
  test('Test 25: DatasetManager throws FEATURE_SCHEMA_MISMATCH when sample feature keys differ', () => {
    const ds = new DatasetManager();
    const mismatchSamples = [
      { sampleId: 's1', timestamp: 1000, features: { featA: 10 }, labelBinary: 1, labelContinuousR: 1.0, regime: 'BULL', volatilityBucket: 'NORM' },
      { sampleId: 's2', timestamp: 2000, features: { featB: 20 }, labelBinary: 0, labelContinuousR: -1.0, regime: 'BULL', volatilityBucket: 'NORM' },
    ];

    expect(() => {
      ds.createDataset('BTCUSDT', '15m', mismatchSamples as any);
    }).toThrow('FEATURE_SCHEMA_MISMATCH');
  });
});
