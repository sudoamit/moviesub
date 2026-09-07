import { DatasetManager, IDatasetSample } from '../dataset-manager';
import { ExperimentRunner, QuantExperimentManager, ExperimentComparator } from '../experiments';

describe('DatasetManager & Quantitative Experiment System', () => {
  const baseTime = 1756972800000;
  const mockSamples: IDatasetSample[] = Array.from({ length: 100 }, (_, i) => ({
    sampleId: `sample_${i}`,
    timestamp: baseTime + i * 15 * 60 * 1000,
    features: {
      htfTrend: i % 2 === 0 ? 1 : 0,
      obMitigated: 1,
      fvgQuality: 0.8,
      volumeRatio: 1.4,
    },
    labelBinary: i % 3 === 0 ? 0 : 1, // 66% win rate
    labelContinuousR: i % 3 === 0 ? -1.0 : 2.0, // +1.0R average expectancy
    regime: i < 50 ? 'BULLISH_TREND' : 'RANGE',
    volatilityBucket: 'NORMAL',
  }));

  it('should create an immutable hashed dataset and partition into chronological Train, Validation, and OOS splits', () => {
    const manager = new DatasetManager();
    const dataset = manager.createDataset('NIFTY', '15m', mockSamples);

    expect(dataset.metadata.datasetId).toBeDefined();
    expect(dataset.metadata.dataHash.length).toBe(16);
    expect(dataset.metadata.sampleCount).toBe(100);

    const splits = manager.splitDataset(dataset.metadata.datasetId, 0.6, 0.2, 0.2);
    expect(splits.train.length).toBe(60);
    expect(splits.validation.length).toBe(20);
    expect(splits.outOfSample.length).toBe(20);

    // Verify strict chronological time-series ordering (no leakage)
    expect(splits.train[splits.train.length - 1].timestamp).toBeLessThan(splits.validation[0].timestamp);
    expect(splits.validation[splits.validation.length - 1].timestamp).toBeLessThan(splits.outOfSample[0].timestamp);
  });

  it('should run a reproducible quantitative experiment with cost stress testing and Monte Carlo simulation', () => {
    const manager = new DatasetManager();
    const dataset = manager.createDataset('NIFTY', '15m', mockSamples);
    const splits = manager.splitDataset(dataset.metadata.datasetId);

    const exp = ExperimentRunner.runExperiment('NIFTY_SMC_Base', splits, { minScore: 70 }, 12345);

    expect(exp.experimentId).toBeDefined();
    expect(exp.oosMetrics.winRate).toBeGreaterThan(50);
    expect(exp.costStressTests.length).toBe(4);
    expect(exp.costStressTests.some((t) => t.multiplier === 2.0)).toBe(true);
    expect(exp.monteCarlo95Drawdown).toBeGreaterThanOrEqual(0);
    expect(exp.isRobust).toBe(true);

    const expManager = new QuantExperimentManager();
    expManager.registerExperiment(exp);
    expect(expManager.getExperiment(exp.experimentId)).toBeDefined();
    expect(expManager.getBestExperimentByOOSExpectancy()).toBeDefined();
  });

  it('should compare candidate and baseline experiments statistically', () => {
    const manager = new DatasetManager();
    const dataset = manager.createDataset('NIFTY', '15m', mockSamples);
    const splits = manager.splitDataset(dataset.metadata.datasetId);

    const baseline = ExperimentRunner.runExperiment('Baseline', splits, { minScore: 60 });
    const candidate = ExperimentRunner.runExperiment('Candidate_Optimized', splits, { minScore: 75 });

    const comparison = ExperimentComparator.compare(baseline, candidate);
    expect(comparison.deltaOOSExpectancyR).toBeDefined();
    expect(comparison.verdict).toBeDefined();
  });
});
