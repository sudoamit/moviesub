import {
  EvaluationBundle,
  ComparisonResult,
  MetricDeltas
} from './types';
import { deepFreeze } from './evaluation-identity';

/**
 * FairComparisonEngine
 *
 * Guarantees that Champion and Challenger models are evaluated under 100% identical,
 * deterministic conditions. Fails closed (isComparable: false) if there is ANY
 * divergence in dataset, features, labels, evaluation window, execution simulator,
 * risk config, cost config, partial exit policy, or random seed.
 */
export class FairComparisonEngine {
  /**
   * Validates whether two evaluation bundles are comparable.
   * Checks every dimension of the evaluation environment.
   */
  public static validateComparable(
    championBundle: EvaluationBundle,
    challengerBundle: EvaluationBundle
  ): { isComparable: boolean; violationReasons: string[] } {
    const reasons: string[] = [];

    if (!championBundle || !challengerBundle) {
      return {
        isComparable: false,
        violationReasons: ['Both champion and challenger evaluation bundles must be provided']
      };
    }

    const champId = championBundle.evaluationIdentity;
    const challId = challengerBundle.evaluationIdentity;

    if (!champId || !challId) {
      return {
        isComparable: false,
        violationReasons: ['Evaluation identities missing from one or both bundles']
      };
    }

    // 1. Dataset hash & version
    if (champId.datasetHash !== challId.datasetHash) {
      reasons.push(
        `Dataset hash mismatch: champion=${champId.datasetHash}, challenger=${challId.datasetHash}`
      );
    }
    if (champId.datasetVersion !== challId.datasetVersion) {
      reasons.push(
        `Dataset version mismatch: champion=${champId.datasetVersion}, challenger=${challId.datasetVersion}`
      );
    }

    // 2. Feature schema & version
    if (champId.featureSchemaHash !== challId.featureSchemaHash) {
      reasons.push(
        `Feature schema hash mismatch: champion=${champId.featureSchemaHash}, challenger=${challId.featureSchemaHash}`
      );
    }
    if (champId.featureVersion !== challId.featureVersion) {
      reasons.push(
        `Feature version mismatch: champion=${champId.featureVersion}, challenger=${challId.featureVersion}`
      );
    }

    // 3. Label version
    if (champId.labelVersion !== challId.labelVersion) {
      reasons.push(
        `Label version mismatch: champion=${champId.labelVersion}, challenger=${challId.labelVersion}`
      );
    }

    // 4. Evaluation window
    if (champId.evaluationWindowStart !== challId.evaluationWindowStart) {
      reasons.push(
        `Evaluation window start mismatch: champion=${champId.evaluationWindowStart}, challenger=${challId.evaluationWindowStart}`
      );
    }
    if (champId.evaluationWindowEnd !== challId.evaluationWindowEnd) {
      reasons.push(
        `Evaluation window end mismatch: champion=${champId.evaluationWindowEnd}, challenger=${challId.evaluationWindowEnd}`
      );
    }

    // 5. Walk-forward config version
    if (champId.walkForwardConfigVersion !== challId.walkForwardConfigVersion) {
      reasons.push(
        `Walk-forward config version mismatch: champion=${champId.walkForwardConfigVersion}, challenger=${challId.walkForwardConfigVersion}`
      );
    }

    // 6. Execution config hash & version
    if (champId.executionConfigHash !== challId.executionConfigHash) {
      reasons.push(
        `Execution config hash mismatch: champion=${champId.executionConfigHash}, challenger=${challId.executionConfigHash}`
      );
    }
    if (champId.executionConfigVersion !== challId.executionConfigVersion) {
      reasons.push(
        `Execution config version mismatch: champion=${champId.executionConfigVersion}, challenger=${challId.executionConfigVersion}`
      );
    }

    // 7. Risk config hash & version
    if (champId.riskConfigHash !== challId.riskConfigHash) {
      reasons.push(
        `Risk config hash mismatch: champion=${champId.riskConfigHash}, challenger=${challId.riskConfigHash}`
      );
    }
    if (champId.riskConfigVersion !== challId.riskConfigVersion) {
      reasons.push(
        `Risk config version mismatch: champion=${champId.riskConfigVersion}, challenger=${challId.riskConfigVersion}`
      );
    }

    // 8. Cost config hash & version
    if (champId.costConfigHash !== challId.costConfigHash) {
      reasons.push(
        `Cost config hash mismatch: champion=${champId.costConfigHash}, challenger=${challId.costConfigHash}`
      );
    }
    if (champId.costConfigVersion !== challId.costConfigVersion) {
      reasons.push(
        `Cost config version mismatch: champion=${champId.costConfigVersion}, challenger=${challId.costConfigVersion}`
      );
    }

    // 9. Partial exit policy version
    if (champId.partialExitPolicyVersion !== challId.partialExitPolicyVersion) {
      reasons.push(
        `Partial exit policy version mismatch: champion=${champId.partialExitPolicyVersion}, challenger=${challId.partialExitPolicyVersion}`
      );
    }

    // 10. Strategy config version
    if (champId.strategyConfigVersion !== challId.strategyConfigVersion) {
      reasons.push(
        `Strategy config version mismatch: champion=${champId.strategyConfigVersion}, challenger=${challId.strategyConfigVersion}`
      );
    }

    // 11. Random seed
    if (champId.randomSeed !== challId.randomSeed) {
      reasons.push(
        `Random seed mismatch: champion=${champId.randomSeed}, challenger=${challId.randomSeed}`
      );
    }

    return {
      isComparable: reasons.length === 0,
      violationReasons: reasons
    };
  }

