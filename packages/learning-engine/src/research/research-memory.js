"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResearchMemory = void 0;
class ResearchMemory {
    static hypotheses = new Map();
    /**
     * Records or updates a hypothesis in memory.
     */
    static recordHypothesis(hypothesis) {
        const existing = this.hypotheses.get(hypothesis.id);
        if (existing) {
            existing.testedCount += 1;
            existing.lastTestedAt = new Date();
            if (hypothesis.status === 'VALIDATED' || hypothesis.status === 'PROMOTED') {
                existing.successCount += 1;
                existing.status = hypothesis.status;
            }
            else if (hypothesis.status === 'REJECTED') {
                existing.rejectedCount += 1;
                existing.status = hypothesis.status;
                existing.rejectionReason = hypothesis.rejectionReason;
            }
            return existing;
        }
        this.hypotheses.set(hypothesis.id, hypothesis);
        return hypothesis;
    }
    /**
     * Checks if an identical or highly similar hypothesis has already been validated or rejected.
     */
    static isHypothesisRedundant(condition) {
        const normCondition = condition.trim().toLowerCase();
        for (const hyp of this.hypotheses.values()) {
            if (hyp.condition.trim().toLowerCase() === normCondition) {
                if (hyp.status === 'VALIDATED' || hyp.status === 'PROMOTED' || hyp.status === 'REJECTED') {
                    return { redundant: true, existing: hyp };
                }
            }
        }
        return { redundant: false };
    }
    static getHypothesis(id) {
        return this.hypotheses.get(id);
    }
    static listHypotheses(status) {
        const all = Array.from(this.hypotheses.values());
        if (status) {
            return all.filter((h) => h.status === status);
        }
        return all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }
    static updateHypothesisStatus(id, status, rejectionReason) {
        const existing = this.hypotheses.get(id);
        if (!existing) {
            throw new Error(`Hypothesis '${id}' not found in ResearchMemory.`);
        }
        existing.status = status;
        existing.lastTestedAt = new Date();
        if (rejectionReason)
            existing.rejectionReason = rejectionReason;
        if (status === 'VALIDATED' || status === 'PROMOTED')
            existing.successCount += 1;
        if (status === 'REJECTED')
            existing.rejectedCount += 1;
        return existing;
    }
    static clear() {
        this.hypotheses.clear();
    }
}
exports.ResearchMemory = ResearchMemory;
//# sourceMappingURL=research-memory.js.map