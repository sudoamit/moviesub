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
      let sizingMultiplier = 1.0;

      // 1. FILTER Candidate Type
      if (candidate.type === 'FILTER') {
        const rules = (candidate.change.conditionRules as string[]) || [];
        if (rules.includes('HTF_CONFLICT') && exp.failureReasons.includes('HTF_CONFLICT')) {
          isTradeRejectedByCandidate = true;
        }
        if (rules.includes('HIGH_VOLATILITY') && exp.marketContext.regime === 'HIGH_VOLATILITY') {
          isTradeRejectedByCandidate = true;
        }
        const reqScore = typeof candidate.change.value === 'number' ? candidate.change.value : (candidate.change.minScore as number);
        if (candidate.change.parameter === 'minMtfScore' && reqScore !== undefined && (exp.decision.score || 0) < reqScore) {
          isTradeRejectedByCandidate = true;
        }
      }

      // 2. THRESHOLD Candidate Type
      if (candidate.type === 'THRESHOLD') {
        const param = candidate.change.parameter;
        const reqVal = (candidate.change.value as number) ?? (candidate.change.threshold as number);
        if (param === 'minMtfScore' && reqVal !== undefined && (exp.decision.score || 0) < reqVal) {
          isTradeRejectedByCandidate = true;
        } else if (candidate.change.action === 'BOOST_CONFIRMATION') {
          sizingMultiplier = (candidate.change.convictionMultiplier as number) || 1.2;
        }
      }

      // 3. VOLATILITY Candidate Type
      if (candidate.type === 'VOLATILITY') {
        const mult = (candidate.change.highVolatilitySizingMultiplier as number) || (candidate.change.value as number) || 0.5;
        if (
          exp.marketContext.regime === 'HIGH_VOLATILITY' ||
          exp.marketContext.volatilityRegime === 'HIGH'
        ) {
          sizingMultiplier = mult;
        }
      }

      // 4. EXIT Candidate Type
      if (candidate.type === 'EXIT') {
        // Handled below during trade trajectory execution
      }

      // 5. POSITION_SIZE Candidate Type
      if (candidate.type === 'POSITION_SIZE') {
        const mult = (candidate.change.sizingMultiplier as number) || (candidate.change.value as number) || 1.0;
        sizingMultiplier = mult;
      }

      // 6. REGIME Candidate Type
      if (candidate.type === 'REGIME') {
        const filterRegime = (candidate.change.filterRegime as string) || (candidate.change.value as string);
        if (filterRegime && exp.marketContext.regime === filterRegime) {
          isTradeRejectedByCandidate = true;
        }
      }

      // 7. MODEL & FEATURE Candidate Types
      if (candidate.type === 'MODEL' || candidate.type === 'FEATURE') {
        const minProb = (candidate.change.minProbability as number) || (candidate.change.value as number) || 0.55;
        if (exp.prediction?.probabilityWin !== undefined && exp.prediction.probabilityWin < minProb) {
          isTradeRejectedByCandidate = true;
        }
      }

      if (!isTradeRejectedByCandidate) {
        // Execute trade trajectory replay using historical market candles or exact price boundaries
        let realizedR = exp.outcome.pnlR;

        const candles = (exp as any).candlesDuringTrade as Array<{ open: number; high: number; low: number; close: number; time: number }>;
        const entryPrice = exp.execution?.entryPrice || 100;
        const initialStop = exp.risk?.stopLoss || (entryPrice * 0.99);
        const riskDist = Math.abs(entryPrice - initialStop);

        if (candidate.type === 'EXIT' && candidate.change.parameter === 'stopLossAtrMultiplier') {
          const slMult = (candidate.change.value as number) || 1.25;
          const adjustedStopDist = riskDist * slMult;
          // Re-evaluate stop distance impact on trade execution
          if (exp.outcome.status === 'LOSS') {
            const maxLossDist = exp.outcome.maxAdverseExcursion || riskDist;
            realizedR = maxLossDist <= adjustedStopDist ? exp.outcome.pnlR : -1.0;
          }
        } else if (candidate.type === 'EXIT' && candidate.change.parameter === 'enablePartialTp1Trailing') {
          if (exp.outcome.maxFavorableExcursion >= 1.5) {
            // Lock in partial TP1 (0.5 pos at 1.5R, breakeven remainder)
            realizedR = Math.max(0.75, exp.outcome.pnlR * 0.5 + 0.75);
          }
        } else if (candles && candles.length > 0 && riskDist > 0) {
          // Replay trade through candle sequence for candidate strategy rules
          const isBuy = exp.decision?.action === 'BUY' || entryPrice > initialStop;
          const target1 = exp.risk?.target1 || (isBuy ? entryPrice + 1.5 * riskDist : entryPrice - 1.5 * riskDist);
          let stopped = false;
          let hitTp1 = false;

          for (const c of candles) {
            const low = c.low;
            const high = c.high;
            if (isBuy ? low <= initialStop : high >= initialStop) {
              stopped = true;
              realizedR = -1.0;
              break;
            }
            if (isBuy ? high >= target1 : low <= target1) {
              hitTp1 = true;
              realizedR = 1.5;
            }
          }
          if (!stopped && !hitTp1) {
            realizedR = exp.outcome.pnlR;
          }
        }

        const adjustedR = Number((realizedR * sizingMultiplier - costPerTradeR).toFixed(4));
        const adjustedPnL = Number((exp.outcome.pnl * sizingMultiplier).toFixed(2));
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
