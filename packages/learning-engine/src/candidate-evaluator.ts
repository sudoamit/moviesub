import { StrategyCandidate, TradingExperience } from './types';

export interface ICandidateEvaluationResult {
  candidateId: string;
  passed: boolean;
  baselineExpectancy: number;
  candidateExpectancy: number;
  expectancyDelta: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  totalSimulatedTrades: number;
  rejectionReason?: string;
}

export class CandidateEvaluator {
  /**
   * Simulates candidate rule adjustments on historical trading experiences with transaction cost penalties.
   */
  public static evaluate(
    candidate: StrategyCandidate,
    experiences: TradingExperience[],
    costPerTradeR = 0.05, // 0.05R transaction cost / slippage penalty
  ): ICandidateEvaluationResult {
    const totalTrades = experiences.length;
    if (totalTrades < 5) {
      return {
        candidateId: candidate.id,
        passed: false,
        baselineExpectancy: 0,
        candidateExpectancy: 0,
        expectancyDelta: 0,
        profitFactor: 0,
        maxDrawdownPercent: 0,
        totalSimulatedTrades: 0,
        rejectionReason: 'Insufficient historical experiences for candidate evaluation.',
      };
    }

    const baselineSumR = experiences.reduce((sum, e) => sum + e.outcome.pnlR, 0);
    const baselineExpectancy = Number((baselineSumR / totalTrades).toFixed(2));

    // Simulate candidate filter / modifications
    const simulatedExperiences: { pnlR: number; pnl: number }[] = [];

    for (const exp of experiences) {
      let isTradeRejectedByCandidate = false;

      if (candidate.type === 'FILTER') {
        const rules = (candidate.change.conditionRules as string[]) || [];
        // Check if trade meets the negative filter conditions
        if (rules.includes('HTF_CONFLICT') && exp.failureReasons.includes('HTF_CONFLICT')) {
          isTradeRejectedByCandidate = true;
        }
        if (rules.includes('HIGH_VOLATILITY') && exp.marketContext.regime === 'HIGH_VOLATILITY') {
          isTradeRejectedByCandidate = true;
        }
      }

      if (!isTradeRejectedByCandidate) {
        // Trade executed under candidate, subtract transaction cost
        const adjustedR = exp.outcome.pnlR - costPerTradeR;
        const adjustedPnL = exp.outcome.pnl - Math.abs(exp.outcome.pnl * 0.02);
        simulatedExperiences.push({ pnlR: adjustedR, pnl: adjustedPnL });
      }
    }

    const simCount = simulatedExperiences.length;
    if (simCount === 0) {
      return {
        candidateId: candidate.id,
        passed: false,
        baselineExpectancy,
        candidateExpectancy: 0,
        expectancyDelta: -baselineExpectancy,
        profitFactor: 0,
        maxDrawdownPercent: 0,
        totalSimulatedTrades: 0,
        rejectionReason: 'Candidate filtered out 100% of all trades.',
      };
    }

    const simSumR = simulatedExperiences.reduce((sum, e) => sum + e.pnlR, 0);
    const candidateExpectancy = Number((simSumR / simCount).toFixed(2));
    const expectancyDelta = Number((candidateExpectancy - baselineExpectancy).toFixed(2));

    const grossProfit = simulatedExperiences
      .filter((e) => e.pnl > 0)
      .reduce((sum, e) => sum + e.pnl, 0);
    const grossLoss = simulatedExperiences
      .filter((e) => e.pnl < 0)
      .reduce((sum, e) => sum + Math.abs(e.pnl), 0);
    const profitFactor =
      grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 5.0 : 0.0;

    // Drawdown calculation in R
    let peakR = 0;
    let runningR = 0;
    let maxDDR = 0;
    for (const sim of simulatedExperiences) {
      runningR += sim.pnlR;
      if (runningR > peakR) peakR = runningR;
      const dd = peakR - runningR;
      if (dd > maxDDR) maxDDR = dd;
    }
    const maxDrawdownPercent = Number(maxDDR.toFixed(2));

    // Passing criteria: Positive expectancy delta and profit factor >= 1.25
    const passed = expectancyDelta > 0.02 && profitFactor >= 1.25 && candidateExpectancy > 0;
    const rejectionReason = !passed
      ? `Candidate did not improve expectancy (Delta: ${expectancyDelta}R, Profit Factor: ${profitFactor}).`
      : undefined;

    return {
      candidateId: candidate.id,
      passed,
      baselineExpectancy,
      candidateExpectancy,
      expectancyDelta,
      profitFactor,
      maxDrawdownPercent,
      totalSimulatedTrades: simCount,
      rejectionReason,
    };
  }
}
