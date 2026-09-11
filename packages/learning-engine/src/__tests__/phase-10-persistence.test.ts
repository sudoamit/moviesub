import * as fs from 'fs';
import * as path from 'path';
import {
  FileModelRegistryStore,
  ModelRegistryService
} from '../champion-challenger/index';

describe('Phase 10 — Model Registry Persistence (FileModelRegistryStore)', () => {
  const testDir = path.join(__dirname, 'temp_phase10_registry_test');
  const testFile = path.join(testDir, 'model-registry.json');

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('persists models, champions, and challengers durably across service restarts', () => {
    const store1 = new FileModelRegistryStore(testFile);
    const service1 = new ModelRegistryService(store1);

    const slotId = 'slot-eurusd-persisted';

    const model1 = service1.registerModel({
      modelId: 'm-persist-1',
      modelVersion: '1.0.0',
      modelType: 'catboost',
      artifactLocation: '/models/m1.bin',
      artifactData: 'model-binary-data-1',
      trainingRunId: 'run-p1',
      datasetVersion: 'ds-p1',
      featureVersion: 'feat-p1',
      labelVersion: 'lbl-p1'
    });

    service1.assignChampion(slotId, model1.modelId, { reason: 'INITIAL_BASELINE' });

    const model2 = service1.registerModel({
      modelId: 'm-persist-2',
      modelVersion: '2.0.0',
      modelType: 'catboost',
      artifactLocation: '/models/m2.bin',
      artifactData: 'model-binary-data-2',
      trainingRunId: 'run-p2',
      datasetVersion: 'ds-p1',
      featureVersion: 'feat-p1',
      labelVersion: 'lbl-p1'
    });

    service1.registerChallenger(slotId, model2.modelId, 'run-p2');

    expect(fs.existsSync(testFile)).toBe(true);

    // Re-instantiate service with fresh FileModelRegistryStore pointing to same file (simulating process restart)
    const store2 = new FileModelRegistryStore(testFile);
    const service2 = new ModelRegistryService(store2);

    expect(service2.getModel(model1.modelId)?.modelId).toBe('m-persist-1');
    expect(service2.getModel(model2.modelId)?.modelId).toBe('m-persist-2');
    expect(service2.getActiveChampion(slotId)?.modelId).toBe('m-persist-1');
    expect(service2.getChallengers(slotId).length).toBe(1);
    expect(service2.getChallengers(slotId)[0].modelId).toBe('m-persist-2');
  });

  it('fails closed when persisted file is corrupt or invalid schema', () => {
    fs.writeFileSync(testFile, 'NOT_A_VALID_JSON{', 'utf-8');

    expect(() => {
      new FileModelRegistryStore(testFile);
    }).toThrow(/MODEL_REGISTRY_STORE_CORRUPT/);
  });
});
