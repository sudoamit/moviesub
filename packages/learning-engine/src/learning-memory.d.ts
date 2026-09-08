import { LearningMemoryItem } from './types';
export declare class LearningMemory {
    private static memories;
    /**
     * Stores or updates a learning memory item.
     */
    static setMemory(item: Omit<LearningMemoryItem, 'id' | 'createdAt' | 'updatedAt'>): LearningMemoryItem;
    /**
     * Retrieves a memory item by unique key.
     */
    static getMemory(key: string): LearningMemoryItem | undefined;
    /**
     * Retrieves all memory items by type.
     */
    static getMemoriesByType(type?: LearningMemoryItem['memoryType']): LearningMemoryItem[];
    /**
     * Clears in-memory memory store.
     */
    static clear(): void;
}
