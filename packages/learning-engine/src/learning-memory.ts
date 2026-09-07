import { LearningMemoryItem } from './types';

export class LearningMemory {
  private static memories: Map<string, LearningMemoryItem> = new Map();

  /**
   * Stores or updates a learning memory item.
   */
  public static setMemory(
    item: Omit<LearningMemoryItem, 'id' | 'createdAt' | 'updatedAt'>,
  ): LearningMemoryItem {
    const existing = this.memories.get(item.key);
    const now = new Date();

    const fullItem: LearningMemoryItem = {
      id: existing ? existing.id : `mem-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      key: item.key,
      memoryType: item.memoryType,
      summary: item.summary,
      details: item.details,
      sampleSize: item.sampleSize,
      confidence: item.confidence,
      status: item.status,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    this.memories.set(item.key, Object.freeze(fullItem));
    return fullItem;
  }

  /**
   * Retrieves a memory item by unique key.
   */
  public static getMemory(key: string): LearningMemoryItem | undefined {
    return this.memories.get(key);
  }

  /**
   * Retrieves all memory items by type.
   */
  public static getMemoriesByType(type?: LearningMemoryItem['memoryType']): LearningMemoryItem[] {
    const all = Array.from(this.memories.values());
    if (!type) return all;
    return all.filter((m) => m.memoryType === type && m.status === 'ACTIVE');
  }

  /**
   * Clears in-memory memory store.
   */
  public static clear(): void {
    this.memories.clear();
  }
}
