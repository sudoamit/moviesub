import { ICandle } from '@quant/shared';
import { CandidateArtifact, StrategyCandidate, TradingExperience } from './types';
import { CandidateBacktestRunner } from './candidate-backtest-runner';

export interface ICandidateEvaluationOptions {
  baselineCandidate?: StrategyCandidate | CandidateArtifact;
  candles?: ICandle[];
  minimumCandles?: number;
  warmupBars?: number;
  symbol?: string;
  timeframe?: string;
}

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
  baselineTrades?: number;
}

export class CandidateEvaluator {
  /**
   * Constructs a canonical frozen baseline benchmark strategy candidate.
   */
  public static createBaselineBenchmarkCandidate(baseStrategyVersion: string = 'v2.0'): StrategyCandidate {
    return {
      id: `baseline-${baseStrategyVersion}`,
      baseStrategyVersion,
      candidateVersion: `baseline-${baseStrategyVersion}`,
      type: 'BASELINE',
      description: `Baseline Benchmark Strategy (${baseStrategyVersion})`,
      change: {
        action: 'BASELINE_BENCHMARK',
        stopLossAtrMultiplier: 1.0,
        sizingMultiplier: 1.0,
      },
      evidence: { sampleSize: 0, expectancyBefore: 0, expectancyAfterHistorical: 0 },
      status: 'PROMOTED',
      createdAt: new Date(),
    };
  }

  /**
   * Orchestrates candidate strategy evaluation against a formal baseline strategy benchmark
   * using the exact same market candles and authoritative execution engine (BacktestSimulator).
   */
  public static evaluate(
    candidate: StrategyCandidate | CandidateArtifact,
    experiences: TradingExperience[],
    costPerTradeR = 0.05,
    options?: ICandidateEvaluationOptions,
  ): ICandidateEvaluationResult {
    const totalTrades = experiences.length;
    const candidateId = 'artifactId' in candidate ? candidate.candidateId : candidate.id;
    const baseStrategyVersion = 'artifactId' in candidate ? candidate.strategyVersion : candidate.baseStrategyVersion;

    if (totalTrades < 5) {
      return {
        candidateId,
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

    // 1. Evaluate baseline strategy benchmark on authoritative BacktestSimulator using the exact same market candles
    const baselineCandidate = options?.baselineCandidate || this.createBaselineBenchmarkCandidate(baseStrategyVersion);
    const baselineRes = CandidateBacktestRunner.runCandidateBacktest(baselineCandidate, experiences, {
      candles: options?.candles,
      minimumCandles: options?.minimumCandles,
      warmupBars: options?.warmupBars,
      symbol: options?.symbol,
      timeframe: options?.timeframe,
    });

    const baselineExpectancy =
      baselineRes.totalTrades > 0
        ? baselineRes.expectancyR
        : Number((experiences.reduce((sum, e) => sum + (e.outcome?.pnlR ?? 0), 0) / totalTrades).toFixed(2));

    // 2. Evaluate candidate strategy on authoritative BacktestSimulator using the exact same market candles
    const backtestRes = CandidateBacktestRunner.runCandidateBacktest(candidate, experiences, {
      candles: options?.candles,
      minimumCandles: options?.minimumCandles,
      warmupBars: options?.warmupBars,
      symbol: options?.symbol,
      timeframe: options?.timeframe,
    });

    if (backtestRes.totalTrades === 0) {
      return {
        candidateId,
        passed: false,
        baselineExpectancy,
        candidateExpectancy: 0,
        expectancyDelta: -baselineExpectancy,
        profitFactor: 0,
        maxDrawdownPercent: 0,
        totalSimulatedTrades: 0,
        simulatedRMultiples: [],
        rejectionReason: 'Candidate generated zero trades in backtest execution simulation.',
        baselineTrades: baselineRes.totalTrades,
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
      candidateId,
      passed,
      baselineExpectancy,
      candidateExpectancy,
      expectancyDelta,
      profitFactor,
      maxDrawdownPercent,
      totalSimulatedTrades: backtestRes.totalTrades,
      simulatedRMultiples: backtestRes.rMultiples,
      rejectionReason,
      baselineTrades: baselineRes.totalTrades,
    };
  }
}
