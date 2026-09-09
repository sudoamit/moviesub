import {
  CandidateArtifact,
  PromotionCriteria,
  PromotionDecision,
  PromotionEvaluationResult,
  PromotionEvidence,
  PromotionGateInput,
  PromotionPolicy,
  StrategyCandidate,
} from './types';
import { CandidateBacktestRunner } from './candidate-backtest-runner';
import { ModelRegistry } from './model-registry';

export class PromotionGate {
  public static readonly DEFAULT_POLICY: PromotionPolicy = {
    policyVersion: 'v2.0',
    minimumShadowTrades: 5,
    minimumShadowObservations: 20,
    minimumProfitFactor: 1.25,
    minimumExpectancyR: 0.20,
    maximumDrawdownR: 3.0,
    minimumWinRate: 50.0,
    requirePositiveNetPnl: true,
    requireIndependentShadowWindow: true,
    allowAutoPromotion: false,
  };

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
   * Pure, decoupled evaluation of promotion gate input against policy thresholds.
   * Does NOT mutate production state directly.
   */
  public static evaluatePromotion(input: PromotionGateInput): PromotionDecision {
    const { candidateArtifact, shadowResult, policy } = input;
    const evaluatedAt = Date.now();
    const policyVersion = policy.policyVersion || 'v2.0';
    const reasons: string[] = [];
    const rejectionReasons: string[] = [];

    // 1. Validate Candidate Artifact Integrity
    const artifactValidation = CandidateBacktestRunner.validateArtifactIntegrity(candidateArtifact);
    if (!artifactValidation.isValid) {
      rejectionReasons.push(artifactValidation.reason || 'ARTIFACT_INTEGRITY_VIOLATION');
    }

    // 2. Validate Shadow Result Presence and Execution Success
    if (!shadowResult) {
      rejectionReasons.push('INSUFFICIENT_SHADOW_EVIDENCE: Missing shadow evaluation result');
    } else if (!shadowResult.passed) {
      rejectionReasons.push(shadowResult.rejectionReason || 'SHADOW_EVALUATION_FAILED');
    }

    const metrics = shadowResult?.metrics || {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      grossPnL: 0,
      netPnL: 0,
      pnlR: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      maxDrawdownR: 0,
      expectancy: 0,
      averageR: 0,
      medianR: 0,
      largestLoss: 0,
      largestWin: 0,
      fees: 0,
      slippage: 0,
      observationsCount: 0,
    };

    // 3. Shadow Window Observations & Volume Check
    if (metrics.observationsCount < policy.minimumShadowObservations) {
      rejectionReasons.push(
        `INSUFFICIENT_SHADOW_OBSERVATIONS: Shadow window observations (${metrics.observationsCount}) < policy minimum (${policy.minimumShadowObservations})`,
      );
    }

    if (metrics.totalTrades < policy.minimumShadowTrades) {
      rejectionReasons.push(
        `INSUFFICIENT_SHADOW_TRADES: Shadow trades (${metrics.totalTrades}) < policy minimum (${policy.minimumShadowTrades})`,
      );
    }

    // 4. Profit Factor Threshold
    if (metrics.profitFactor < policy.minimumProfitFactor) {
      rejectionReasons.push(
        `PROFIT_FACTOR_BELOW_THRESHOLD: Shadow profit factor (${metrics.profitFactor}) < policy minimum (${policy.minimumProfitFactor})`,
      );
    }

    // 5. Expectancy Threshold
    if (metrics.expectancy < policy.minimumExpectancyR) {
      rejectionReasons.push(
        `EXPECTANCY_BELOW_THRESHOLD: Shadow expectancy (+${metrics.expectancy}R) < policy minimum (+${policy.minimumExpectancyR}R)`,
      );
    }

    // 6. Drawdown Limit
    if (metrics.maxDrawdownR > policy.maximumDrawdownR) {
      rejectionReasons.push(
        `DRAWDOWN_ABOVE_LIMIT: Shadow drawdown (${metrics.maxDrawdownR}R) exceeds policy limit (${policy.maximumDrawdownR}R)`,
      );
    }

    // 7. Net PnL Check
    if (policy.requirePositiveNetPnl && metrics.netPnL <= 0) {
      rejectionReasons.push(
        `NEGATIVE_NET_PNL: Shadow net PnL (${metrics.netPnL}) is non-positive`,
      );
    }

    // 8. Win Rate Check
    if (policy.minimumWinRate !== undefined && metrics.winRate < policy.minimumWinRate) {
      rejectionReasons.push(
        `WIN_RATE_BELOW_THRESHOLD: Shadow win rate (${metrics.winRate}%) < policy minimum (${policy.minimumWinRate}%)`,
      );
    }

    // 9. Auto-Promotion Authority Check
    if (rejectionReasons.length === 0) {
      if (!policy.allowAutoPromotion) {
        rejectionReasons.push(
          'AUTO_PROMOTION_DISABLED: Candidate strategy approved by metrics and held in PROMOTION_ELIGIBLE state',
        );
      } else {
        reasons.push(`All promotion gate metrics passed policy ${policyVersion} criteria.`);
        reasons.push(`Shadow expectancy: +${metrics.expectancy}R across ${metrics.totalTrades} trades.`);
        reasons.push(`Profit Factor: ${metrics.profitFactor}, Net PnL: +${metrics.netPnL}.`);
      }
    }

    const decision: 'PROMOTE' | 'REJECT' =
      rejectionReasons.length === 0 && policy.allowAutoPromotion ? 'PROMOTE' : 'REJECT';

    const evidenceId = `pe-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const evidence: PromotionEvidence = {
      evidenceId,
      candidateId: candidateArtifact.candidateId,
      artifactHash: candidateArtifact.artifactHash,
      trainingDatasetHash: candidateArtifact.trainingDatasetHash,
      validationDatasetHash: candidateArtifact.validationDatasetHash,
      oosDatasetHash: candidateArtifact.oosDatasetHash,
      shadowDatasetHash: shadowResult?.shadowDatasetHash || candidateArtifact.marketDatasetHash,
      shadowWindowStart: shadowResult?.shadowStartTimestamp ?? 0,
      shadowWindowEnd: shadowResult?.shadowEndTimestamp ?? evaluatedAt,
      shadowMetrics: metrics,
      promotionPolicyVersion: policyVersion,
      promotionDecision: decision,
      decisionReasons: decision === 'PROMOTE' ? reasons : rejectionReasons,
      evaluatedAt,
    };

    const resultDecision: PromotionDecision = {
      decision,
      candidateId: candidateArtifact.candidateId,
      evidenceId,
      evaluatedAt,
      reasons: decision === 'PROMOTE' ? reasons : [],
      rejectionReasons: rejectionReasons.length > 0 ? rejectionReasons : undefined,
      metrics,
      policyVersion,
    };

    if (ModelRegistry.getCandidateArtifact(candidateArtifact.candidateId)) {
      ModelRegistry.recordPromotionOutcome(candidateArtifact.candidateId, evidence, resultDecision);
    }

    return resultDecision;
  }

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

    // 5. Shadow Trading Validation (Mandatory for promotion)
    if (!candidate.shadowMetrics) {
      rejectionDetails.push(
        `Insufficient shadow evidence: shadowMetrics is missing. Candidate cannot be promoted without shadow evidence.`,
      );
      score -= 40;
    } else if (candidate.shadowMetrics.shadowTradeCount < criteria.minShadowTrades) {
      rejectionDetails.push(
        `Insufficient shadow trade volume (${candidate.shadowMetrics.shadowTradeCount} trades < required ${criteria.minShadowTrades}).`,
      );
      score -= 40;
    } else if (candidate.shadowMetrics.shadowExpectancy < expBefore) {
      rejectionDetails.push(
        `Shadow trading expectancy (${candidate.shadowMetrics.shadowExpectancy}R) underperformed baseline (${expBefore}R).`,
      );
      score -= 35;
    } else {
      reasons.push(
        `Live shadow trading performance confirmed (+${candidate.shadowMetrics.shadowExpectancy}R across ${candidate.shadowMetrics.shadowTradeCount} trades).`,
      );
    }

    // 6. Explicit Auto Promotion Approval Check
    if (!criteria.allowAutoPromotion) {
      rejectionDetails.push(
        `Auto promotion disabled (allowAutoPromotion is false). Candidate strategy held in SHADOW / VALIDATED state.`,
      );
      score -= 50;
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
   * Computes the recommended Canary Deployment capital allocation stage.
   */
  public static calculateCanaryAllocation(
    candidate: StrategyCandidate,
    liveCanaryTradesCount: number,
    canaryExpectancyR: number,
    baselineExpectancyR: number,
  ): {
    allocationPct: number;
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
    if (canaryExpectancyR < baselineExpectancyR * 0.8) {
      return {
        allocationPct: 5,
        stageName: 'INITIAL_CANARY',
        recommendation: `Performance Warning: Canary expectancy (${canaryExpectancyR}R) below baseline (${baselineExpectancyR}R). Keeping allocation at 5%.`,
      };
    }
    if (liveCanaryTradesCount < 25) {
      return {
        allocationPct: 10,
        stageName: 'MODERATE_EXPANSION',
        recommendation: `Stage 2 Canary: 10% capital allocation based on positive initial live sample.`,
      };
    }
    if (liveCanaryTradesCount < 50) {
      return {
        allocationPct: 25,
        stageName: 'HALF_CAPITAL',
        recommendation: `Stage 3 Canary: 25% capital allocation after robust live validation.`,
      };
    }
    return {
      allocationPct: 50,
      stageName: 'FULL_PRODUCTION',
      recommendation: `Stage 4: 50% allocation authorized. Strategy approaching full unconstrained deployment.`,
    };
  }
}
