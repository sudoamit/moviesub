import {
  ModelRegistryService,
  ChampionRecord
} from '../champion-challenger/index';

describe('Phase 10 — Model Registry Service & Lifecycle Invariants', () => {
  let registryService: ModelRegistryService;

  beforeEach(() => {
    registryService = new ModelRegistryService();
  });

  describe('Invariant: ONE_ACTIVE_CHAMPION_PER_SLOT', () => {
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

      const champ1 = registryService.assignChampion(slotId, model1.modelId);
      expect(champ1.slotId).toBe(slotId);
      expect(champ1.modelId).toBe(model1.modelId);
      expect(registryService.getModel(model1.modelId)?.status).toBe('CHAMPION');
      expect(registryService.getActiveChampion(slotId)?.modelId).toBe(model1.modelId);

      const champ2 = registryService.assignChampion(slotId, model2.modelId);
      expect(champ2.slotId).toBe(slotId);
      expect(champ2.modelId).toBe(model2.modelId);
      expect(registryService.getActiveChampion(slotId)?.modelId).toBe(model2.modelId);

      expect(registryService.getModel(model1.modelId)?.status).toBe('RETIRED');
      expect(registryService.getModel(model2.modelId)?.status).toBe('CHAMPION');

      const activeChampions = registryService.listActiveChampions();
      expect(activeChampions.filter((c: ChampionRecord) => c.slotId === slotId).length).toBe(1);
      expect(activeChampions[0].modelId).toBe(model2.modelId);
    });
  });

  describe('Invariant: MODEL_ARTIFACT_IDENTITY_IS_UNIQUE', () => {
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
      expect(model.artifactHash.length).toBe(64);

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

    it('fails closed when required metadata fields are missing (no silent defaults)', () => {
      expect(() => {
        registryService.registerModel({
          modelId: 'missing-meta-model',
          modelVersion: '1.0.0',
          modelType: 'xgboost',
          artifactLocation: '/models/m.bin',
          artifactData: 'weights',
          trainingRunId: '',
          datasetVersion: 'ds-1',
          featureVersion: 'feat-1',
          labelVersion: 'lbl-1'
        });
      }).toThrow(/INVALID_MODEL_RECORD: trainingRunId is required/);

      expect(() => {
        registryService.registerModel({
          modelId: 'missing-meta-model-2',
          modelVersion: '1.0.0',
          modelType: 'xgboost',
          artifactLocation: '/models/m.bin',
          artifactData: 'weights',
          trainingRunId: 'run-1',
          datasetVersion: '',
          featureVersion: 'feat-1',
          labelVersion: 'lbl-1'
        });
      }).toThrow(/INVALID_MODEL_RECORD: datasetVersion is required/);
    });
  });

  describe('Invariant: CHALLENGER_LIFECYCLE_CONSISTENCY', () => {
    it('retires ChallengerRecord when the challenger is assigned as Champion', () => {
      const slotId = 'slot-btcusdt';
      const chall = registryService.registerModel({
        modelId: 'chall-btc-1',
        modelVersion: '1.0.0',
        modelType: 'lightgbm',
        artifactLocation: '/models/btc.bin',
        artifactData: 'btc-weights',
        trainingRunId: 'run-btc-1',
        datasetVersion: 'ds-1',
        featureVersion: 'feat-1',
        labelVersion: 'lbl-1'
      });

      const challengerRecord = registryService.registerChallenger(slotId, chall.modelId, 'run-btc-1');
      expect(challengerRecord.status).toBe('ACTIVE_CHALLENGER');

      // Now assign this model as Champion
      registryService.assignChampion(slotId, chall.modelId, {
        reason: 'PROMOTED_VIA_EVALUATION',
        promotionDecisionId: 'decision-101',
        evaluationId: 'eval-101'
      });

      expect(registryService.getModel(chall.modelId)?.status).toBe('CHAMPION');
      const updatedChallengers = registryService.getChallengers(slotId);
      const matchingChallenger = updatedChallengers.find(c => c.modelId === chall.modelId);
      expect(matchingChallenger?.status).toBe('RETIRED');
      expect(matchingChallenger?.statusReason).toBe('PROMOTED_VIA_EVALUATION');
    });
  });
});
