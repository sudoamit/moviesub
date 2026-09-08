import { Direction, ISignalReasoning, SignalGrade } from '@quant/shared';
import { ITradeLevels } from './trade-levels';
import { IMTFAnalysisResult } from './mtf-analyzer';
import { IScoringInputs } from './signal-scorer';
export interface IReasoningInputs {
    symbol: string;
    timeframe: string;
    direction: Direction;
    grade: SignalGrade;
    totalScore: number;
    mtf: IMTFAnalysisResult;
    scoring: IScoringInputs;
    levels: ITradeLevels | null;
    triggerDescription: string;
}
export declare class ReasoningGenerator {
    /**
     * Generates a transparent, deterministic "Why This Trade?" structured explanation
     */
    static generateReasoning(inputs: IReasoningInputs): ISignalReasoning;
}
