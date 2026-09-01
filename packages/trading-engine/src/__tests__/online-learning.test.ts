import {
  TradePredictionModel,
  OnlineLearningEngine,
  TradeFeatureVector,
  FEATURE_SCHEMA_VERSION,
} from '../ai-trade-learning-engine';

describe('PHASE 11: Online Learning Engine with Strict Safety Bounds', () => {
  const sampleFeatures: TradeFeatureVector = {
    smcScore: 0.90,
    obStrength: 0.85,
    fvgSize: 0.70,
    mtfAlignment: 0.95,
    killZoneSession: 1.0,
    smtDivergence: 0.80,
    volatilityAtr: 0.35,
    riskRewardRatio: 0.75,
    trendRegime: 1.0,
    liquiditySweep: 1.0,
    bosStrength: 0.85,
    chochStrength: 0.80,
    relativeVolume: 0.85,
    distanceToHTFLevel: 0.20,
    distanceToLiquidity: 0.15,
    marketSession: 0.50,
    dayOfWeek: 0.40,
  };

  describe('1. Single-Step Online SGD Update with Weight Delta Norm Guard', () => {
    it('applies an online gradient update and clips weight delta to max norm boundary (0.05)', () => {
      const model = new TradePredictionModel('v1.0.0-PROD');
      const engine = new OnlineLearningEngine({
        learningRate: 0.01,
        maxWeightChangeNorm: 0.05,
      });

      // Trade won (label = 1)
      const result = engine.updateModel(model, {
        tradeId: 't_001',
        symbol: 'NIFTY',
        features: sampleFeatures,
        featureSchemaVersion: FEATURE_SCHEMA_VERSION,
        actualLabel: 1,
      });

      expect(result.status === 'UPDATED' || result.status === 'CLIPPED').toBe(true);
      expect(result.weightDeltaNorm).toBeLessThanOrEqual(0.0501);
      expect(result.learningRateApplied).toBeLessThanOrEqual(0.01);
      expect(result.isRollbackTriggered).toBe(false);
      expect(result.updatedWeights.length).toBe(17);
    });

    it('rejects updates if the incoming feature schema version does not match production', () => {
      const model = new TradePredictionModel('v1.0.0-PROD');
      const engine = new OnlineLearningEngine();

      const result = engine.updateModel(model, {
        tradeId: 't_002',
        symbol: 'BTCUSDT',
        features: sampleFeatures,
        featureSchemaVersion: '0.8', // Incompatible schema!
        actualLabel: 1,
      });

      expect(result.status).toBe('REJECTED_SCHEMA_MISMATCH');
      expect(result.weightDeltaNorm).toBe(0.0);
    });
  });

  describe('2. Adaptive Learning Rate Decay & Checkpointing', () => {
    it('decays learning rate gradually with trade count', () => {
      const model = new TradePredictionModel('v1.0.0-PROD');
      const engine = new OnlineLearningEngine({
        learningRate: 0.01,
        decayRate: 0.99,
      });

      const res1 = engine.updateModel(model, {
        symbol: 'NIFTY',
        features: sampleFeatures,
        actualLabel: 1,
      });

      const res2 = engine.updateModel(model, {
        symbol: 'BANKNIFTY',
        features: sampleFeatures,
        actualLabel: 1,
      });

      expect(res2.learningRateApplied).toBeLessThan(res1.learningRateApplied);
      expect(engine.getUpdateCount()).toBe(2);
      expect(engine.getCheckpoints().length).toBeGreaterThan(0);
    });
  });
});
