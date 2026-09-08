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
  simulatedRMultiples: number[];
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
        simulatedRMultiples: [],
        rejectionReason: 'Insufficient historical experiences for candidate evaluation.',
      };
    }

    const baselineSumR = experiences.reduce((sum, e) => sum + e.outcome.pnlR, 0);
    const baselineExpectancy = Number((baselineSumR / totalTrades).toFixed(2));

    const simulatedExperiences: { pnlR: number; pnl: number }[] = [];

    for (const exp of experiences) {
      let isTradeRejectedByCandidate = false;
      let pnlRMultiplier = 1.0;
      let stopLossDistMultiplier = 1.0;

      // 1. FILTER Candidate Type
      if (candidate.type === 'FILTER') {
        const rules = (candidate.change.conditionRules as string[]) || [];
        if (rules.includes('HTF_CONFLICT') && exp.failureReasons.includes('HTF_CONFLICT')) {
          isTradeRejectedByCandidate = true;
        }
        if (rules.includes('HIGH_VOLATILITY') && exp.marketContext.regime === 'HIGH_VOLATILITY') {
          isTradeRejectedByCandidate = true;
        }
        if (candidate.change.parameter === 'minMtfScore' && (exp.decision.score || 0) < 75) {
          isTradeRejectedByCandidate = true;
        }
      }

      // 2. THRESHOLD Candidate Type
      if (candidate.type === 'THRESHOLD') {
        const param = candidate.change.parameter;
        const val = candidate.change.value as number;
        if (param === 'minMtfScore' && (exp.decision.score || 0) < (val || 70)) {
          isTradeRejectedByCandidate = true;
        } else if (candidate.change.action === 'BOOST_CONFIRMATION') {
          pnlRMultiplier = (candidate.change.convictionMultiplier as number) || 1.2;
        }
      }

      // 3. VOLATILITY Candidate Type
      if (candidate.type === 'VOLATILITY') {
        const mult = (candidate.change.highVolatilitySizingMultiplier as number) || 0.5;
        if (
          exp.marketContext.regime === 'HIGH_VOLATILITY' ||
          exp.marketContext.volatilityRegime === 'HIGH'
        ) {
          pnlRMultiplier = mult;
        }
      }

      // 4. EXIT Candidate Type
      if (candidate.type === 'EXIT') {
        if (candidate.change.parameter === 'stopLossAtrMultiplier') {
          const mult = (candidate.change.value as number) || 1.25;
          stopLossDistMultiplier = mult;
        }
        if (candidate.change.parameter === 'enablePartialTp1Trailing') {
          if (exp.outcome.maxFavorableExcursion >= 1.5) {
            pnlRMultiplier = 1.1; // Lock in partial TP1 early
          }
        }
      }

      // 5. POSITION_SIZE Candidate Type
      if (candidate.type === 'POSITION_SIZE') {
        const sizingMultiplier = (candidate.change.sizingMultiplier as number) || 1.0;
        pnlRMultiplier = sizingMultiplier;
      }

      // 6. REGIME Candidate Type
      if (candidate.type === 'REGIME') {
        const filterRegime = candidate.change.filterRegime as string;
        if (filterRegime && exp.marketContext.regime === filterRegime) {
          isTradeRejectedByCandidate = true;
        }
      }

      // 7. MODEL & FEATURE Candidate Types
      if (candidate.type === 'MODEL' || candidate.type === 'FEATURE') {
        const minProb = (candidate.change.minProbability as number) || 0.55;
        if (exp.prediction?.probabilityWin !== undefined && exp.prediction.probabilityWin < minProb) {
          isTradeRejectedByCandidate = true;
        }
      }

      if (!isTradeRejectedByCandidate) {
        // Compute trade result under candidate's parameter changes minus cost
        const rawR = (exp.outcome.pnlR / stopLossDistMultiplier) * pnlRMultiplier;
        const adjustedR = Number((rawR - costPerTradeR).toFixed(4));
        const adjustedPnL = Number(
          (exp.outcome.pnl * pnlRMultiplier - Math.abs(exp.outcome.pnl * 0.02)).toFixed(2),
        );
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
        simulatedRMultiples: [],
        rejectionReason: 'Candidate filtered out 100% of all trades.',
      };
    }

    const rMultiples = simulatedExperiences.map((e) => e.pnlR);
    const simSumR = rMultiples.reduce((sum, r) => sum + r, 0);
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
      simulatedRMultiples: rMultiples,
      rejectionReason,
    };
  }
}
