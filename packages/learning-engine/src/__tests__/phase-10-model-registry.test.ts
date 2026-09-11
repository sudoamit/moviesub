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

  describe('Invariant: CHAMPION_AND_CHALLENGER_LIFECYCLE_COHERENCE', () => {
    it('ensures no model is simultaneously Champion and Active Challenger, and exactly 1 Champion exists', () => {
      const slotId = 'slot-ethusdt';

      // 1. Register Model A and assign as active Champion
      const modelA = registryService.registerModel({
        modelId: 'model-a',
        modelVersion: '1.0.0',
        modelType: 'catboost',
        artifactLocation: '/models/a.bin',
        artifactData: 'weights-a',
        trainingRunId: 'run-a',
        datasetVersion: 'ds-1',
        featureVersion: 'feat-1',
        labelVersion: 'lbl-1'
      });
      registryService.assignChampion(slotId, modelA.modelId, { reason: 'INITIAL_CHAMPION' });

      // 2. Register Model B and register as active Challenger
      const modelB = registryService.registerModel({
        modelId: 'model-b',
        modelVersion: '2.0.0',
        modelType: 'catboost',
        artifactLocation: '/models/b.bin',
        artifactData: 'weights-b',
        trainingRunId: 'run-b',
        datasetVersion: 'ds-1',
        featureVersion: 'feat-1',
        labelVersion: 'lbl-1'
      });
      registryService.registerChallenger(slotId, modelB.modelId, 'run-b');

      // Check pre-promotion state
      expect(registryService.getActiveChampion(slotId)?.modelId).toBe(modelA.modelId);
      expect(registryService.getModel(modelA.modelId)?.status).toBe('CHAMPION');
      expect(registryService.getModel(modelB.modelId)?.status).toBe('CHALLENGER');
      expect(registryService.getChallengers(slotId).find(c => c.modelId === modelB.modelId)?.status).toBe('ACTIVE_CHALLENGER');

      // 3. Assign Model B as Champion (promotion/assignment)
      registryService.assignChampion(slotId, modelB.modelId, {
        reason: 'PROMOTED_FROM_CHALLENGER',
        promotionDecisionId: 'decision-eth-01'
      });

      // Assert post-promotion invariants:
      // Invariant A: Model B is now the active Champion
      expect(registryService.getActiveChampion(slotId)?.modelId).toBe(modelB.modelId);
      expect(registryService.getModel(modelB.modelId)?.status).toBe('CHAMPION');

      // Invariant B: Model B is no longer an ACTIVE_CHALLENGER (status is RETIRED)
      const challengerB = registryService.getChallengers(slotId).find(c => c.modelId === modelB.modelId);
      expect(challengerB?.status).toBe('RETIRED');
      expect(challengerB?.statusReason).toBe('PROMOTED_FROM_CHALLENGER');

      // Invariant C: Model A is no longer an active Champion (status is RETIRED)
      expect(registryService.getModel(modelA.modelId)?.status).toBe('RETIRED');

      // Invariant D: Exactly one Champion exists for the slot
      const championsForSlot = registryService.listActiveChampions().filter(c => c.slotId === slotId);
      expect(championsForSlot.length).toBe(1);
      expect(championsForSlot[0].modelId).toBe(modelB.modelId);

      // Invariant E: No model is simultaneously CHAMPION and ACTIVE_CHALLENGER
      for (const champ of registryService.listActiveChampions()) {
        const activeChallenger = registryService.getChallengers(champ.slotId).find(
          c => c.modelId === champ.modelId && c.status === 'ACTIVE_CHALLENGER'
        );
        expect(activeChallenger).toBeUndefined();
      }
    });
  });
});
