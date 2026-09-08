"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LearningMemory = void 0;
class LearningMemory {
    static memories = new Map();
    /**
     * Stores or updates a learning memory item.
     */
    static setMemory(item) {
        const existing = this.memories.get(item.key);
        const now = new Date();
        const fullItem = {
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
    static getMemory(key) {
        return this.memories.get(key);
    }
    /**
     * Retrieves all memory items by type.
     */
    static getMemoriesByType(type) {
        const all = Array.from(this.memories.values());
        if (!type)
            return all;
        return all.filter((m) => m.memoryType === type && m.status === 'ACTIVE');
    }
    /**
     * Clears in-memory memory store.
     */
    static clear() {
        this.memories.clear();
    }
}
exports.LearningMemory = LearningMemory;
//# sourceMappingURL=learning-memory.js.map