import { Direction, MarketRegimeType } from '@quant/shared';
import { QuantSMCScore } from './quant-types';
export interface IQuantScoringInputs {
    direction: Direction;
    hasBOS: boolean;
    hasCHOCH: boolean;
    structureStrength?: number;
    mtfAlignment: 'ALIGNED' | 'PARTIALLY_ALIGNED' | 'CONFLICTED';
    mtfConfluenceScore: number;
    hasLiquiditySweep: boolean;
    sweepDepthAtrRatio?: number;
    hasOrderBlock: boolean;
    obStrength?: number;
    hasFVG: boolean;
    fvgSizeAtrRatio?: number;
    relativeVolume: number;
    rsiValue: number;
    regime: MarketRegimeType;
    volatilityPercentile: number;
    riskRewardRatio: number;
    inCorrectEquilibriumZone: boolean;
}
export declare class QuantSMCScorer {
    /**
     * Calculates an audited, explainable 10-pillar Quant + SMC confluence score.
     */
    static score(inputs: IQuantScoringInputs): QuantSMCScore;
}
