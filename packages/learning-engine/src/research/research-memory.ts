import { HypothesisStatus, ResearchHypothesis } from './types';

export class ResearchMemory {
  private static hypotheses: Map<string, ResearchHypothesis> = new Map();

  /**
   * Records or updates a hypothesis in memory.
   */
  public static recordHypothesis(hypothesis: ResearchHypothesis): ResearchHypothesis {
    const existing = this.hypotheses.get(hypothesis.id);
    if (existing) {
      existing.testedCount += 1;
      existing.lastTestedAt = new Date();
      if (hypothesis.status === 'VALIDATED' || hypothesis.status === 'PROMOTED') {
        existing.successCount += 1;
        existing.status = hypothesis.status;
      } else if (hypothesis.status === 'REJECTED') {
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
  public static isHypothesisRedundant(condition: string): {
    redundant: boolean;
    existing?: ResearchHypothesis;
  } {
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

  public static getHypothesis(id: string): ResearchHypothesis | undefined {
    return this.hypotheses.get(id);
  }

  public static listHypotheses(status?: HypothesisStatus): ResearchHypothesis[] {
    const all = Array.from(this.hypotheses.values());
    if (status) {
      return all.filter((h) => h.status === status);
    }
    return all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  public static updateHypothesisStatus(
    id: string,
    status: HypothesisStatus,
    rejectionReason?: string,
  ): ResearchHypothesis {
    const existing = this.hypotheses.get(id);
    if (!existing) {
      throw new Error(`Hypothesis '${id}' not found in ResearchMemory.`);
    }
    existing.status = status;
    existing.lastTestedAt = new Date();
    if (rejectionReason) existing.rejectionReason = rejectionReason;
    if (status === 'VALIDATED' || status === 'PROMOTED') existing.successCount += 1;
    if (status === 'REJECTED') existing.rejectedCount += 1;
    return existing;
  }

  public static clear(): void {
    this.hypotheses.clear();
  }
}
