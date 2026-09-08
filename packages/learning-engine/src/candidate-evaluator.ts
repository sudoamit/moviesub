import { StrategyCandidate, TradingExperience } from './types';
import { CandidateBacktestRunner } from './candidate-backtest-runner';

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
   * Orchestrates candidate strategy evaluation against historical trading experiences
   * by delegating replay directly to CandidateBacktestRunner and authoritative backtest execution.
   */
  public static evaluate(
    candidate: StrategyCandidate,
    experiences: TradingExperience[],
    costPerTradeR = 0.05,
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

    // Delegate candidate backtest execution to CandidateBacktestRunner
    const backtestRes = CandidateBacktestRunner.runCandidateBacktest(candidate, experiences);

    if (backtestRes.totalTrades === 0) {
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
        rejectionReason: 'Candidate generated zero trades in backtest execution simulation.',
      };
    }

    const candidateExpectancy = backtestRes.expectancyR;
    const expectancyDelta = Number((candidateExpectancy - baselineExpectancy).toFixed(2));
    const profitFactor = backtestRes.profitFactor;
    const maxDrawdownPercent = backtestRes.maxDrawdownR;

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
      totalSimulatedTrades: backtestRes.totalTrades,
      simulatedRMultiples: backtestRes.rMultiples,
      rejectionReason,
    };
  }
}
