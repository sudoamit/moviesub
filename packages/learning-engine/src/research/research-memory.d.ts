import { HypothesisStatus, ResearchHypothesis } from './types';
export declare class ResearchMemory {
    private static hypotheses;
    /**
     * Records or updates a hypothesis in memory.
     */
    static recordHypothesis(hypothesis: ResearchHypothesis): ResearchHypothesis;
    /**
     * Checks if an identical or highly similar hypothesis has already been validated or rejected.
     */
    static isHypothesisRedundant(condition: string): {
        redundant: boolean;
        existing?: ResearchHypothesis;
    };
    static getHypothesis(id: string): ResearchHypothesis | undefined;
    static listHypotheses(status?: HypothesisStatus): ResearchHypothesis[];
    static updateHypothesisStatus(id: string, status: HypothesisStatus, rejectionReason?: string): ResearchHypothesis;
    static clear(): void;
}
