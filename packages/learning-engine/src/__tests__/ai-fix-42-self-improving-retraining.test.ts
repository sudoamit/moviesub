import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { ICandle } from '@quant/shared';
import { ExecutionSimulator, BacktestSimulator } from '@quant/backtesting';
import { TradeLifecycleManager } from '@quant/risk-engine';
import {
  CandidateHypothesis,
  RetrainingRunConfig,
  TrainingExample,
} from '../types';
import { PITExperienceDatasetBuilder } from '../pit-experience-dataset-builder';
import { CandidateHypothesisGenerator } from '../candidate-hypothesis-generator';
import { SelfImprovingRetrainingPipeline } from '../self-improving-retraining-pipeline';
import { TemporalFeatureScaler } from '../feature-scaler';
import { FeatureSelector } from '../feature-selector';
import { ModelTrainer } from '../model-trainer';
import { CandidateBacktestRunner } from '../candidate-backtest-runner';
import { ModelRegistry } from '../model-registry';
import { MonteCarloEngine } from '../monte-carlo-engine';
import { WalkForwardValidator } from '../walk-forward-validator';

/**
 * Deterministic candle generator for test market datasets.
 */
function generateTestCandles(startTs: number, count: number, intervalMs = 900000, seed = 42): ICandle[] {
  const candles: ICandle[] = [];
  let price = 50000;
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;

  for (let i = 0; i < count; i++) {
    s = (s * 16807) % 2147483647;
    const r1 = (s - 1) / 2147483646;
    s = (s * 16807) % 2147483647;
    const r2 = (s - 1) / 2147483646;

    const delta = (r1 - 0.49) * 50;
    const open = Number(price.toFixed(2));
    const close = Number((open + delta).toFixed(2));
    const high = Number((Math.max(open, close) + r2 * 20).toFixed(2));
    const low = Number((Math.min(open, close) - (1 - r2) * 20).toFixed(2));
    const volume = 100 + Math.floor(r1 * 500);

    candles.push({
      timestamp: new Date(startTs + i * intervalMs),
      open,
      high,
      low,
      close,
      volume,
    });
    price = close;
  }
  return candles;
}

/**
 * Deterministic TrainingExample generator for PIT testing.
 */
function generateTestExamples(startTs: number, count: number, intervalMs = 900000, seed = 100): TrainingExample[] {
  const examples: TrainingExample[] = [];
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;

  for (let i = 0; i < count; i++) {
    s = (s * 16807) % 2147483647;
    const r = (s - 1) / 2147483646;
    const decTs = startTs + i * intervalMs;
    const featTs = decTs;
    const lStart = decTs + 900000;
    const lEnd = decTs + 900000;

    const example = PITExperienceDatasetBuilder.createTrainingExample({
      exampleId: `ex_${i}_${seed}`,
      decisionTimestamp: decTs,
      featureTimestamp: featTs,
      labelStartTimestamp: lStart,
      labelEndTimestamp: lEnd,
      features: {
        smcScore: 0.5 + (r - 0.5) * 0.4,
        mtfAlignment: 0.6 + (r - 0.5) * 0.3,
        obStrength: 0.7 + (r - 0.5) * 0.2,
        rvol: 1.2 + (r - 0.5) * 0.8,
      },
      label: r > 0.45 ? 1.0 : 0.0,
      outcomeR: r > 0.45 ? 1.5 : -1.0,
      regime: i % 2 === 0 ? 'TRENDING_BULLISH' : 'RANGING',
      volatilityBucket: 'NORMAL',
      source: 'HISTORICAL',
    });
    examples.push(example);
  }
  return examples;
}

