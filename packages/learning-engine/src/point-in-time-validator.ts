import { TradingExperience } from './types';

export interface IPointInTimeValidationResult {
  isValid: boolean;
  reason?: string;
  decisionTimestamp?: number;
  featureTimestamp?: number;
  labelStartTimestamp?: number;
  labelEndTimestamp?: number;
}

export class PointInTimeValidator {
  /**
   * Validates point-in-time causality invariants for a TradingExperience:
   * 1. featureTimestamp <= decisionTimestamp (features must exist at or before decision)
   * 2. decisionTimestamp < labelStartTimestamp (label outcome starts strictly after decision)
   * 3. labelStartTimestamp <= labelEndTimestamp (label range is chronologically valid)
   */
  public static validatePointInTimeExperience(
    exp: TradingExperience,
  ): IPointInTimeValidationResult {
    if (!exp) {
      return { isValid: false, reason: 'MISSING_EXPERIENCE' };
    }

    const decisionTimestamp =
      exp.decisionTimestamp ??
      (exp.timestamp ? new Date(exp.timestamp).getTime() : undefined);

    if (decisionTimestamp === undefined || Number.isNaN(decisionTimestamp) || !Number.isFinite(decisionTimestamp)) {
      return { isValid: false, reason: 'INVALID_DECISION_TIMESTAMP' };
    }

    const featureTimestamp =
      exp.featureTimestamp ?? decisionTimestamp;

    if (Number.isNaN(featureTimestamp) || !Number.isFinite(featureTimestamp)) {
      return { isValid: false, reason: 'INVALID_FEATURE_TIMESTAMP' };
    }

    // Default labelStart to entryTime or decisionTimestamp + 1ms if not explicitly specified
    const defaultLabelStart = exp.execution?.entryTime
      ? new Date(exp.execution.entryTime).getTime()
      : decisionTimestamp + 1;
    const labelStartTimestamp = exp.labelStartTimestamp ?? defaultLabelStart;

    if (Number.isNaN(labelStartTimestamp) || !Number.isFinite(labelStartTimestamp)) {
      return { isValid: false, reason: 'INVALID_LABEL_START_TIMESTAMP' };
    }

    // Default labelEnd to exitTime or labelStartTimestamp if not explicitly specified
    const defaultLabelEnd = exp.execution?.exitTime
      ? new Date(exp.execution.exitTime).getTime()
      : labelStartTimestamp;
    const labelEndTimestamp = exp.labelEndTimestamp ?? defaultLabelEnd;

    if (Number.isNaN(labelEndTimestamp) || !Number.isFinite(labelEndTimestamp)) {
      return { isValid: false, reason: 'INVALID_LABEL_END_TIMESTAMP' };
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
