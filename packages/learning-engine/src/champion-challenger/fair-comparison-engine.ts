import {
  EvaluationBundle,
  ComparisonResult,
  MetricDeltas
} from './types';
import { deepFreeze, computeEvaluationFingerprint, computeResultHash, computeBundleHash } from './evaluation-identity';

/**
 * FairComparisonEngine
 *
 * Guarantees that Champion and Challenger models are evaluated under 100% identical,
 * deterministic conditions. Fails closed (isComparable: false) if there is ANY
 * divergence in dataset, features, labels, code commit, evaluation window,
 * walk-forward config, execution simulator, risk config, cost config,
 * partial exit policy, strategy config, or random seed.
 */
export class FairComparisonEngine {
  /**
   * Validates whether two evaluation bundles are comparable.
   * Checks every dimension of the evaluation environment including code commit and config hashes.
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

    // 1. Code commit parity
    if (champId.codeCommit !== challId.codeCommit) {
      reasons.push(
        `Code commit mismatch: champion=${champId.codeCommit}, challenger=${challId.codeCommit}`
      );
    }

    // 2. Dataset hash & version
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

    // 3. Feature schema & version
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

    // 4. Label version
    if (champId.labelVersion !== challId.labelVersion) {
      reasons.push(
        `Label version mismatch: champion=${champId.labelVersion}, challenger=${challId.labelVersion}`
      );
    }

    // 5. Evaluation window
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

    // 6. Walk-forward config version & hash
    if (champId.walkForwardConfigVersion !== challId.walkForwardConfigVersion) {
      reasons.push(
        `Walk-forward config version mismatch: champion=${champId.walkForwardConfigVersion}, challenger=${challId.walkForwardConfigVersion}`
      );
    }
    if (champId.walkForwardConfigHash !== challId.walkForwardConfigHash) {
      reasons.push(
        `Walk-forward config hash mismatch: champion=${champId.walkForwardConfigHash}, challenger=${challId.walkForwardConfigHash}`
      );
    }

    // 7. Execution config version & hash
    if (champId.executionConfigVersion !== challId.executionConfigVersion) {
      reasons.push(
        `Execution config version mismatch: champion=${champId.executionConfigVersion}, challenger=${challId.executionConfigVersion}`
      );
    }
    if (champId.executionConfigHash !== challId.executionConfigHash) {
      reasons.push(
        `Execution config hash mismatch: champion=${champId.executionConfigHash}, challenger=${challId.executionConfigHash}`
      );
    }

    // 8. Risk config version & hash
    if (champId.riskConfigVersion !== challId.riskConfigVersion) {
      reasons.push(
        `Risk config version mismatch: champion=${champId.riskConfigVersion}, challenger=${challId.riskConfigVersion}`
      );
    }
    if (champId.riskConfigHash !== challId.riskConfigHash) {
      reasons.push(
        `Risk config hash mismatch: champion=${champId.riskConfigHash}, challenger=${challId.riskConfigHash}`
      );
    }

    // 9. Cost config version & hash
    if (champId.costConfigVersion !== challId.costConfigVersion) {
      reasons.push(
        `Cost config version mismatch: champion=${champId.costConfigVersion}, challenger=${challId.costConfigVersion}`
      );
    }
    if (champId.costConfigHash !== challId.costConfigHash) {
      reasons.push(
        `Cost config hash mismatch: champion=${champId.costConfigHash}, challenger=${challId.costConfigHash}`
      );
    }

    // 10. Partial exit policy version & hash
    if (champId.partialExitPolicyVersion !== challId.partialExitPolicyVersion) {
      reasons.push(
        `Partial exit policy version mismatch: champion=${champId.partialExitPolicyVersion}, challenger=${challId.partialExitPolicyVersion}`
      );
    }
    if (champId.partialExitPolicyHash !== challId.partialExitPolicyHash) {
      reasons.push(
        `Partial exit policy hash mismatch: champion=${champId.partialExitPolicyHash}, challenger=${challId.partialExitPolicyHash}`
      );
    }

    // 11. Strategy config version & hash
    if (champId.strategyConfigVersion !== challId.strategyConfigVersion) {
      reasons.push(
        `Strategy config version mismatch: champion=${champId.strategyConfigVersion}, challenger=${challId.strategyConfigVersion}`
      );
    }
    if (champId.strategyConfigHash !== challId.strategyConfigHash) {
      reasons.push(
        `Strategy config hash mismatch: champion=${champId.strategyConfigHash}, challenger=${challId.strategyConfigHash}`
      );
    }

    // 12. Random seed
    if (champId.randomSeed !== challId.randomSeed) {
      reasons.push(
        `Random seed mismatch: champion=${champId.randomSeed}, challenger=${challId.randomSeed}`
      );
    }

    // 13. Bundle internal cryptographic integrity verification
    if (championBundle.bundleHash) {
      const champFp = computeEvaluationFingerprint(champId);
      const champResHash = computeResultHash({
        metrics: championBundle.metrics,
        tradeStatistics: championBundle.tradeStatistics,
        riskStatistics: championBundle.riskStatistics,
        costStatistics: championBundle.costStatistics,
        walkForwardStatistics: championBundle.walkForwardStatistics,
        perWindowResults: championBundle.perWindowResults,
        validationResults: championBundle.validationResults,
      });
      const expectedChampBundleHash = computeBundleHash(champFp, champResHash);
      if (championBundle.bundleHash !== expectedChampBundleHash) {
        reasons.push('Champion bundle integrity violation: bundleHash does not match computed bundle hash');
      }
    }

    if (challengerBundle.bundleHash) {
      const challFp = computeEvaluationFingerprint(challId);
      const challResHash = computeResultHash({
        metrics: challengerBundle.metrics,
        tradeStatistics: challengerBundle.tradeStatistics,
        riskStatistics: challengerBundle.riskStatistics,
        costStatistics: challengerBundle.costStatistics,
        walkForwardStatistics: challengerBundle.walkForwardStatistics,
        perWindowResults: challengerBundle.perWindowResults,
        validationResults: challengerBundle.validationResults,
      });
      const expectedChallBundleHash = computeBundleHash(challFp, challResHash);
      if (challengerBundle.bundleHash !== expectedChallBundleHash) {
        reasons.push('Challenger bundle integrity violation: bundleHash does not match computed bundle hash');
      }
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
        championBundleHash: championBundle?.bundleHash,
        challengerBundleHash: challengerBundle?.bundleHash,
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
      championBundleHash: championBundle.bundleHash,
      challengerBundleHash: challengerBundle.bundleHash,
      championMetrics: champM,
      challengerMetrics: challM,
      deltas,
      comparedAt: Date.now()
    };

    return deepFreeze(result);
  }
}
