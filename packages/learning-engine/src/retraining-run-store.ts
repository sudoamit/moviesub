import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { RetrainingRunRecord } from './types';
import { canonicalJsonStringify } from './canonical-serializer';

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as any)[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

export class RetrainingRunStore {
  private static persistencePath: string | null = null;
  private static runs: Map<string, RetrainingRunRecord> = new Map();

  /**
   * Sets or clears the durable persistence file path.
   * If a path is provided and exists, runs are hydrated from disk.
   */
  public static setPersistencePath(filePath: string | null): void {
    this.persistencePath = filePath;
    if (filePath && fs.existsSync(filePath)) {
      this.loadFromFile(filePath);
    }
  }

  /**
   * Returns current persistence file path.
   */
  public static getPersistencePath(): string | null {
    return this.persistencePath;
  }

  /**
   * Captures an immutable snapshot of in-memory runs for atomic multi-store transactions.
   */
  public static createSnapshot(): Map<string, RetrainingRunRecord> {
    return new Map(this.runs);
  }

  /**
   * Restores an in-memory snapshot, rolling back mutations.
   */
  public static restoreSnapshot(snapshot: Map<string, RetrainingRunRecord>): void {
    this.runs = new Map(snapshot);
    if (this.persistencePath) {
      this.saveToFile(this.persistencePath);
    }
  }

  /**
   * Resets in-memory run cache and clears persistence path.
   */
  public static reset(): void {
    this.runs.clear();
    this.persistencePath = null;
  }

  /**
   * Stores a RetrainingRunRecord in memory and automatically persists to disk if configured.
   */
  public static saveRun(record: RetrainingRunRecord): void {
    if (!record || !record.runId || typeof record.runId !== 'string') {
      throw new Error('INVALID_RETRAINING_RUN_RECORD: Record must have a valid runId string');
    }

    const frozen = deepFreeze(JSON.parse(JSON.stringify(record)));
    this.runs.set(record.runId, frozen);

    if (this.persistencePath) {
      this.saveToFile(this.persistencePath);
    }
  }

  /**
   * Retrieves a RetrainingRunRecord by runId.
   */
  public static getRun(runId: string): RetrainingRunRecord | undefined {
    return this.runs.get(runId);
  }

  /**
   * Lists all stored RetrainingRunRecords ordered by startedAt timestamp.
   */
  public static listRuns(): RetrainingRunRecord[] {
    return Array.from(this.runs.values()).sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Durably saves all run records atomically to disk.
   */
  public static saveToFile(filePath?: string): void {
    const targetPath = filePath || this.persistencePath;
    if (!targetPath) return;

    const data = {
      version: '2.0',
      runs: Array.from(this.runs.entries()),
      savedAt: Date.now(),
    };

    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = `${targetPath}.tmp.${Date.now()}.${randomUUID()}`;
    fs.writeFileSync(tempPath, canonicalJsonStringify(data), 'utf-8');
    fs.renameSync(tempPath, targetPath);
  }

  /**
   * Hydrates run records from disk with strict fail-closed validation.
   */
  public static loadFromFile(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      throw new Error(`RETRAINING_RUN_STORE_NOT_FOUND: Run store file does not exist at ${filePath}`);
    }

    try {
      const rawContent = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(rawContent);

      if (!data || typeof data !== 'object' || !Array.isArray(data.runs)) {
        throw new Error('CORRUPT_RUN_STORE_DATA: File must contain a runs array');
      }

      const tempRuns = new Map<string, RetrainingRunRecord>();
      for (const [runId, record] of data.runs) {
        if (!runId || !record || typeof record !== 'object' || record.runId !== runId) {
          throw new Error(`CORRUPT_RUN_ENTRY: Corrupt or mismatched run record for runId ${runId}`);
        }
        if (!record.status || !record.startedAt || !record.configHash || !record.executionContextHash || !record.executionContextVersion) {
          throw new Error(`INVALID_RUN_RECORD: Missing mandatory fields for runId ${runId}`);
        }
        tempRuns.set(runId, deepFreeze(JSON.parse(JSON.stringify(record))));
      }

      this.runs = tempRuns;
    } catch (err: any) {
      throw new Error(`RETRAINING_RUN_STORE_CORRUPT: Failed to load retraining run history from ${filePath}: ${err.message}`);
    }
  }
}
