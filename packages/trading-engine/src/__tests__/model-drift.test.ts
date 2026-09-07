import { ModelDriftDetector, TradeFeatureVector } from '../ai-trade-learning-engine';

describe('ModelDriftDetector', () => {
  const mockFeatures: TradeFeatureVector = {
    smcScore: 0.9,
    obStrength: 0.85,
    fvgSize: 0.7,
    mtfAlignment: 1.0,
    killZoneSession: 1.0,
    smtDivergence: 0.8,
    volatilityAtr: 0.5,
    riskRewardRatio: 0.7,
    trendRegime: 1.0,
    liquiditySweep: 0.8,
    bosStrength: 0.85,
    chochStrength: 0.8,
    relativeVolume: 0.75,
    distanceToHTFLevel: 0.9,
    distanceToLiquidity: 0.85,
    marketSession: 1.0,
    dayOfWeek: 0.4,
  };

  it('should report healthy state on well-calibrated historical samples', () => {
    const detector = new ModelDriftDetector();

    // 10 samples with p=0.70 (7 wins, 3 losses -> empirical accuracy 70% matches 70% confidence)
    for (let i = 0; i < 10; i++) {
      detector.recordSample({
        predictionProbability: 0.7,
        actualOutcome: i < 7 ? 1 : 0,
        realizedR: i < 7 ? 2.5 : -1.0,
        expectedR: 0.85,
        features: mockFeatures,
        timestamp: new Date(),
      });
    }

    // 10 samples with p=0.40 (4 wins, 6 losses -> empirical accuracy 40% matches 40% confidence)
    for (let i = 0; i < 10; i++) {
      detector.recordSample({
        predictionProbability: 0.4,
        actualOutcome: i < 4 ? 1 : 0,
        realizedR: i < 4 ? 2.0 : -1.0,
        expectedR: 0.2,
        features: mockFeatures,
        timestamp: new Date(),
      });
    }

    const report = detector.evaluateDrift('NIFTY', '1.0.0', { brierScore: 0.2, ece: 0.06 });
    expect(report.recommendedAction).toBe('CONTINUE_LIVE');
    expect(report.brierScore).toBeLessThan(0.25);
    expect(report.featureDriftDetected).toBe(false);
  });

  it('should flag calibration drift when prediction errors exceed thresholds', () => {
    const detector = new ModelDriftDetector();

    // High confidence predictions that consistently fail (overconfident model)
    for (let i = 0; i < 25; i++) {
      detector.recordSample({
        predictionProbability: 0.9,
        actualOutcome: 0, // All losses despite 90% confidence
        realizedR: -1.0,
        expectedR: 1.5,
        features: mockFeatures,
        timestamp: new Date(),
      });
    }

    const report = detector.evaluateDrift('BTCUSDT', '1.0.0', { brierScore: 0.2, ece: 0.06 });
    expect(report.calibrationDriftDetected).toBe(true);
    expect(report.recommendedAction).toBe('DISABLE_MODEL');
  });
});
