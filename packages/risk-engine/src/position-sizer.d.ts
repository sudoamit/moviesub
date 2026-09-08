import { IPositionSizing } from '@quant/shared';
export interface ICalculatePositionOptions {
    accountBalance: number;
    riskPercentage?: number;
    entryPrice: number;
    stopLoss: number;
    lotSize?: number;
    contractSize?: number;
    maxRiskPercentage?: number;
    maxLeverage?: number;
    regime?: string;
    volatilityPercentile?: number;
    expectedR?: number;
    mlProbability?: number;
}
export declare class PositionSizer {
    /**
     * Deterministically calculates institutional position size based on strict fixed percentage risk.
     * STRICT FAIL-CLOSED: If position sizing is invalid or below 1 lot, fails closed with isValid: false.
     */
    static calculatePosition(options: ICalculatePositionOptions): IPositionSizing;
    private static createInvalid;
}
