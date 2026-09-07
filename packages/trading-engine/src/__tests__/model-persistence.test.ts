import {
  TradePredictionModel,
  ModelPersistenceManager,
  ModelRegistry,
  FEATURE_SCHEMA_VERSION,
  TradeFeatureVector,
  EvaluationMetrics,
} from '../ai-trade-learning-engine';

describe('PHASE 7: Model Persistence & Version Lineage Registry', () => {
  const dummyMetrics: EvaluationMetrics = {
    sampleSize: 100,
    totalExamples: 100,
    epochsTrained: 50,
    initialLoss: 0.693,
    finalLoss: 0.42,
    accuracy: 0.78,
    precision: 0.75,
    recall: 0.82,
    f1Score: 0.78,
    logLoss: 0.42,
    brierScore: 0.14,
    rocAuc: 0.81,
    profitFactor: 2.4,
    expectancyR: 0.85,
    maxDrawdownR: 3.2,
  };

  const sampleFeatures: TradeFeatureVector = {
    smcScore: 0.85,
    obStrength: 0.8,
    fvgSize: 0.6,
    mtfAlignment: 0.9,
    killZoneSession: 1.0,
    smtDivergence: 0.75,
    volatilityAtr: 0.4,
    riskRewardRatio: 0.65,
    trendRegime: 1.0,
    liquiditySweep: 1.0,
    bosStrength: 0.8,
    chochStrength: 0.75,
    relativeVolume: 0.8,
    distanceToHTFLevel: 0.25,
    distanceToLiquidity: 0.2,
    marketSession: 0.45,
    dayOfWeek: 0.33,
  };

  describe('1. ModelPersistenceManager Serialization & Hydration', () => {
    it('serializes and deserializes a model with identical prediction outputs', () => {
      const originalModel = new TradePredictionModel('v1.0.0', { learningRate: 0.08 });
      const originalProb = originalModel.predictProbability(sampleFeatures);

      const serialized = ModelPersistenceManager.serialize(originalModel, {
        status: 'ACTIVE',
        metrics: dummyMetrics,
        trainingExampleCount: 60,
        validationExampleCount: 20,
        outOfSampleExampleCount: 20,
      });

      expect(serialized.version).toBe('v1.0.0');
      expect(serialized.featureSchemaVersion).toBe(FEATURE_SCHEMA_VERSION);
      expect(serialized.weights.length).toBe(17);
      expect(serialized.status).toBe('ACTIVE');

      const restoredModel = ModelPersistenceManager.deserialize(serialized);
      expect(restoredModel.modelVersion).toBe('v1.0.0');

      const restoredProb = restoredModel.predictProbability(sampleFeatures);
      expect(restoredProb).toBe(originalProb);
    });

    it('rejects deserialization of incompatible feature schema versions', () => {
      const invalidState: any = {
        version: 'v0.9.0',
        featureSchemaVersion: '0.9', // Incompatible!
        weights: new Array(17).fill(0.1),
        bias: 0.0,
      };

      expect(() => ModelPersistenceManager.deserialize(invalidState)).toThrow(
        /feature schema mismatch/,
      );
    });

    it('rejects deserialization of invalid weights dimensions', () => {
      const invalidWeights: any = {
        version: 'v1.0.0',
        featureSchemaVersion: FEATURE_SCHEMA_VERSION,
        weights: [0.1, 0.2], // Invalid dimension!
        bias: 0.0,
      };

      expect(() => ModelPersistenceManager.deserialize(invalidWeights)).toThrow(
        /weights dimension mismatch/,
      );
    });
  });

  describe('2. ModelRegistry Version Lifecycle & Promotion', () => {
    let registry: ModelRegistry;

    beforeEach(() => {
      registry = new ModelRegistry();
    });

    it('registers multiple distinct model versions without overwriting historical records', () => {
      const modelV1 = new TradePredictionModel('v1.0.0');
      const modelV2 = new TradePredictionModel('v1.1.0');

      const stateV1 = ModelPersistenceManager.serialize(modelV1, {
        status: 'ACTIVE',
        metrics: dummyMetrics,
        trainingExampleCount: 50,
        validationExampleCount: 15,
        outOfSampleExampleCount: 15,
      });

      const stateV2 = ModelPersistenceManager.serialize(modelV2, {
        status: 'CANDIDATE',
        metrics: { ...dummyMetrics, accuracy: 0.84, logLoss: 0.36 },
        trainingExampleCount: 100,
        validationExampleCount: 30,
        outOfSampleExampleCount: 30,
      });

      registry.registerVersion(stateV1);
      registry.registerVersion(stateV2);

      const allVersions = registry.getAllVersions();
      expect(allVersions.length).toBe(2);
      expect(registry.getActiveVersionState()?.version).toBe('v1.0.0');

      // Attempting duplicate registration should throw
      expect(() => registry.registerVersion(stateV1)).toThrow(/already exists/);
    });

    it('promotes candidate version to ACTIVE and archives previous production model', () => {
      const modelV1 = new TradePredictionModel('v1.0.0');
      const modelV2 = new TradePredictionModel('v1.1.0');

      registry.registerVersion(
        ModelPersistenceManager.serialize(modelV1, {
          status: 'ACTIVE',
          metrics: dummyMetrics,
          trainingExampleCount: 50,
          validationExampleCount: 15,
          outOfSampleExampleCount: 15,
        }),
      );

      registry.registerVersion(
        ModelPersistenceManager.serialize(modelV2, {
          status: 'CANDIDATE',
          metrics: dummyMetrics,
          trainingExampleCount: 80,
          validationExampleCount: 20,
          outOfSampleExampleCount: 20,
        }),
      );

      expect(registry.getActiveVersionState()?.version).toBe('v1.0.0');

      // Promote v1.1.0
      registry.promoteVersion('v1.1.0');

      expect(registry.getActiveVersionState()?.version).toBe('v1.1.0');
      expect(registry.getVersion('v1.0.0')?.status).toBe('ARCHIVED');
      expect(registry.getVersion('v1.1.0')?.status).toBe('ACTIVE');

      const activeModel = registry.getActiveModel();
      expect(activeModel?.modelVersion).toBe('v1.1.0');
    });
  });
});