  /**
   * Compares a Champion evaluation bundle and a Challenger evaluation bundle.
   * If environmental parity fails, returns isComparable = false and omits metric deltas.
   * If parity passes, calculates metric deltas and returns an immutable comparison result.
   */
  public static compareEvaluations(
    championBundle: EvaluationBundle,
    challengerBundle: EvaluationBundle
  ): ComparisonResult {
    const validation = this.validateComparable(championBundle, challengerBundle);

    if (!validation.isComparable) {
      const result: ComparisonResult = {
        isComparable: false,
        violationReasons: validation.violationReasons,
        championEvaluationId: championBundle?.evaluationIdentity?.evaluationId ?? 'UNKNOWN',
        challengerEvaluationId: challengerBundle?.evaluationIdentity?.evaluationId ?? 'UNKNOWN',
        championFingerprint: championBundle?.evaluationFingerprint ?? 'UNKNOWN',
        challengerFingerprint: challengerBundle?.evaluationFingerprint ?? 'UNKNOWN',
        comparedAt: Date.now()
      };
      return deepFreeze(result);
    }

    const champM = championBundle.metrics;
    const challM = challengerBundle.metrics;

    const deltas: MetricDeltas = {
      netPnlDelta: challM.netPnL - champM.netPnL,
      returnDelta: challM.totalReturn - champM.totalReturn,
      drawdownDelta: challM.maxDrawdownPercent - champM.maxDrawdownPercent,
      profitFactorDelta: challM.profitFactor - champM.profitFactor,
      winRateDelta: challM.winRate - champM.winRate,
      tradeCountDelta: challM.tradeCount - champM.tradeCount,
      expectancyDelta: challM.expectancy - champM.expectancy,
      costDelta: (challM.fees + challM.slippage) - (champM.fees + champM.slippage),
      sharpeDelta:
        champM.sharpeRatio !== undefined && challM.sharpeRatio !== undefined
          ? challM.sharpeRatio - champM.sharpeRatio
          : undefined,
      sortinoDelta:
        champM.sortinoRatio !== undefined && challM.sortinoRatio !== undefined
          ? challM.sortinoRatio - champM.sortinoRatio
          : undefined
    };

    const result: ComparisonResult = {
      isComparable: true,
      violationReasons: [],
      championEvaluationId: championBundle.evaluationIdentity.evaluationId,
      challengerEvaluationId: challengerBundle.evaluationIdentity.evaluationId,
      championFingerprint: championBundle.evaluationFingerprint,
      challengerFingerprint: challengerBundle.evaluationFingerprint,
      championMetrics: champM,
      challengerMetrics: challM,
      deltas,
      comparedAt: Date.now()
    };

    return deepFreeze(result);
  }
}
