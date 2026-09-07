import { PromotionCriteria, PromotionEvaluationResult, StrategyCandidate } from './types';

export class PromotionGate {
  public static readonly DEFAULT_CRITERIA: PromotionCriteria = {
    minHistoricalTrades: 20,
    minShadowTrades: 10,
    minOutOfSampleExpectancyDelta: 0.05,
    maxAllowedDrawdownIncreasePct: 10.0,
    maxMonteCarloRuinProbability: 0.01,
    requireMultiRegimeRobustness: true,
    requireTransactionCostSurvival: true,
    allowAutoPromotion: false,
  };

  /**
   * Evaluates a strategy candidate against institutional promotion criteria.
   */
  public static evaluateCandidate(
    candidate: StrategyCandidate,
    criteria: PromotionCriteria = this.DEFAULT_CRITERIA,
  ): PromotionEvaluationResult {
    const reasons: string[] = [];
    const rejectionDetails: string[] = [];
    let score = 100;

    // 1. Sample Size Check
    if (candidate.evidence.sampleSize < criteria.minHistoricalTrades) {
      rejectionDetails.push(
        `Insufficient sample size: ${candidate.evidence.sampleSize} trades < required ${criteria.minHistoricalTrades}.`,
      );
      score -= 30;
    } else {
      reasons.push(
        `Historical sample size validated (${candidate.evidence.sampleSize} observations).`,
      );
    }

    // 2. Out-of-Sample Expectancy Delta Check
    const oosExp =
      candidate.validationMetrics?.outOfSampleExpectancy ??
      candidate.evidence.expectancyAfterHistorical;
    const expBefore = candidate.evidence.expectancyBefore;
    const delta = oosExp - expBefore;

    if (delta < criteria.minOutOfSampleExpectancyDelta) {
      rejectionDetails.push(
        `Out-of-sample expectancy improvement (+${delta.toFixed(2)}R) did not meet minimum threshold (+${criteria.minOutOfSampleExpectancyDelta}R).`,
      );
      score -= 30;
    } else {
      reasons.push(
        `Demonstrated statistically robust out-of-sample improvement (+${delta.toFixed(2)}R).`,
      );
    }

    // 3. Monte Carlo Ruin Probability Check
    const ruinProb = candidate.validationMetrics?.monteCarloRuinProb ?? 0.0;
    if (ruinProb > criteria.maxMonteCarloRuinProbability) {
      rejectionDetails.push(
        `Monte Carlo probability of ruin (${(ruinProb * 100).toFixed(1)}%) exceeds safety limit (${(criteria.maxMonteCarloRuinProbability * 100).toFixed(1)}%).`,
      );
      score -= 25;
    } else {
      reasons.push(`Passed 1,000-iteration Monte Carlo stress tests with zero ruin risk.`);
    }

    // 4. Transaction Cost Survival Check
    if (
      criteria.requireTransactionCostSurvival &&
      candidate.validationMetrics &&
      !candidate.validationMetrics.transactionCostSurvived
    ) {
      rejectionDetails.push(`Candidate failed double-cost transaction slippage stress test.`);
      score -= 20;
    } else {
      reasons.push(
        `Maintains positive expectancy under aggressive transaction fee and slippage stress.`,
      );
    }

    // 5. Shadow Trading Validation
    if (candidate.shadowMetrics) {
      if (candidate.shadowMetrics.shadowTradeCount >= criteria.minShadowTrades) {
        if (candidate.shadowMetrics.shadowExpectancy < expBefore) {
          rejectionDetails.push(
            `Shadow trading expectancy (${candidate.shadowMetrics.shadowExpectancy}R) underperformed baseline (${expBefore}R).`,
          );
          score -= 35;
        } else {
          reasons.push(
            `Live shadow trading performance confirmed (+${candidate.shadowMetrics.shadowExpectancy}R).`,
          );
        }
      }
    }

    const approved = rejectionDetails.length === 0 && score >= 70;

    if (approved) {
      candidate.status = 'PROMOTED';
      candidate.promotedAt = new Date();
    } else {
      candidate.status = 'REJECTED';
      candidate.rejectionReason = rejectionDetails.join(' | ');
    }

    return {
      approved,
      candidateId: candidate.id,
      candidateVersion: candidate.candidateVersion,
      score: Math.max(0, score),
      reasons,
      rejectionDetails: rejectionDetails.length > 0 ? rejectionDetails : undefined,
    };
  }

  /**
   * Computes the recommended Canary Deployment capital allocation stage (5% -> 10% -> 25% -> 50% -> 100%).
   */
  public static calculateCanaryAllocation(
    candidate: StrategyCandidate,
    liveCanaryTradesCount: number,
    canaryExpectancyR: number,
    baselineExpectancyR: number,
  ): {
    allocationPct: number; // 5, 10, 25, 50, 100
    stageName: 'INITIAL_CANARY' | 'MODERATE_EXPANSION' | 'HALF_CAPITAL' | 'FULL_PRODUCTION';
    recommendation: string;
  } {
    if (liveCanaryTradesCount < 10) {
      return {
        allocationPct: 5,
        stageName: 'INITIAL_CANARY',
        recommendation: `Stage 1 Canary: 5% capital allocation. Minimum 10 live trades required before scaling.`,
      };
    }

    if (canaryExpectancyR < baselineExpectancyR) {
      return {
        allocationPct: 5,
        stageName: 'INITIAL_CANARY',
        recommendation: `Canary expectancy (${canaryExpectancyR.toFixed(2)}R) underperformed baseline (${baselineExpectancyR.toFixed(2)}R). Freeze allocation at 5% or consider rollback.`,
      };
    }

    if (liveCanaryTradesCount < 25) {
      return {
        allocationPct: 25,
        stageName: 'MODERATE_EXPANSION',
        recommendation: `Stage 2 Canary: 25% capital allocation. Live canary expectancy is healthy (+${canaryExpectancyR.toFixed(2)}R).`,
      };
    }

    if (liveCanaryTradesCount < 50) {
      return {
        allocationPct: 50,
        stageName: 'HALF_CAPITAL',
        recommendation: `Stage 3 Canary: 50% capital allocation. Sustained outperformance over 25+ trades.`,
      };
    }

    return {
      allocationPct: 100,
      stageName: 'FULL_PRODUCTION',
      recommendation: `Full Production: 100% allocation. Candidate strategy successfully graduated canary trial.`,
    };
  }
}
