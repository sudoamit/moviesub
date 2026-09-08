import { Direction, IScoreBreakdown, SignalGrade } from '@quant/shared';
export interface IConfluenceComponentScore {
    score: number;
    confidence: number;
    evidence: string;
    reason: string;
}
export interface IScoringInputs {
    direction: Direction;
    htfAligned: boolean;
    htfAlignmentScore: number;
    hasLiquiditySweep: boolean;
    liquidityQuality?: number;
    hasBOSOrCHOCH?: boolean;
    hasBOS?: boolean;
    hasCHOCH?: boolean;
    hasOBOrFVG?: boolean;
    hasOrderBlock?: boolean;
    orderBlockQuality?: number;
    hasFVG?: boolean;
    fvgQuality?: number;
    displacementRatio: number;
    inCorrectZone: boolean;
    hasVolumeExpansion: boolean;
    riskRewardRatio: number;
    indicatorsAligned: boolean;
}
export interface IDetailedScoreResult {
    totalScore: number;
    grade: SignalGrade;
    breakdown: IScoreBreakdown;
    components?: Record<string, IConfluenceComponentScore>;
}
export declare class SignalScorer {
    /**
     * Deterministically calculates 0-100 setup score and confidence grade with decoupled
     * Order Block, FVG, Liquidity, and Structural Quality components.
     */
    static calculateScore(inputs: IScoringInputs): IDetailedScoreResult;
}