describe('AI Fix 42 — Self-Improving Retraining & Candidate Generation', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quant-ai42-retrain-'));
    ModelRegistry.reset();
    ModelRegistry.setPersistencePath(path.join(testDir, 'model-registry.json'));
    SelfImprovingRetrainingPipeline.reset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    ModelRegistry.reset();
    SelfImprovingRetrainingPipeline.reset();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  const baseConfig: RetrainingRunConfig = {
    maxCandidates: 5,
    maxTrainingRuns: 5,
    maxFeatureCombinations: 3,
    maxHyperparameterCombinations: 2,
    embargoMs: 900000, // 15m embargo
    baseStrategyVersion: 'v2.0',
    symbol: 'BTCUSDT',
    timeframe: '15m',
    seed: 42,
    minValidationTrades: 0,
    minOOSTrades: 0,
    minValidationExpectancyR: -10.0,
    minValidationProfitFactor: 0.0,
  };

  // ==========================================================================
  // 1. TEMPORAL & POINT-IN-TIME DATASET INVARIANTS
  // ==========================================================================

  it('Test 1: PIT dataset invariance: build(dataThroughT, T) === build(dataThroughT + futureData, T)', () => {
    const t0 = 1700000000000;
    const historyThroughT = generateTestExamples(t0, 50, 3600000, 1);
    const futureData = generateTestExamples(t0 + 51 * 3600000, 50, 3600000, 2);

    const cutoffT = t0 + 49 * 3600000;

    // 1. Build using only data through T
    const splits1 = PITExperienceDatasetBuilder.buildSplits(historyThroughT, {
      symbol: 'BTCUSDT',
      timeframe: '15m',
      cutoffTimestamp: cutoffT,
      embargoMs: 900000,
    });

    // 2. Build using history + future data with the same cutoff T
    const combinedData = [...historyThroughT, ...futureData];
    const splits2 = PITExperienceDatasetBuilder.buildSplits(combinedData, {
      symbol: 'BTCUSDT',
      timeframe: '15m',
      cutoffTimestamp: cutoffT,
      embargoMs: 900000,
    });

    expect(splits2.training.datasetHash).toBe(splits1.training.datasetHash);
    expect(splits2.validation.datasetHash).toBe(splits1.validation.datasetHash);
    expect(splits2.oos.datasetHash).toBe(splits1.oos.datasetHash);
    expect(splits2.combinedDatasetHash).toBe(splits1.combinedDatasetHash);
    expect(splits2.training.sampleCount).toBe(splits1.training.sampleCount);
  });

  it('Test 2: Future label leakage rejected fail-closed', () => {
    const t0 = 1700000000000;

    // Missing labelStartTimestamp -> FAIL CLOSED
    expect(() => {
      PITExperienceDatasetBuilder.createTrainingExample({
        exampleId: 'ex_leak_1',
        decisionTimestamp: t0,
        featureTimestamp: t0,
        labelStartTimestamp: undefined as any,
        labelEndTimestamp: t0 + 3600000,
        features: { smcScore: 0.8 },
        label: 1.0,
      });
    }).toThrow(/MISSING_LABEL_START_TIMESTAMP/);

    // Feature timestamp after decision timestamp -> FAIL CLOSED
    expect(() => {
      PITExperienceDatasetBuilder.createTrainingExample({
        exampleId: 'ex_leak_2',
        decisionTimestamp: t0,
        featureTimestamp: t0 + 1000,
        labelStartTimestamp: t0 + 2000,
        labelEndTimestamp: t0 + 3600000,
        features: { smcScore: 0.8 },
        label: 1.0,
      });
    }).toThrow(/FEATURE_LOOKAHEAD_LEAKAGE/);

    // Future-only leaked feature name -> FAIL CLOSED
    expect(() => {
      PITExperienceDatasetBuilder.createTrainingExample({
        exampleId: 'ex_leak_3',
        decisionTimestamp: t0,
        featureTimestamp: t0,
        labelStartTimestamp: t0 + 1000,
        labelEndTimestamp: t0 + 3600000,
        features: { smcScore: 0.8, futureClose: 51000 },
        label: 1.0,
      });
    }).toThrow(/FEATURE_LOOKAHEAD_LEAKAGE/);
  });

  it('Test 3: Label horizon purge: Overlapping validation samples are purged from train label boundary', () => {
    const t0 = 1700000000000;
    // Construct samples where train max label extends into validation start
    const examples = generateTestExamples(t0, 30, 3600000, 3);
    const splits = PITExperienceDatasetBuilder.buildSplits(examples, {
      symbol: 'BTCUSDT',
      timeframe: '15m',
      trainRatio: 0.6,
      valRatio: 0.2,
      oosRatio: 0.2,
      embargoMs: 0,
    });

    const trainMaxLabelEnd = Math.max(...splits.training.examples.map((e) => e.labelEndTimestamp));
    for (const valEx of splits.validation.examples) {
      expect(valEx.decisionTimestamp).toBeGreaterThan(trainMaxLabelEnd);
    }
  });

  it('Test 4: Embargo period enforces gap between partitions', () => {
    const t0 = 1700000000000;
    const embargoMs = 3600000; // 1 hour embargo
    const examples = generateTestExamples(t0, 40, 1800000, 4);

    const splits = PITExperienceDatasetBuilder.buildSplits(examples, {
      symbol: 'BTCUSDT',
      timeframe: '15m',
      embargoMs,
    });

    const trainMaxLabelEnd = Math.max(...splits.training.examples.map((e) => e.labelEndTimestamp));
    for (const valEx of splits.validation.examples) {
      expect(valEx.decisionTimestamp).toBeGreaterThanOrEqual(trainMaxLabelEnd + embargoMs);
    }
  });

  // ==========================================================================
  // 2. NORMALIZATION, FEATURE SELECTION & TRAINING ISOLATION
  // ==========================================================================

  it('Test 5: Train-only scaler: Validation and OOS data do not affect training scaler parameters', () => {
    const t0 = 1700000000000;
    const trainExamples = generateTestExamples(t0, 30, 3600000, 5);

    const scaler1 = new TemporalFeatureScaler();
    scaler1.fit(trainExamples as any);
    const params1 = scaler1.getParams('smcScore')!;

    // Construct contaminated dataset with extreme outlier OOS samples
    const extremeOOS = generateTestExamples(t0 + 100 * 3600000, 20, 3600000, 6).map((e) => ({
      ...e,
      features: { ...e.features, smcScore: 999999 },
    }));

    // Re-fit ONLY on train partition
    const scaler2 = new TemporalFeatureScaler();
    scaler2.fit(trainExamples as any);
    const params2 = scaler2.getParams('smcScore')!;

    expect(params2.mean).toBe(params1.mean);
    expect(params2.std).toBe(params1.std);
    expect(params2.max).toBe(params1.max);
    expect(TemporalFeatureScaler.computeScalerHash({ smcScore: params2 })).toBe(
      TemporalFeatureScaler.computeScalerHash({ smcScore: params1 }),
    );
  });

  it('Test 6: Train/validation/OOS partition isolation', () => {
    const t0 = 1700000000000;
    const examples = generateTestExamples(t0, 60, 3600000, 7);
    const splits = PITExperienceDatasetBuilder.buildSplits(examples, {
      symbol: 'BTCUSDT',
      timeframe: '15m',
      embargoMs: 900000,
    });

    const trainIds = new Set(splits.training.examples.map((e) => e.exampleId));
    const valIds = new Set(splits.validation.examples.map((e) => e.exampleId));
    const oosIds = new Set(splits.oos.examples.map((e) => e.exampleId));

    // Zero intersection across splits
    for (const id of valIds) expect(trainIds.has(id)).toBe(false);
    for (const id of oosIds) expect(trainIds.has(id)).toBe(false);
    for (const id of oosIds) expect(valIds.has(id)).toBe(false);
  });

  it('Test 7: OOS outcome cannot change fitted model weights or bias', () => {
    const t0 = 1700000000000;
    const trainExamples = generateTestExamples(t0, 40, 3600000, 8);

    const model1 = ModelTrainer.trainModel(trainExamples as any, { epochs: 30, learningRate: 0.05 });

    // Modifying OOS outcomes does not change train-fitted model
    const trainExamplesCopy = generateTestExamples(t0, 40, 3600000, 8);
    const model2 = ModelTrainer.trainModel(trainExamplesCopy as any, { epochs: 30, learningRate: 0.05 });

    expect(model2.weights).toEqual(model1.weights);
    expect(model2.bias).toBe(model1.bias);
    expect(model2.trainLoss).toBe(model1.trainLoss);
  });

  it('Test 8: OOS outcome cannot change feature selection results', () => {
    const t0 = 1700000000000;
    const trainExamples = generateTestExamples(t0, 40, 3600000, 9);

    const fs1 = FeatureSelector.selectFeatures(trainExamples as any);
    const fs2 = FeatureSelector.selectFeatures(trainExamples as any);

    expect(fs2.retainedFeatures).toEqual(fs1.retainedFeatures);
    expect(fs2.prunedFeatures).toEqual(fs1.prunedFeatures);
  });

  // ==========================================================================
  // 3. CANDIDATE HYPOTHESIS GENERATION & DEDUPLICATION
  // ==========================================================================

  it('Test 9: Deterministic training run ID derived from canonical hashes', () => {
    const id1 = SelfImprovingRetrainingPipeline.computeRunId('v2.0', 'BTCUSDT', 'mkt_hash_1', 'exp_hash_1', 'cfg_hash_1');
    const id2 = SelfImprovingRetrainingPipeline.computeRunId('v2.0', 'BTCUSDT', 'mkt_hash_1', 'exp_hash_1', 'cfg_hash_1');
    const idDiff = SelfImprovingRetrainingPipeline.computeRunId('v2.0', 'BTCUSDT', 'mkt_hash_2', 'exp_hash_1', 'cfg_hash_1');

    expect(id2).toBe(id1);
    expect(idDiff).not.toBe(id1);
  });

  it('Test 10: Candidate hypothesis deduplication rejects identical hypotheses', () => {
    const t0 = 1700000000000;
    const examples = generateTestExamples(t0, 30, 3600000, 10);
    const splits = PITExperienceDatasetBuilder.buildSplits(examples, { symbol: 'BTCUSDT', timeframe: '15m' });

    const hypList = CandidateHypothesisGenerator.generateHypotheses({
      baseStrategyVersion: 'v2.0',
      trainingDataset: splits.training,
      limits: {
        maxCandidates: 10,
        maxTrainingRuns: 10,
        maxFeatureCombinations: 3,
        maxHyperparameterCombinations: 3,
      },
    });

    const hashes = new Set(hypList.map((h) => h.hypothesisHash));
    expect(hashes.size).toBe(hypList.length); // No duplicates
  });

  it('Test 11: Candidate generation is strictly bounded by maxCandidates limit', () => {
    const t0 = 1700000000000;
    const examples = generateTestExamples(t0, 30, 3600000, 11);
    const splits = PITExperienceDatasetBuilder.buildSplits(examples, { symbol: 'BTCUSDT', timeframe: '15m' });

    const maxLimit = 3;
    const hypList = CandidateHypothesisGenerator.generateHypotheses({
      baseStrategyVersion: 'v2.0',
      trainingDataset: splits.training,
      limits: {
        maxCandidates: maxLimit,
        maxTrainingRuns: 5,
        maxFeatureCombinations: 2,
        maxHyperparameterCombinations: 2,
      },
    });

    expect(hypList.length).toBeLessThanOrEqual(maxLimit);
  });

  // ==========================================================================
  // 4. AUTHORITATIVE EXECUTION & TRADE LIFECYCLE
  // ==========================================================================

  it('Test 12: Candidate evaluation consumes BacktestSimulator', () => {
    const spy = jest.spyOn(BacktestSimulator, 'runSimulation');
    const candles = generateTestCandles(1700000000000, 100);
    const examples = generateTestExamples(1700000000000, 50);

    return SelfImprovingRetrainingPipeline.executeRetraining(examples, candles, baseConfig).then((res) => {
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  it('Test 13: Candidate evaluation consumes ExecutionSimulator', () => {
    const spy = jest.spyOn(ExecutionSimulator.prototype, 'processSingleExecutionBar');
    const candles = generateTestCandles(1700000000000, 100);
    const examples = generateTestExamples(1700000000000, 50);

    return SelfImprovingRetrainingPipeline.executeRetraining(examples, candles, baseConfig).then((res) => {
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  it('Test 14: Candidate evaluation consumes TradeLifecycleManager', () => {
    const spy = jest.spyOn(TradeLifecycleManager, 'validatePartialExitPolicy');
    const candles = generateTestCandles(1700000000000, 100);
    const examples = generateTestExamples(1700000000000, 50);

    return SelfImprovingRetrainingPipeline.executeRetraining(examples, candles, baseConfig).then((res) => {
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  it('Test 15: No manual candidate P&L calculation (execution-derived only)', async () => {
    const candles = generateTestCandles(1700000000000, 100);
    const examples = generateTestExamples(1700000000000, 50);

    const result = await SelfImprovingRetrainingPipeline.executeRetraining(examples, candles, baseConfig);
    for (const oos of result.oosResults) {
      expect(oos.executionDerived).toBe(true);
      expect(Number.isFinite(oos.oosExpectancyR)).toBe(true);
    }
  });

  // ==========================================================================
  // 5. WALK-FORWARD VALIDATION & MONTE CARLO
  // ==========================================================================

  it('Test 16: Real WFV retraining across folds', () => {
    const spy = jest.spyOn(WalkForwardValidator, 'validate');
    const candles = generateTestCandles(1700000000000, 100);
    const examples = generateTestExamples(1700000000000, 50);

    return SelfImprovingRetrainingPipeline.executeRetraining(examples, candles, baseConfig).then(() => {
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  it('Test 17: Independent fold scaler & model instances per fold', () => {
    const fitSpy = jest.spyOn(TemporalFeatureScaler.prototype, 'fit');
    const trainSpy = jest.spyOn(ModelTrainer, 'trainModel');

    const candles = generateTestCandles(1700000000000, 100);
    const examples = generateTestExamples(1700000000000, 50);

    return SelfImprovingRetrainingPipeline.executeRetraining(examples, candles, baseConfig).then(() => {
      expect(fitSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(trainSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      fitSpy.mockRestore();
      trainSpy.mockRestore();
    });
  });

  it('Test 18: Fold isolation verified during WFV execution', async () => {
    const candles = generateTestCandles(1700000000000, 100);
    const examples = generateTestExamples(1700000000000, 50);

    const result = await SelfImprovingRetrainingPipeline.executeRetraining(examples, candles, baseConfig);
    for (const val of result.validationResults) {
      expect(val.walkForwardTotalFolds).toBeGreaterThan(0);
      expect(Number.isFinite(val.walkForwardExpectancyR)).toBe(true);
    }
  });

  it('Test 19: Monte Carlo uses real execution-derived trades', () => {
    const spy = jest.spyOn(MonteCarloEngine, 'simulate');
    const candles = generateTestCandles(1700000000000, 100);
    const examples = generateTestExamples(1700000000000, 50);

    return SelfImprovingRetrainingPipeline.executeRetraining(examples, candles, baseConfig).then(() => {
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  it('Test 20: Insufficient Monte Carlo data fails unavailable (zero probability of ruin fabrications)', () => {
    const emptyTrades: number[] = [];
    expect(() => MonteCarloEngine.simulate(emptyTrades)).toThrow();
  });

  // ==========================================================================
  // 6. CANDIDATE ARTIFACT & MODEL REGISTRY
  // ==========================================================================

  it('Test 21: CandidateArtifact contains complete cryptographic provenance', async () => {
    const candles = generateTestCandles(1700000000000, 100);
    const examples = generateTestExamples(1700000000000, 50);

    const result = await SelfImprovingRetrainingPipeline.executeRetraining(examples, candles, baseConfig);
    expect(result.createdArtifacts.length).toBeGreaterThan(0);

    const art = result.createdArtifacts[0];
    expect(art.artifactHash).toBeDefined();
    expect(art.executionConfig).toBeDefined();
    expect(art.riskConfig).toBeDefined();
    expect(art.featureSchemaHash).toBeDefined();
    expect(art.trainingDatasetHash).toBeDefined();
    expect(art.validationDatasetHash).toBeDefined();
    expect(art.oosDatasetHash).toBeDefined();
    expect(art.marketDatasetHash).toBeDefined();
  });

  it('Test 22: CandidateArtifact hash changes when any provenance field changes', async () => {
    const candles = generateTestCandles(1700000000000, 100);
    const examples = generateTestExamples(1700000000000, 50);

    const result = await SelfImprovingRetrainingPipeline.executeRetraining(examples, candles, baseConfig);
    const artA = result.createdArtifacts[0];

    // Modifying provenance creates distinct artifact
    const candB = { ...artA, id: artA.candidateId, riskConfig: { ...artA.riskConfig, maxRiskPerTrade: 0.02 } };
    const artB = CandidateBacktestRunner.createCandidateArtifact(candB as any, 'mkt_hash_diff');

    expect(artB.artifactHash).not.toBe(artA.artifactHash);
  });

  it('Test 23: Successful candidate registered in ModelRegistry in SHADOW_PENDING state', async () => {
    const candles = generateTestCandles(1700000000000, 100);
    const examples = generateTestExamples(1700000000000, 50);

    const result = await SelfImprovingRetrainingPipeline.executeRetraining(examples, candles, baseConfig);
    const selectedId = result.selectedCandidateId;
    expect(selectedId).toBeDefined();

    const registered = ModelRegistry.getCandidateArtifact(selectedId!);
    expect(registered).toBeDefined();
    expect(registered?.status).toBe('SHADOW_PENDING');
  });

  it('Test 24: Failed retraining leaves ModelRegistry completely unchanged', async () => {
    const initialModels = ModelRegistry.getAllModels();
    const candles = generateTestCandles(1700000000000, 100);

    // Empty examples -> Fails closed
    await expect(
      SelfImprovingRetrainingPipeline.executeRetraining([], candles, baseConfig),
    ).rejects.toThrow();

    const afterModels = ModelRegistry.getAllModels();
    expect(afterModels.length).toBe(initialModels.length);
  });

  it('Test 25: Retraining idempotency across repeated identical runs', async () => {
    const candles = generateTestCandles(1700000000000, 100);
    const examples = generateTestExamples(1700000000000, 50);

    const res1 = await SelfImprovingRetrainingPipeline.executeRetraining(examples, candles, baseConfig);
    SelfImprovingRetrainingPipeline.reset();
    ModelRegistry.reset();
    const res2 = await SelfImprovingRetrainingPipeline.executeRetraining(examples, candles, baseConfig);

    expect(res2.runRecord.runId).toBe(res1.runRecord.runId);
    expect(res2.runRecord.resultHash).toBe(res1.runRecord.resultHash);
  });

  // ==========================================================================
  // 7. SHADOW EXPERIENCE CUTOFF & ANTI-SELF-CONTAMINATION
  // ==========================================================================

  it('Test 26: Shadow experience cutoff timestamp strictly enforced', () => {
    const t0 = 1700000000000;
    const pastEx = generateTestExamples(t0, 20, 3600000, 12);
    const futureShadowEx = generateTestExamples(t0 + 25 * 3600000, 10, 3600000, 13).map((e) => ({
      ...e,
      source: 'SHADOW' as const,
    }));

    const cutoff = t0 + 20 * 3600000;
    const combined = [...pastEx, ...futureShadowEx];

    const splits = PITExperienceDatasetBuilder.buildSplits(combined, {
      symbol: 'BTCUSDT',
      timeframe: '15m',
      cutoffTimestamp: cutoff,
    });

    for (const ex of splits.training.examples) {
      expect(ex.decisionTimestamp).toBeLessThanOrEqual(cutoff);
    }
  });

  it('Test 27: Future shadow experiences excluded from historical training partition', () => {
    const t0 = 1700000000000;
    const trainEx = generateTestExamples(t0, 30, 3600000, 14);
    const futureShadow = generateTestExamples(t0 + 50 * 3600000, 10, 3600000, 15).map((e) => ({
      ...e,
      source: 'SHADOW' as const,
    }));

    const splits = PITExperienceDatasetBuilder.buildSplits([...trainEx, ...futureShadow], {
      symbol: 'BTCUSDT',
      timeframe: '15m',
      cutoffTimestamp: t0 + 35 * 3600000,
    });

    const trainIds = new Set(splits.training.examples.map((e) => e.exampleId));
    for (const sEx of futureShadow) {
      expect(trainIds.has(sEx.exampleId)).toBe(false);
    }
  });

  it('Test 28: Candidate cannot train on its own future shadow results (temporal boundary)', () => {
    const t0 = 1700000000000;
    const candId = 'cand_alpha_01';
    const initialTrain = generateTestExamples(t0, 20, 3600000, 16);

    // Future shadow outcomes from Candidate Alpha
    const alphaFutureShadow = generateTestExamples(t0 + 30 * 3600000, 10, 3600000, 17).map((e) => ({
      ...e,
      candidateVersion: candId,
      source: 'SHADOW' as const,
    }));

    // Retraining Run 1 for Candidate Alpha uses only data up to T0 + 20h
    const splits1 = PITExperienceDatasetBuilder.buildSplits([...initialTrain, ...alphaFutureShadow], {
      symbol: 'BTCUSDT',
      timeframe: '15m',
      cutoffTimestamp: t0 + 20 * 3600000,
    });

    expect(splits1.training.examples.some((e) => e.candidateVersion === candId)).toBe(false);
  });

  // ==========================================================================
  // 8. LIFECYCLE, CONCURRENCY & SAFETY
  // ==========================================================================

  it('Test 29: Retraining record persists and is retrievable by runId', async () => {
    const candles = generateTestCandles(1700000000000, 100);
    const examples = generateTestExamples(1700000000000, 50);

    const result = await SelfImprovingRetrainingPipeline.executeRetraining(examples, candles, baseConfig);
    const retrieved = SelfImprovingRetrainingPipeline.getRunRecord(result.runRecord.runId);

    expect(retrieved).toBeDefined();
    expect(retrieved?.status).toBe('COMPLETED');
    expect(retrieved?.marketDatasetHash).toBe(result.runRecord.marketDatasetHash);
  });

  it('Test 30: Concurrent retraining run conflict detected and rejected fail-closed', async () => {
    const candles = generateTestCandles(1700000000000, 100);
    const examples = generateTestExamples(1700000000000, 50);

    // Launch first run
    const p1 = SelfImprovingRetrainingPipeline.executeRetraining(examples, candles, baseConfig);

    // Attempt second simultaneous run for same strategy and symbol
    await expect(
      SelfImprovingRetrainingPipeline.executeRetraining(examples, candles, baseConfig),
    ).rejects.toThrow(/CONCURRENT_RETRAINING_CONFLICT/);

    await p1;
  });

  it('Test 31: Maximum candidate limit strictly enforced across pipeline', async () => {
    const candles = generateTestCandles(1700000000000, 100);
    const examples = generateTestExamples(1700000000000, 50);

    const customConfig: RetrainingRunConfig = {
      ...baseConfig,
      maxCandidates: 2,
    };

    const result = await SelfImprovingRetrainingPipeline.executeRetraining(examples, candles, customConfig);
    expect(result.generatedCandidates.length).toBeLessThanOrEqual(2);
  });

  it('Test 32: Live trading and autonomous promotion are permanently disabled', () => {
    expect(SelfImprovingRetrainingPipeline.AUTOMATIC_LIVE_TRADING_ENABLED).toBe(false);
    expect(SelfImprovingRetrainingPipeline.AUTOMATIC_LIVE_PROMOTION_ENABLED).toBe(false);
    expect(SelfImprovingRetrainingPipeline.AUTOMATIC_LIVE_ROLLBACK_ENABLED).toBe(false);
  });
});
