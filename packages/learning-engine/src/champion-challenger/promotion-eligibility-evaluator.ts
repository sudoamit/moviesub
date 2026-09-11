import {
  ComparisonResult,
  FairPromotionCriteria,
  PromotionEligibility
} from './types';
import { deepFreeze } from './evaluation-identity';

/**
 * PromotionEligibilityEvaluator
 *
 * Pure functional engine that evaluates whether a Challenger meets all statistical
 * and risk hurdles to be eligible for promotion over the Champion.
 *
 * CRITICAL INVARIANTS:
 * 1. PURE FUNCTION — Zero side effects. Does not mutate the registry, records, or active champion.
 * 2. ZERO AUTOMATIC PROMOTION — Only returns an immutable diagnostic assessment.
 * 3. FAILS CLOSED — If evaluations are incomparable or data is missing, immediately marks ineligible.
 */
export class PromotionEligibilityEvaluator {
  /**
   * Evaluates promotion eligibility based on an immutable comparison result and promotion criteria.
   */
  public static calculatePromotionEligibility(
    comparison: ComparisonResult,
    criteria: FairPromotionCriteria
  ): PromotionEligibility {
    const reasons: string[] = [];
    const criteriaMet: Record<string, boolean> = {};

    // 1. Check comparability
    if (!comparison.isComparable || !comparison.deltas || !comparison.challengerMetrics) {
      return deepFreeze({
        eligible: false,
        reasons: [
          'Evaluations are not comparable or missing comparison metrics',
          ...(comparison.violationReasons || [])
        ],
        criteriaMet: {
          comparability: false
        },
        evaluatedAt: Date.now()
      });
    }

    criteriaMet.comparability = true;
    const { deltas, challengerMetrics } = comparison;

    // 2. Minimum trade count
    if (challengerMetrics.tradeCount < criteria.minTradeCount) {
      criteriaMet.minTradeCount = false;
      reasons.push(
        `Insufficient trade count: challenger has ${challengerMetrics.tradeCount}, required >= ${criteria.minTradeCount}`
      );
    } else {
      criteriaMet.minTradeCount = true;
    }

    // 3. Minimum expectancy delta
    if (deltas.expectancyDelta < criteria.minExpectancyDelta) {
      criteriaMet.minExpectancyDelta = false;
      reasons.push(
        `Expectancy delta too low: delta is ${deltas.expectancyDelta}, required >= ${criteria.minExpectancyDelta}`
      );
    } else {
      criteriaMet.minExpectancyDelta = true;
    }

    // 4. Maximum drawdown deterioration percent
    // drawdownDelta = challengerDrawdown - championDrawdown
    // If challenger drawdown is 15% and champion is 10%, drawdownDelta = +5%
    if (deltas.drawdownDelta > criteria.maxDrawdownDeteriorationPercent) {
      criteriaMet.maxDrawdownDeterioration = false;
      reasons.push(
        `Drawdown deterioration exceeded: delta is ${deltas.drawdownDelta}%, max allowed is ${criteria.maxDrawdownDeteriorationPercent}%`
      );
    } else {
      criteriaMet.maxDrawdownDeterioration = true;
    }

    // 5. Minimum win rate delta (optional)
    if (criteria.minWinRateDelta !== undefined) {
      if (deltas.winRateDelta < criteria.minWinRateDelta) {
        criteriaMet.minWinRateDelta = false;
        reasons.push(
          `Win rate delta too low: delta is ${deltas.winRateDelta}, required >= ${criteria.minWinRateDelta}`
        );
      } else {
        criteriaMet.minWinRateDelta = true;
      }
    }

    // 6. Minimum Sharpe delta (optional)
    if (criteria.minSharpeDelta !== undefined) {
      if (deltas.sharpeDelta === undefined || deltas.sharpeDelta < criteria.minSharpeDelta) {
        criteriaMet.minSharpeDelta = false;
        reasons.push(
          `Sharpe ratio delta too low or undefined: delta is ${deltas.sharpeDelta ?? 'undefined'}, required >= ${criteria.minSharpeDelta}`
        );
      } else {
        criteriaMet.minSharpeDelta = true;
      }
    }

    // 7. Minimum Profit Factor (optional)
    if (criteria.minProfitFactor !== undefined) {
      if (challengerMetrics.profitFactor < criteria.minProfitFactor) {
        criteriaMet.minProfitFactor = false;
        reasons.push(
          `Challenger profit factor too low: ${challengerMetrics.profitFactor}, required >= ${criteria.minProfitFactor}`
        );
      } else {
        criteriaMet.minProfitFactor = true;
      }
    }

    const eligible = reasons.length === 0;

    return deepFreeze({
      eligible,
      reasons: eligible ? ['All promotion criteria satisfied under fair comparison'] : reasons,
      criteriaMet,
      evaluatedAt: Date.now()
    });
  }
}
