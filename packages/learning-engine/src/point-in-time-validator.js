"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PointInTimeValidator = void 0;
class PointInTimeValidator {
    /**
     * Validates point-in-time causality invariants for a TradingExperience:
     * 1. featureTimestamp <= decisionTimestamp (features must exist at or before decision)
     * 2. decisionTimestamp < labelStartTimestamp (label outcome starts strictly after decision)
     * 3. labelStartTimestamp <= labelEndTimestamp (label range is chronologically valid)
     */
    static validatePointInTimeExperience(exp) {
        if (!exp) {
            return { isValid: false, reason: 'MISSING_EXPERIENCE' };
        }
        const decisionTimestamp = exp.decisionTimestamp ??
            (exp.timestamp ? new Date(exp.timestamp).getTime() : undefined);
        if (decisionTimestamp === undefined || Number.isNaN(decisionTimestamp) || !Number.isFinite(decisionTimestamp)) {
            return { isValid: false, reason: 'INVALID_DECISION_TIMESTAMP' };
        }
        const featureTimestamp = exp.featureTimestamp ?? decisionTimestamp;
        if (Number.isNaN(featureTimestamp) || !Number.isFinite(featureTimestamp)) {
            return { isValid: false, reason: 'INVALID_FEATURE_TIMESTAMP' };
        }
        const labelStartTimestamp = exp.labelStartTimestamp ??
            (exp.execution?.entryTime ? new Date(exp.execution.entryTime).getTime() : undefined);
        if (labelStartTimestamp === undefined ||
            Number.isNaN(labelStartTimestamp) ||
            !Number.isFinite(labelStartTimestamp)) {
            return { isValid: false, reason: 'MISSING_LABEL_START_TIMESTAMP' };
        }
        const labelEndTimestamp = exp.labelEndTimestamp ??
            (exp.execution?.exitTime ? new Date(exp.execution.exitTime).getTime() : undefined);
        if (labelEndTimestamp === undefined ||
            Number.isNaN(labelEndTimestamp) ||
            !Number.isFinite(labelEndTimestamp)) {
            return { isValid: false, reason: 'MISSING_LABEL_END_TIMESTAMP' };
        }
        // Invariant 1: featureTimestamp <= decisionTimestamp
        if (featureTimestamp > decisionTimestamp) {
            return {
                isValid: false,
                reason: `FEATURE_LOOKAHEAD_LEAKAGE: featureTimestamp (${featureTimestamp}) > decisionTimestamp (${decisionTimestamp})`,
                decisionTimestamp,
                featureTimestamp,
                labelStartTimestamp,
                labelEndTimestamp,
            };
        }
        // Invariant 2: decisionTimestamp < labelStartTimestamp
        if (decisionTimestamp >= labelStartTimestamp) {
            return {
                isValid: false,
                reason: `INVALID_DECISION_TIMING: decisionTimestamp (${decisionTimestamp}) >= labelStartTimestamp (${labelStartTimestamp})`,
                decisionTimestamp,
                featureTimestamp,
                labelStartTimestamp,
                labelEndTimestamp,
            };
        }
        // Invariant 3: labelStartTimestamp <= labelEndTimestamp
        if (labelStartTimestamp > labelEndTimestamp) {
            return {
                isValid: false,
                reason: `INVALID_LABEL_RANGE: labelStartTimestamp (${labelStartTimestamp}) > labelEndTimestamp (${labelEndTimestamp})`,
                decisionTimestamp,
                featureTimestamp,
                labelStartTimestamp,
                labelEndTimestamp,
            };
        }
        return {
            isValid: true,
            decisionTimestamp,
            featureTimestamp,
            labelStartTimestamp,
            labelEndTimestamp,
        };
    }
}
exports.PointInTimeValidator = PointInTimeValidator;
//# sourceMappingURL=point-in-time-validator.js.map