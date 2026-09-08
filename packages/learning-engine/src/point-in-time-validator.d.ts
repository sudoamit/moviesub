import { TradingExperience } from './types';
export interface IPointInTimeValidationResult {
    isValid: boolean;
    reason?: string;
    decisionTimestamp?: number;
    featureTimestamp?: number;
    labelStartTimestamp?: number;
    labelEndTimestamp?: number;
}
export declare class PointInTimeValidator {
    /**
     * Validates point-in-time causality invariants for a TradingExperience:
     * 1. featureTimestamp <= decisionTimestamp (features must exist at or before decision)
     * 2. decisionTimestamp < labelStartTimestamp (label outcome starts strictly after decision)
     * 3. labelStartTimestamp <= labelEndTimestamp (label range is chronologically valid)
     */
    static validatePointInTimeExperience(exp: TradingExperience): IPointInTimeValidationResult;
}
