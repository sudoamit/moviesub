import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  IModelRegistryStore,
  ModelRecord,
  ChampionRecord,
  ChallengerRecord
} from './types';
import { deepFreeze } from './evaluation-identity';

/**
 * In-Memory Model Registry Store
 * Ideal for unit testing, isolated executions, and volatile workflows.
 */
export class InMemoryModelRegistryStore implements IModelRegistryStore {
  private readonly models = new Map<string, ModelRecord>();
  private readonly champions = new Map<string, ChampionRecord>(); // slotId -> ChampionRecord
  private readonly challengers = new Map<string, Map<string, ChallengerRecord>>(); // slotId -> modelId -> ChallengerRecord

  public saveModel(model: ModelRecord): void {
    if (!model || !model.modelId) {
      throw new Error('INVALID_STORE_OPERATION: Cannot save invalid ModelRecord');
    }
    this.models.set(model.modelId, deepFreeze<ModelRecord>(JSON.parse(JSON.stringify(model))));
  }

  public getModel(modelId: string): ModelRecord | undefined {
    return this.models.get(modelId);
  }

  public saveChampion(champion: ChampionRecord): void {
    if (!champion || !champion.slotId) {
      throw new Error('INVALID_STORE_OPERATION: Cannot save invalid ChampionRecord');
    }
    this.champions.set(champion.slotId, deepFreeze<ChampionRecord>(JSON.parse(JSON.stringify(champion))));
  }

  public getChampion(slotId: string): ChampionRecord | undefined {
    return this.champions.get(slotId);
  }

  public saveChallenger(challenger: ChallengerRecord): void {
    if (!challenger || !challenger.slotId || !challenger.modelId) {
      throw new Error('INVALID_STORE_OPERATION: Cannot save invalid ChallengerRecord');
    }
    let slotMap = this.challengers.get(challenger.slotId);
    if (!slotMap) {
      slotMap = new Map();
      this.challengers.set(challenger.slotId, slotMap);
    }
    slotMap.set(challenger.modelId, deepFreeze<ChallengerRecord>(JSON.parse(JSON.stringify(challenger))));
  }

  public getChallengers(slotId: string): ChallengerRecord[] {
    const slotMap = this.challengers.get(slotId);
    return slotMap ? Array.from(slotMap.values()) : [];
  }

  public getAllModels(): ModelRecord[] {
    return Array.from(this.models.values());
  }

  public getAllChampions(): ChampionRecord[] {
    return Array.from(this.champions.values());
  }

  public getAllChallengers(): ChallengerRecord[] {
    const all: ChallengerRecord[] = [];
    for (const slotMap of this.challengers.values()) {
      all.push(...slotMap.values());
    }
    return all;
  }

  public clear(): void {
    this.models.clear();
    this.champions.clear();
    this.challengers.clear();
  }
}

interface PersistedRegistryData {
  readonly version: string;
  readonly models: Array<[string, ModelRecord]>;
  readonly champions: Array<[string, ChampionRecord]>;
  readonly challengers: Array<[string, Array<[string, ChallengerRecord]>]>;
  readonly savedAt: number;
}

/**
 * File-based Model Registry Store
 * Provides durable, crash-resilient persistence across process restarts using atomic writes.
 */
export class FileModelRegistryStore implements IModelRegistryStore {
  private readonly memoryStore = new InMemoryModelRegistryStore();
  private readonly filePath: string;
  public static readonly SCHEMA_VERSION = '1.0';

  constructor(filePath: string) {
    if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
      throw new Error('INVALID_PERSISTENCE_PATH: filePath is required');
    }
    this.filePath = filePath;
    if (fs.existsSync(filePath)) {
      this.loadFromFile();
    }
  }

  public getPersistencePath(): string {
    return this.filePath;
  }

  private saveToFile(): void {
    const data: PersistedRegistryData = {
      version: FileModelRegistryStore.SCHEMA_VERSION,
      models: this.memoryStore.getAllModels().map((m) => [m.modelId, m]),
      champions: this.memoryStore.getAllChampions().map((c) => [c.slotId, c]),
      challengers: this.memoryStore.getAllChampions().map((c) => [
        c.slotId,
        this.memoryStore.getChallengers(c.slotId).map((ch) => [ch.modelId, ch]),
      ]),
      savedAt: Date.now(),
    };

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = `${this.filePath}.tmp.${Date.now()}.${randomUUID()}`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempPath, this.filePath);
  }

  public loadFromFile(): void {
    if (!fs.existsSync(this.filePath)) {
      throw new Error(`REGISTRY_FILE_NOT_FOUND: Registry file not found at ${this.filePath}`);
    }

    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(content) as PersistedRegistryData;

      if (!data || typeof data !== 'object') {
        throw new Error('Registry file does not contain a valid JSON object');
      }

      if (data.version !== FileModelRegistryStore.SCHEMA_VERSION) {
        throw new Error(`UNSUPPORTED_REGISTRY_VERSION: Expected version ${FileModelRegistryStore.SCHEMA_VERSION}`);
      }

      this.memoryStore.clear();

      if (Array.isArray(data.models)) {
        for (const [_, model] of data.models) {
          this.memoryStore.saveModel(model);
        }
      }

      if (Array.isArray(data.champions)) {
        for (const [_, champ] of data.champions) {
          this.memoryStore.saveChampion(champ);
        }
      }

      if (Array.isArray(data.challengers)) {
        for (const [_, slotChallengers] of data.challengers) {
          if (Array.isArray(slotChallengers)) {
            for (const [__, chall] of slotChallengers) {
              this.memoryStore.saveChallenger(chall);
            }
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`MODEL_REGISTRY_STORE_CORRUPT: Failed to load from ${this.filePath}: ${message}`);
    }
  }

  public saveModel(model: ModelRecord): void {
    this.memoryStore.saveModel(model);
    this.saveToFile();
  }

  public getModel(modelId: string): ModelRecord | undefined {
    return this.memoryStore.getModel(modelId);
  }

  public saveChampion(champion: ChampionRecord): void {
    this.memoryStore.saveChampion(champion);
    this.saveToFile();
  }

  public getChampion(slotId: string): ChampionRecord | undefined {
    return this.memoryStore.getChampion(slotId);
  }

  public saveChallenger(challenger: ChallengerRecord): void {
    this.memoryStore.saveChallenger(challenger);
    this.saveToFile();
  }

  public getChallengers(slotId: string): ChallengerRecord[] {
    return this.memoryStore.getChallengers(slotId);
  }

  public getAllModels(): ModelRecord[] {
    return this.memoryStore.getAllModels();
  }

  public getAllChampions(): ChampionRecord[] {
    return this.memoryStore.getAllChampions();
  }

  public getAllChallengers(): ChallengerRecord[] {
    return this.memoryStore.getAllChallengers();
  }

  public clear(): void {
    this.memoryStore.clear();
    this.saveToFile();
  }
}
