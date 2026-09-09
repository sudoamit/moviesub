import { ICandle } from '@quant/shared';
import { CandidateArtifact, CandidateMarketDataset, StrategyCandidate, TradingExperience } from './types';
import { CandidateBacktestRunner } from './candidate-backtest-runner';

export interface ICandidateEvaluationOptions {
  baselineCandidate?: StrategyCandidate | CandidateArtifact;
  dataset?: CandidateMarketDataset;
  marketDataset?: CandidateMarketDataset;
  candles?: ICandle[];
  costPerTradeR?: number;
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
   * Evaluates candidate strategy artifact against baseline benchmark strictly on continuous market data
   * (candles / market dataset) without requiring or consuming any TradingExperience[] set.
   */
  public static evaluateCandidateOnMarketData(
    candidate: StrategyCandidate | CandidateArtifact,
    marketData: { dataset?: CandidateMarketDataset; candles?: ICandle[] } | ICandle[],
    options?: {
      baselineCandidate?: StrategyCandidate | CandidateArtifact;
      costPerTradeR?: number;
      minimumCandles?: number;
      warmupBars?: number;
      symbol?: string;
      timeframe?: string;
    },
  ): ICandidateEvaluationResult {
    const candidateId = 'artifactId' in candidate ? candidate.candidateId : candidate.id;
    const baseStrategyVersion = 'artifactId' in candidate ? candidate.strategyVersion : candidate.baseStrategyVersion;
    const candles = Array.isArray(marketData) ? marketData : marketData.candles;
    const dataset = Array.isArray(marketData) ? undefined : marketData.dataset;

    const minimumCandles = options?.minimumCandles ?? 50;
    if ((!candles || candles.length < minimumCandles) && !dataset) {
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
        rejectionReason: `Insufficient market data for candidate evaluation (requires >= ${minimumCandles} candles).`,
      };
    }

    // 1. Evaluate baseline strategy benchmark on authoritative BacktestSimulator using continuous market candles
    const baselineCandidate = options?.baselineCandidate || this.createBaselineBenchmarkCandidate(baseStrategyVersion);
    const baselineRes = CandidateBacktestRunner.runCandidateBacktest(baselineCandidate, {
      dataset,
      candles,
      minimumCandles: options?.minimumCandles,
      warmupBars: options?.warmupBars,
      symbol: options?.symbol,
      timeframe: options?.timeframe,
    });

    const baselineExpectancy = baselineRes.expectancyR;

    // 2. Evaluate candidate strategy on authoritative BacktestSimulator using continuous market candles
    const backtestRes = CandidateBacktestRunner.runCandidateBacktest(candidate, {
      dataset,
      candles,
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

  /**
   * Orchestrates candidate strategy evaluation against a formal baseline strategy benchmark
   * using continuous market candles and authoritative execution engine (BacktestSimulator).
   *
   * Pure Market-Data Execution: Can be invoked cleanly with (candidate, options) without any
   * TradingExperience[] parameter to guarantee no historical experience or label leakage into execution.
   */
  public static evaluate(
    candidate: StrategyCandidate | CandidateArtifact,
    optionsOrExperiences?: ICandidateEvaluationOptions | TradingExperience[],
    costPerTradeR = 0.05,
    legacyOptions?: ICandidateEvaluationOptions,
  ): ICandidateEvaluationResult {
    const isExperienceArray = Array.isArray(optionsOrExperiences);
    const options: ICandidateEvaluationOptions =
      optionsOrExperiences && !isExperienceArray
        ? optionsOrExperiences
        : {
            ...(legacyOptions || {}),
            costPerTradeR: costPerTradeR ?? legacyOptions?.costPerTradeR ?? 0.05,
          };

    const marketDataset = options.marketDataset || options.dataset;
    const candles = options.candles;

    if (candles || marketDataset) {
      return this.evaluateCandidateOnMarketData(
        candidate,
        { dataset: marketDataset, candles },
        {
          baselineCandidate: options.baselineCandidate,
          costPerTradeR: options.costPerTradeR ?? 0.05,
          minimumCandles: options.minimumCandles,
          warmupBars: options.warmupBars,
          symbol: options.symbol,
          timeframe: options.timeframe,
        },
      );
    }

    const totalTrades = isExperienceArray ? optionsOrExperiences.length : 0;
    const candidateId = 'artifactId' in candidate ? candidate.candidateId : candidate.id;

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

    // Must have market data for execution
    throw new Error('INSUFFICIENT_MARKET_DATA_FOR_CANDIDATE_EXECUTION: Missing market data for backtest execution');
  }

  /**
   * Post-execution supervised label evaluation.
   * Compares execution trades against out-of-sample labels cleanly after strategy execution completes.
   */
  public static evaluateLabels(
    simulatedTrades: Array<{ pnlR?: number; exitTime?: Date; entryTime?: Date }>,
    oosLabels: TradingExperience[],
  ): {
    matchedCount: number;
    labelWinRate: number;
    simulatedWinRate: number;
    directionalAccuracy: number;
  } {
    const wins = oosLabels.filter((e) => e.outcome?.status === 'WIN').length;
    const labelWinRate = oosLabels.length > 0 ? (wins / oosLabels.length) * 100 : 0;
    const simWins = simulatedTrades.filter((t) => (t.pnlR ?? 0) > 0).length;
    const simulatedWinRate = simulatedTrades.length > 0 ? (simWins / simulatedTrades.length) * 100 : 0;

    return {
      matchedCount: Math.min(simulatedTrades.length, oosLabels.length),
      labelWinRate: Number(labelWinRate.toFixed(1)),
      simulatedWinRate: Number(simulatedWinRate.toFixed(1)),
      directionalAccuracy: Number(Math.abs(labelWinRate - simulatedWinRate).toFixed(1)),
    };
  }

  /**
   * TEST-ONLY FIXTURE EVALUATOR:
   * Evaluates candidate and baseline benchmark using explicit deterministic test fixture signals.
   */
  public static evaluateDeterministicTestFixture(
    candidate: StrategyCandidate | CandidateArtifact,
    experiences: TradingExperience[],
    costPerTradeR = 0.05,
    options?: {
      baselineCandidate?: StrategyCandidate | CandidateArtifact;
      candles: ICandle[];
      signals?: any[];
      minimumCandles?: number;
      warmupBars?: number;
      symbol?: string;
      timeframe?: string;
    },
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

    const baselineCandidate = options?.baselineCandidate || this.createBaselineBenchmarkCandidate(baseStrategyVersion);
    const baselineRes = CandidateBacktestRunner.runDeterministicTestFixture(baselineCandidate, {
      candles: options?.candles || [],
      experiences,
      signals: options?.signals,
      minimumCandles: options?.minimumCandles,
      warmupBars: options?.warmupBars,
      symbol: options?.symbol,
      timeframe: options?.timeframe,
    });

    const baselineExpectancy =
      baselineRes.totalTrades > 0
        ? baselineRes.expectancyR
        : Number((experiences.reduce((sum, e) => sum + (e.outcome?.pnlR ?? 0), 0) / totalTrades).toFixed(2));

    const backtestRes = CandidateBacktestRunner.runDeterministicTestFixture(candidate, {
      candles: options?.candles || [],
      experiences,
      signals: options?.signals,
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
