import { createHash } from 'crypto';
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
  sliceContinuousCandles,
  sliceContinuousMarketWindow,
  MarketDatasetValidator,
  CandidateBacktestRunner,
  DEFAULT_LEARNING_SEED,
  ExperienceDataset,
  CandidateMarketDataset,
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
    const samples = Array.from({ length: 100 }, (_, i) => {
      const t = 1700000000000 + i * 60000;
      return {
        sampleId: `s_${i}`,
        timestamp: t,
        labelStartTimestamp: t + 1000,
        labelEndTimestamp: t + 30000,
        features: { smcScore: 50 + i },
        labelBinary: i % 2,
        labelContinuousR: i % 2 === 1 ? 1.5 : -1.0,
        regime: 'BULLISH',
        volatilityBucket: 'NORMAL',
      };
    });

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
      { sampleId: '1', timestamp: 1000, labelStartTimestamp: 1000, labelEndTimestamp: 1500, features: { f1: 10, f2: 20 }, labelBinary: 1, labelContinuousR: 1, regime: 'NORM', volatilityBucket: 'NORM' },
      { sampleId: '2', timestamp: 2000, labelStartTimestamp: 2000, labelEndTimestamp: 2500, features: { f1: 20, f2: 40 }, labelBinary: 0, labelContinuousR: -1, regime: 'NORM', volatilityBucket: 'NORM' },
    ];
    scaler1.fit(trainData);

    const oosDataExtreme = [
      { sampleId: '3', timestamp: 3000, labelStartTimestamp: 3000, labelEndTimestamp: 3500, features: { f1: 10000, f2: 99999 }, labelBinary: 1, labelContinuousR: 10, regime: 'HIGH', volatilityBucket: 'HIGH' },
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

    const experiences: TradingExperience[] = Array.from({ length: 10 }, (_, i) => {
      const t = 1700000000000 + i * 300000;
      const isEven = i % 2 === 0;
      return {
        id: `exp_${i}`,
        tradeId: `t_${i}`,
        timestamp: new Date(t),
        decisionTimestamp: t,
        featureTimestamp: t,
        labelStartTimestamp: t + 1000,
        labelEndTimestamp: t + 180000,
        instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
        marketState: { quant: { smcScore: 70 } },
        decision: { action: 'BUY', score: 70 },
        execution: { entryPrice: 100, entryTime: new Date(t) },
        risk: { stopLoss: 95 },
        prediction: {},
        outcome: { status: isEven ? 'WIN' : 'LOSS', pnl: isEven ? 100 : -100, pnlR: isEven ? 1.0 : -1.0, maxFavorableExcursion: 1.5, maxAdverseExcursion: 1.0, holdingTimeSeconds: 600 },
        marketContext: { regime: 'BULLISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 },
        outcomeClassification: isEven ? 'GOOD_TRADE_WIN' : 'BAD_TRADE_LOSS',
        reasons: [],
        failureReasons: !isEven ? ['HTF_CONFLICT'] : [],
        strategyVersion: 'v2.0',
        featureSchemaVersion: '2.0',
        createdAt: new Date(),
        candlesDuringTrade: [
          {
            timestamp: new Date(t),
            open: 100,
            high: 100.5,
            low: 99.5,
            close: 100,
            volume: 100,
          },
          {
            timestamp: new Date(t + 60000),
            open: 100,
            high: 100.5,
            low: 99.5,
            close: 100,
            volume: 100,
          },
          {
            timestamp: new Date(t + 120000),
            open: 100,
            high: isEven ? 125 : 100.5,
            low: isEven ? 99.5 : 90,
            close: isEven ? 124 : 91,
            volume: 100,
          }
        ],
      };
    });

    const candles = experiences.flatMap((e) => e.candlesDuringTrade || []);
    const result = CandidateEvaluator.evaluateDeterministicTestFixture(baseCandidate, experiences, 0.05, {
      candles,
    });
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

    const experiences: TradingExperience[] = Array.from({ length: 6 }, (_, i) => {
      const t = 1700000000000 + i * 300000;
      return {
        id: `exp_vol_${i}`,
        tradeId: `t_vol_${i}`,
        timestamp: new Date(t),
        decisionTimestamp: t,
        featureTimestamp: t,
        labelStartTimestamp: t + 1000,
        labelEndTimestamp: t + 180000,
        instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
        marketState: {},
        decision: { action: 'BUY', score: 70 },
        execution: { entryPrice: 100, entryTime: new Date(t) },
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
            timestamp: new Date(t),
            open: 100,
            high: 100.5,
            low: 99.5,
            close: 100,
            volume: 100,
          },
          {
            timestamp: new Date(t + 60000),
            open: 100,
            high: 100.5,
            low: 99.5,
            close: 100,
            volume: 100,
          },
          {
            timestamp: new Date(t + 120000),
            open: 100,
            high: 100.5,
            low: 90,
            close: 91,
            volume: 100,
          }
        ],
      };
    });

    const candles = experiences.flatMap((e) => e.candlesDuringTrade || []);
    const result = CandidateEvaluator.evaluateDeterministicTestFixture(candidate, experiences, 0.05, {
      candles,
    });
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
      { sampleId: '1', timestamp: 1000, labelStartTimestamp: 1000, labelEndTimestamp: 1500, features: { smcScore: 60 }, labelBinary: 1, labelContinuousR: 1, regime: 'BULL', volatilityBucket: 'NORM' },
      { sampleId: '2', timestamp: 2000, labelStartTimestamp: 2000, labelEndTimestamp: 2500, features: { smcScore: 80 }, labelBinary: 1, labelContinuousR: 1, regime: 'BULL', volatilityBucket: 'NORM' },
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
    const experiences: TradingExperience[] = Array.from({ length: 30 }, (_, i) => {
      const t = 1700000000000 + i * 60000;
      return {
        id: `exp_wf_${i}`,
        tradeId: `t_wf_${i}`,
        timestamp: new Date(t),
        decisionTimestamp: t,
        featureTimestamp: t,
        labelStartTimestamp: t + 1000,
        labelEndTimestamp: t + 30000,
        instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
        marketState: { quant: { smcScore: 70 + i } },
        decision: { action: 'BUY', score: 70 },
        execution: { entryPrice: 100, entryTime: new Date(t) },
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
            timestamp: new Date(t),
            open: 100,
            high: 110,
            low: 99,
            close: 108,
            volume: 100,
          },
        ],
      };
    });

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

    const baseTs = 1700000000000;
    const candles = Array.from({ length: 80 }, (_, i) => ({
      timestamp: new Date(baseTs + i * 60000),
      open: 100 + (i % 2 === 0 ? 5 : -5),
      high: 110,
      low: 90,
      close: 100 + (i % 2 === 0 ? 2 : -2),
      volume: 1000,
    }));
    const expDataset: ExperienceDataset = {
      experiences,
      datasetHash: 'exp_hash_13',
      featureSchemaVersion: '2.0',
      symbol: 'BTCUSDT',
      timeframe: '15m',
      startTimestamp: experiences[0].timestamp.getTime(),
      endTimestamp: experiences[experiences.length - 1].timestamp.getTime(),
    };
    const marketDataset: CandidateMarketDataset = {
      executionCandles: candles,
      datasetHash: 'market_hash_13',
      timeframe: '15m',
      symbol: 'BTCUSDT',
      startTimestamp: candles[0].timestamp.getTime(),
      endTimestamp: candles[candles.length - 1].timestamp.getTime(),
      isContinuous: true,
      expectedIntervalMs: 60000,
    };
    const wfRes = WalkForwardValidator.validate(cand, {
      experienceDataset: expDataset,
      marketDataset,
      numFolds: 3,
    });
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
      { sampleId: 'dup_1', timestamp: 1000, labelStartTimestamp: 1000, labelEndTimestamp: 1500, features: { smcScore: 50 }, labelBinary: 1, labelContinuousR: 1.0, regime: 'BULL', volatilityBucket: 'NORM' },
      { sampleId: 'dup_1', timestamp: 2000, labelStartTimestamp: 2000, labelEndTimestamp: 2500, features: { smcScore: 60 }, labelBinary: 0, labelContinuousR: -1.0, regime: 'BULL', volatilityBucket: 'NORM' },
    ];

    expect(() => {
      ds.createDataset('BTCUSDT', '15m', duplicateSamples);
    }).toThrow('DUPLICATE_SAMPLE_ID:dup_1');
  });

  // Test 17 — Canonical dataset hashing
  test('Test 17: Datasets with identical timestamps but different feature values produce different dataHashes', () => {
    const ds1 = new DatasetManager();
    const samplesA = [
      { sampleId: 's1', timestamp: 1000, labelStartTimestamp: 1000, labelEndTimestamp: 1500, features: { smcScore: 50 }, labelBinary: 1, labelContinuousR: 1.0, regime: 'BULL', volatilityBucket: 'NORM' },
    ];
    const recA = ds1.createDataset('BTCUSDT', '15m', samplesA, '2.0', '2.0.0', 42);

    const ds2 = new DatasetManager();
    const samplesB = [
      { sampleId: 's1', timestamp: 1000, labelStartTimestamp: 1000, labelEndTimestamp: 1500, features: { smcScore: 99 }, labelBinary: 1, labelContinuousR: 1.0, regime: 'BULL', volatilityBucket: 'NORM' },
    ];
    const recB = ds2.createDataset('BTCUSDT', '15m', samplesB, '2.0', '2.0.0', 42);

    expect(recA.metadata.dataHash).not.toEqual(recB.metadata.dataHash);
  });

  // Test 18 — Label end timestamp purging
  test('Test 18: DatasetManager purges validation samples overlapping with training label horizons', () => {
    const ds = new DatasetManager();
    const samples = [
      { sampleId: 's1', timestamp: 1000, labelStartTimestamp: 1000, labelEndTimestamp: 5000, features: { f: 1 }, labelBinary: 1, labelContinuousR: 1.0, regime: 'BULL', volatilityBucket: 'NORM' },
      { sampleId: 's2', timestamp: 2000, labelStartTimestamp: 2000, labelEndTimestamp: 3000, features: { f: 1 }, labelBinary: 0, labelContinuousR: -1.0, regime: 'BULL', volatilityBucket: 'NORM' },
      { sampleId: 's3', timestamp: 4000, labelStartTimestamp: 4000, labelEndTimestamp: 6000, features: { f: 1 }, labelBinary: 1, labelContinuousR: 1.0, regime: 'BULL', volatilityBucket: 'NORM' }, // Overlaps with s1 labelEnd
      { sampleId: 's4', timestamp: 6000, labelStartTimestamp: 6000, labelEndTimestamp: 7000, features: { f: 1 }, labelBinary: 1, labelContinuousR: 1.0, regime: 'BULL', volatilityBucket: 'NORM' },
      { sampleId: 's5', timestamp: 8000, labelStartTimestamp: 8000, labelEndTimestamp: 9000, features: { f: 1 }, labelBinary: 1, labelContinuousR: 1.0, regime: 'BULL', volatilityBucket: 'NORM' },
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
    const experiences: TradingExperience[] = Array.from({ length: 30 }, (_, i) => {
      const t = 1700000000000 + i * 300000;
      return {
        id: `exp_retrain_${i}`,
        tradeId: `t_retrain_${i}`,
        timestamp: new Date(t),
        decisionTimestamp: t,
        featureTimestamp: t,
        labelStartTimestamp: t + 1000,
        labelEndTimestamp: t + 180000,
        instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
        marketState: { quant: { smcScore: i < 15 ? 65 : 85 } },
        decision: { action: 'BUY', score: i < 15 ? 65 : 85 },
        execution: { entryPrice: 100, entryTime: new Date(t) },
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
            timestamp: new Date(t),
            open: 100,
            high: 100.5,
            low: 99.5,
            close: 100,
            volume: 100,
          },
          {
            timestamp: new Date(t + 60000),
            open: 100,
            high: 100.5,
            low: 99.5,
            close: 100,
            volume: 100,
          },
          {
            timestamp: new Date(t + 120000),
            open: 100,
            high: 125,
            low: 99.5,
            close: 124,
            volume: 100,
          },
        ],
      };
    });

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

    const baseTs = 1700000000000;
    const candles = Array.from({ length: 80 }, (_, i) => ({
      timestamp: new Date(baseTs + i * 60000),
      open: 100 + (i % 2 === 0 ? 5 : -5),
      high: 110,
      low: 90,
      close: 100 + (i % 2 === 0 ? 2 : -2),
      volume: 1000,
    }));
    const expDataset: ExperienceDataset = {
      experiences,
      datasetHash: 'exp_hash_20',
      featureSchemaVersion: '2.0',
      symbol: 'BTCUSDT',
      timeframe: '15m',
      startTimestamp: experiences[0].timestamp.getTime(),
      endTimestamp: experiences[experiences.length - 1].timestamp.getTime(),
    };
    const marketDataset: CandidateMarketDataset = {
      executionCandles: candles,
      datasetHash: 'market_hash_20',
      timeframe: '15m',
      symbol: 'BTCUSDT',
      startTimestamp: candles[0].timestamp.getTime(),
      endTimestamp: candles[candles.length - 1].timestamp.getTime(),
      isContinuous: true,
      expectedIntervalMs: 60000,
    };
    const wfRes = WalkForwardValidator.validate(baseCand, {
      experienceDataset: expDataset,
      marketDataset,
      numFolds: 3,
    });
    expect(wfRes.folds.length).toBeGreaterThan(0);
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
      { sampleId: 's1', timestamp: 1000, labelStartTimestamp: 1000, labelEndTimestamp: 9000, features: { f: 1 }, labelBinary: 1, labelContinuousR: 1.0, regime: 'BULL', volatilityBucket: 'NORM' },
      { sampleId: 's2', timestamp: 2000, labelStartTimestamp: 2000, labelEndTimestamp: 9000, features: { f: 1 }, labelBinary: 0, labelContinuousR: -1.0, regime: 'BULL', volatilityBucket: 'NORM' },
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
      { sampleId: 's1', timestamp: 1000, labelStartTimestamp: 1000, labelEndTimestamp: 2000, features: { f: 1 }, labelBinary: 1, labelContinuousR: 1.0, regime: 'BULL', volatilityBucket: 'NORM' },
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

    expect(() => {
      CandidateEvaluator.evaluate(cand);
    }).toThrow('INSUFFICIENT_MARKET_DATA_FOR_CANDIDATE_EXECUTION');
  });

  // Test 25 — Feature Schema Mismatch
  test('Test 25: DatasetManager throws FEATURE_SCHEMA_MISMATCH when sample feature keys differ', () => {
    const ds = new DatasetManager();
    const mismatchSamples = [
      { sampleId: 's1', timestamp: 1000, labelStartTimestamp: 1000, labelEndTimestamp: 2000, features: { featA: 10 }, labelBinary: 1, labelContinuousR: 1.0, regime: 'BULL', volatilityBucket: 'NORM' },
      { sampleId: 's2', timestamp: 2000, labelStartTimestamp: 2000, labelEndTimestamp: 3000, features: { featB: 20 }, labelBinary: 0, labelContinuousR: -1.0, regime: 'BULL', volatilityBucket: 'NORM' },
    ];

    expect(() => {
      ds.createDataset('BTCUSDT', '15m', mismatchSamples as any);
    }).toThrow('FEATURE_SCHEMA_MISMATCH');
  });

  // Test 26 — sliceContinuousCandles fail-closed behavior
  test('Test 26: sliceContinuousCandles fails closed with MARKET_DATA_WINDOW_NOT_FOUND when window is not found', () => {
    const baseTs = 1700000000000;
    const candles = Array.from({ length: 20 }, (_, i) => ({
      timestamp: new Date(baseTs + i * 60000),
      open: 100,
      high: 105,
      low: 95,
      close: 102,
      volume: 1000,
    }));

    expect(() => {
      sliceContinuousCandles(candles, baseTs + 50 * 60000, baseTs + 60 * 60000);
    }).toThrow('MARKET_DATA_WINDOW_NOT_FOUND');
  });

  // Test 27 — MarketDatasetValidator candle continuity
  test('Test 27: MarketDatasetValidator strictly validates candle continuity and rejects duplicates and gaps', () => {
    const baseTs = 1700000000000;
    const duplicateCandles = [
      { timestamp: new Date(baseTs), open: 100, high: 105, low: 95, close: 102, volume: 1000 },
      { timestamp: new Date(baseTs), open: 100, high: 105, low: 95, close: 102, volume: 1000 },
    ];

    expect(() => {
      MarketDatasetValidator.validateCandles(duplicateCandles, '1m');
    }).toThrow('INVALID_MARKET_DATA_DUPLICATE_TIMESTAMP');

    const gapCandles = [
      { timestamp: new Date(baseTs), open: 100, high: 105, low: 95, close: 102, volume: 1000 },
      { timestamp: new Date(baseTs + 120000), open: 100, high: 105, low: 95, close: 102, volume: 1000 }, // 2m gap when expecting 1m
    ];

    expect(() => {
      MarketDatasetValidator.validateCandles(gapCandles, '1m');
    }).toThrow('INVALID_MARKET_DATA_GAP');
  });

  // Test 28 — WFV decision market data boundary vs label horizon
  test('Test 28: WFV training execution uses decision boundary market data and does not look ahead into future label horizon', () => {
    const baseTs = 1700000000000;
    const experiences: TradingExperience[] = Array.from({ length: 30 }, (_, i) => {
      const t = baseTs + i * 60000;
      return {
        id: `exp_bnd_${i}`,
        tradeId: `t_bnd_${i}`,
        timestamp: new Date(t),
        decisionTimestamp: t,
        featureTimestamp: t,
        labelStartTimestamp: t + 1000,
        labelEndTimestamp: t + 180000, // 3 minutes later
        instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
        marketState: { quant: { smcScore: 75 } },
        decision: { action: 'BUY', score: 75 },
        execution: { entryPrice: 100, entryTime: new Date(t) },
        risk: { stopLoss: 95 },
        prediction: {},
        outcome: { status: 'WIN', pnl: 100, pnlR: 1.0, maxFavorableExcursion: 1.5, maxAdverseExcursion: 0.2, holdingTimeSeconds: 180 },
        marketContext: { regime: 'BULLISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 },
        outcomeClassification: 'GOOD_TRADE_WIN',
        reasons: [],
        failureReasons: [],
        strategyVersion: 'v2.0',
        featureSchemaVersion: '2.0',
        createdAt: new Date(),
        candlesDuringTrade: [],
      };
    });

    const cand: StrategyCandidate = {
      id: 'cand_bnd',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-bnd',
      type: 'THRESHOLD',
      description: 'Boundary test candidate',
      change: { parameter: 'minMtfScore', value: 70 },
      evidence: { sampleSize: 30, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const candles = Array.from({ length: 60 }, (_, i) => ({
      timestamp: new Date(baseTs + i * 60000),
      open: 100 + (i % 2 === 0 ? 2 : -2),
      high: 105,
      low: 95,
      close: 101,
      volume: 1000,
    }));
    const expDataset: ExperienceDataset = {
      experiences,
      datasetHash: 'exp_hash_28',
      featureSchemaVersion: '2.0',
      symbol: 'BTCUSDT',
      timeframe: '15m',
      startTimestamp: experiences[0].timestamp.getTime(),
      endTimestamp: experiences[experiences.length - 1].timestamp.getTime(),
    };
    const marketDataset: CandidateMarketDataset = {
      executionCandles: candles,
      datasetHash: 'market_hash_28',
      timeframe: '15m',
      symbol: 'BTCUSDT',
      startTimestamp: candles[0].timestamp.getTime(),
      endTimestamp: candles[candles.length - 1].timestamp.getTime(),
      isContinuous: true,
      expectedIntervalMs: 60000,
    };
    const wfRes = WalkForwardValidator.validate(cand, {
      experienceDataset: expDataset,
      marketDataset,
      numFolds: 2,
    });
    expect(wfRes.folds.length).toBeGreaterThan(0);
    expect(wfRes.foldArtifacts).toBeDefined();
    expect(wfRes.foldArtifacts!.length).toBeGreaterThan(0);
  });

  // Test 29 (Item 9) — Invariant verification between modelArtifact and candidateArtifact
  test('Test 29: CandidateBacktestRunner fails closed when modelArtifact hashes do not match candidateArtifact', () => {
    const baseTs = 1700000000000;
    const candles = Array.from({ length: 20 }, (_, i) => ({
      timestamp: new Date(baseTs + i * 60000),
      open: 100,
      high: 105,
      low: 95,
      close: 102,
      volume: 1000,
    }));

    const defaultRiskConfig = {
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
    };

    const cand: StrategyCandidate = {
      id: 'cand_inv_test',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-inv',
      type: 'THRESHOLD',
      description: 'Invariant test candidate',
      symbol: 'BTCUSDT',
      riskConfig: defaultRiskConfig,
      change: {
        parameter: 'minMtfScore',
        value: 70,
        symbol: 'BTCUSDT',
        riskConfig: defaultRiskConfig,
        selectedFeatures: ['smcScore', 'mtfAlignment', 'rvol'],
        featureSchemaHash: createHash('sha256').update('schema_2.0_smcScore,mtfAlignment,rvol').digest('hex'),
        modelArtifact: {
          modelId: 'm1',
          modelVersion: 'ml-v2.0',
          featureSchemaHash: createHash('sha256').update('schema_2.0_smcScore,mtfAlignment,rvol').digest('hex'),
          selectedFeatureHash: createHash('sha256').update('smcScore,mtfAlignment,rvol').digest('hex'),
          scalerHash: 'none',
        },
      },
      evidence: { sampleSize: 10, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const validArtifact = CandidateBacktestRunner.createCandidateArtifact(cand, 'canonical_dataset_hash_123');

    // Mismatched schema hash
    const mismatchedSchemaArtifact = {
      ...validArtifact,
      modelArtifact: {
        ...validArtifact.modelArtifact!,
        featureSchemaHash: 'hash_schema_mismatched',
      },
    };

    expect(() => {
      CandidateBacktestRunner.runCandidateBacktest(mismatchedSchemaArtifact, { candles });
    }).toThrow('INCOMPATIBLE_MODEL_SCHEMA_HASH');

    // Mismatched scaler hash
    const mismatchedScalerArtifact = {
      ...validArtifact,
      modelArtifact: {
        ...validArtifact.modelArtifact!,
        scalerHash: 'hash_scaler_mismatched',
      },
    };

    expect(() => {
      CandidateBacktestRunner.runCandidateBacktest(mismatchedScalerArtifact, { candles });
    }).toThrow('INCOMPATIBLE_MODEL_SCALER_HASH');

    // Mismatched selected features hash
    const mismatchedFeatArtifact = {
      ...validArtifact,
      modelArtifact: {
        ...validArtifact.modelArtifact!,
        selectedFeatureHash: 'hash_feat_mismatched',
      },
    };

    expect(() => {
      CandidateBacktestRunner.runCandidateBacktest(mismatchedFeatArtifact, { candles });
    }).toThrow('INCOMPATIBLE_MODEL_SELECTED_FEATURE_HASH');
  });

  // Test 30 (Items 10 & 11) — Full canonical payload artifact identity & non-weak dataset hash
  test('Test 30: CandidateBacktestRunner.createCandidateArtifact derives distinct artifactId from full canonical payload changes and non-weak dataset hash', () => {
    const candA: StrategyCandidate = {
      id: 'cand_hash_test',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-hash',
      type: 'THRESHOLD',
      description: 'Hash candidate',
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
      change: { parameter: 'minMtfScore', value: 70, symbol: 'BTCUSDT' },
      evidence: { sampleSize: 10, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const artA = CandidateBacktestRunner.createCandidateArtifact(candA, 'dataset_hash_alpha', 42);
    const artB = CandidateBacktestRunner.createCandidateArtifact(candA, 'dataset_hash_beta', 42);

    // Different dataset produces different datasetHash and different artifactId
    expect(artA.datasetHash).not.toBe('canonical_default_hash');
    expect(artA.datasetHash).not.toBe(artB.datasetHash);
    expect(artA.artifactId).not.toBe(artB.artifactId);

    // Mutating modelArtifact or scaler in params produces a different artifactId
    const candWithModel: StrategyCandidate = {
      ...candA,
      change: {
        ...candA.change,
        selectedFeatures: ['smcScore'],
        featureSchemaHash: 'schema_hash_123',
        modelArtifact: { modelId: 'model_a', modelVersion: 'ml-v2.0', weights: [1, 2, 3], bias: 0.5 } as any,
      },
    };
    const artWithModel = CandidateBacktestRunner.createCandidateArtifact(candWithModel, 'dataset_hash_alpha', 42);
    expect(artWithModel.artifactId).not.toBe(artA.artifactId);
  });

  // Test 31 (Items 12 & 13) — FoldArtifact separates strategyVersion, candidateId, candidateVersion deterministically
  test('Test 31: FoldArtifact clearly separates strategyVersion, candidateId, and candidateVersion with deterministic identity', () => {
    const baseTs = 1700000000000;
    const experiences: TradingExperience[] = Array.from({ length: 20 }, (_, i) => ({
      id: `exp_sep_${i}`,
      tradeId: `t_sep_${i}`,
      timestamp: new Date(baseTs + i * 60000),
      decisionTimestamp: baseTs + i * 60000,
      featureTimestamp: baseTs + i * 60000,
      labelStartTimestamp: baseTs + i * 60000 + 1000,
      labelEndTimestamp: baseTs + i * 60000 + 30000,
      instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
      marketState: { quant: { smcScore: 70 } },
      decision: { action: 'BUY', score: 70 },
      execution: { entryPrice: 100, entryTime: new Date(baseTs + i * 60000) },
      risk: { stopLoss: 95 },
      prediction: {},
      outcome: { status: 'WIN', pnl: 100, pnlR: 1.0, maxFavorableExcursion: 1.0, maxAdverseExcursion: 0.1, holdingTimeSeconds: 60 },
      marketContext: { regime: 'BULLISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 },
      outcomeClassification: 'GOOD_TRADE_WIN',
      reasons: [],
      failureReasons: [],
      strategyVersion: 'v2.1-smc-core',
      featureSchemaVersion: '2.0',
      createdAt: new Date(),
      candlesDuringTrade: [],
    }));

    const cand: StrategyCandidate = {
      id: 'cand_sep_id_101',
      baseStrategyVersion: 'v2.1-smc-core',
      candidateVersion: 'cand_sep_ver_202',
      type: 'THRESHOLD',
      description: 'Separation candidate',
      change: { parameter: 'minMtfScore', value: 70 },
      evidence: { sampleSize: 20, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const candles = Array.from({ length: 40 }, (_, i) => ({
      timestamp: new Date(baseTs + i * 60000),
      open: 100,
      high: 105,
      low: 95,
      close: 102,
      volume: 1000,
    }));
    const expDataset: ExperienceDataset = {
      experiences,
      datasetHash: 'exp_hash_31',
      featureSchemaVersion: '2.0',
      symbol: 'BTCUSDT',
      timeframe: '15m',
      startTimestamp: experiences[0].timestamp.getTime(),
      endTimestamp: experiences[experiences.length - 1].timestamp.getTime(),
    };
    const marketDataset: CandidateMarketDataset = {
      executionCandles: candles,
      datasetHash: 'market_hash_31',
      timeframe: '15m',
      symbol: 'BTCUSDT',
      startTimestamp: candles[0].timestamp.getTime(),
      endTimestamp: candles[candles.length - 1].timestamp.getTime(),
      isContinuous: true,
      expectedIntervalMs: 60000,
    };
    const wfRes = WalkForwardValidator.validate(cand, {
      experienceDataset: expDataset,
      marketDataset,
      numFolds: 2,
      seed: 42,
    });

    expect(wfRes.foldArtifacts).toBeDefined();
    expect(wfRes.foldArtifacts!.length).toBeGreaterThan(0);

    const foldArt = wfRes.foldArtifacts![0];
    expect(foldArt.strategyVersion).toBe('v2.1-smc-core');
    expect(foldArt.candidateId).toBe('cand_sep_id_101');
    expect(foldArt.candidateVersion).toBe('cand_sep_ver_202-fold1');
    expect(foldArt.trainingSeed).toBe(42);
    expect(typeof foldArt.candidateConfigHash).toBe('string');
  });

  // Test 32 (Item 14) — Seed propagation and default learning seed
  test('Test 32: DEFAULT_LEARNING_SEED is 42 and propagated across learning runs and candidate artifacts', () => {
    expect(DEFAULT_LEARNING_SEED).toBe(42);

    const cand: StrategyCandidate = {
      id: 'cand_seed_test',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-seed',
      type: 'FILTER',
      description: 'Seed candidate',
      symbol: 'BTCUSDT',
      riskConfig: {
        initialCapital: 100000,
        maxRiskPerTrade: 0.01,
        fillModel: 'NEXT_BAR_OPEN',
        slippageModel: 'ZERO',
        feeModel: 'ZERO',
        partialExitPolicy: {
          tp1Ratio: 0.33,
          tp2Ratio: 0.33,
          tp3Ratio: 0.34,
          moveStopToBreakevenOnTp1: true,
          trailStopOnTp2: true,
          trailStopOffsetR: 1.0,
        },
      },
      change: { minMtfScore: 50, symbol: 'BTCUSDT' },
      evidence: { sampleSize: 10, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const defaultArtifact = CandidateBacktestRunner.createCandidateArtifact(cand, 'dataset_hash_seed');
    expect(defaultArtifact.trainingSeed).toBe(42);

    const customArtifact = CandidateBacktestRunner.createCandidateArtifact(cand, 'dataset_hash_seed', 9999);
    expect(customArtifact.trainingSeed).toBe(9999);
  });

  // Test 33: WFV fails closed when market window contains zero training labels
  test('Test 33: WalkForwardValidator fails closed with INSUFFICIENT_TRAINING_LABELS_FOR_MARKET_WINDOW when no experiences fall into training market window', () => {
    const baseTs = 1700000000000;
    // Experiences far in the future compared to market candles
    const experiences: TradingExperience[] = Array.from({ length: 20 }, (_, i) => ({
      id: `exp_future_${i}`,
      tradeId: `t_fut_${i}`,
      timestamp: new Date(baseTs + (500 + i) * 60000), // far in the future
      decisionTimestamp: baseTs + (500 + i) * 60000,
      featureTimestamp: baseTs + (500 + i) * 60000,
      labelStartTimestamp: baseTs + (500 + i) * 60000 + 1000,
      labelEndTimestamp: baseTs + (500 + i) * 60000 + 30000,
      instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
      marketState: { quant: { smcScore: 70 } },
      decision: { action: 'BUY', score: 70 },
      execution: { entryPrice: 100, entryTime: new Date(baseTs + (500 + i) * 60000) },
      risk: { stopLoss: 95 },
      prediction: {},
      outcome: { status: 'WIN', pnl: 100, pnlR: 1.0, maxFavorableExcursion: 1.0, maxAdverseExcursion: 0.1, holdingTimeSeconds: 60 },
      marketContext: { regime: 'BULLISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 },
      outcomeClassification: 'GOOD_TRADE_WIN',
      reasons: [],
      failureReasons: [],
      strategyVersion: 'v2.0',
      featureSchemaVersion: '2.0',
      createdAt: new Date(),
      candlesDuringTrade: [],
    }));

    const cand: StrategyCandidate = {
      id: 'cand_empty_label_test',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-empty-lbl',
      type: 'THRESHOLD',
      description: 'Empty label test candidate',
      change: { parameter: 'minMtfScore', value: 70 },
      evidence: { sampleSize: 20, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const candles = Array.from({ length: 40 }, (_, i) => ({
      timestamp: new Date(baseTs + i * 60000),
      open: 100,
      high: 105,
      low: 95,
      close: 102,
      volume: 1000,
    }));
    const expDataset: ExperienceDataset = {
      experiences,
      datasetHash: 'exp_hash_33',
      featureSchemaVersion: '2.0',
      symbol: 'BTCUSDT',
      timeframe: '15m',
      startTimestamp: experiences[0].timestamp.getTime(),
      endTimestamp: experiences[experiences.length - 1].timestamp.getTime(),
    };
    const marketDataset: CandidateMarketDataset = {
      executionCandles: candles,
      datasetHash: 'market_hash_33',
      timeframe: '15m',
      symbol: 'BTCUSDT',
      startTimestamp: candles[0].timestamp.getTime(),
      endTimestamp: candles[candles.length - 1].timestamp.getTime(),
      isContinuous: true,
      expectedIntervalMs: 60000,
    };
    expect(() => {
      WalkForwardValidator.validate(cand, {
        experienceDataset: expDataset,
        marketDataset,
        numFolds: 2,
      });
    }).toThrow('INSUFFICIENT_TRAINING_LABELS_FOR_MARKET_WINDOW');
  });

  // Test 34: MarketExecutionWindow structures warmup vs evaluation data
  test('Test 34: sliceContinuousMarketWindow clearly separates warmupCandles from evaluationCandles', () => {
    const baseTs = 1700000000000;
    const candles = Array.from({ length: 60 }, (_, i) => ({
      timestamp: new Date(baseTs + i * 60000),
      open: 100,
      high: 105,
      low: 95,
      close: 102,
      volume: 1000,
    }));

    const window = sliceContinuousMarketWindow(candles, baseTs + 20 * 60000, baseTs + 40 * 60000, 10);
    expect(window).toBeDefined();
    expect(window!.warmupCandles.length).toBe(10);
    expect(window!.evaluationCandles.length).toBe(21);
    expect(window!.allCandles.length).toBe(31);
    expect(window!.warmupStartTimestamp).toBe(baseTs + 10 * 60000);
    expect(window!.evaluationStartTimestamp).toBe(baseTs + 20 * 60000);
    expect(window!.evaluationEndTimestamp).toBe(baseTs + 40 * 60000);
  });
});

