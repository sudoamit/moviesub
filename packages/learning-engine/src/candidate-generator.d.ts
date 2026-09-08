import { DiscoveredPattern, IErrorReport, StrategyCandidate } from './types';
export interface ICandidateGeneratorInputs {
    baseStrategyVersion: string;
    errorReport: IErrorReport;
    patterns: DiscoveredPattern[];
}
export declare class CandidateGenerator {
    private static candidateSeq;
    /**
     * Translates error reports and discovered patterns into structured machine-readable Strategy Candidates.
     */
    static generateCandidates(inputs: ICandidateGeneratorInputs): StrategyCandidate[];
}
