import { ICandle, IBacktestTrade } from '@quant/shared';
import { CandidateArtifact, CandidateMarketDataset, StrategyCandidate, TradingExperience } from './types';
import { CandidateBacktestRunner } from './candidate-backtest-runner';

export interface ICandidateEvaluationOptions {
  baselineCandidate?: StrategyCandidate | CandidateArtifact;
  dataset?: CandidateMarketDataset;
  marketDataset?: CandidateMarketDataset;
  candles?: ICandle[];
  evaluationStartTimestamp?: number;
  evaluationEndTimestamp?: number;
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
  simulatedTrades?: IBacktestTrade[];
  rejectionReason?: string;
  baselineTrades?: number;
}

export class CandidateEvaluator {
  /**
   * Constructs a canonical frozen baseline benchmark strategy candidate.
   */
  public static createBaselineBenchmarkCandidate(
    baseStrategyVersion: string = 'v2.0',
    symbol: string = 'BTCUSDT',
    riskConfigParam?: any,
    executionConfigParam?: any,
  ): StrategyCandidate {
    const riskConfig = {
      initialCapital: (riskConfigParam && typeof riskConfigParam.initialCapital === 'number' && Number.isFinite(riskConfigParam.initialCapital) && riskConfigParam.initialCapital > 0)
        ? riskConfigParam.initialCapital
        : 100000,
      maxRiskPerTrade: (riskConfigParam && typeof riskConfigParam.maxRiskPerTrade === 'number' && Number.isFinite(riskConfigParam.maxRiskPerTrade) && riskConfigParam.maxRiskPerTrade > 0)
        ? riskConfigParam.maxRiskPerTrade
        : 0.01,
      partialExitPolicy: riskConfigParam?.partialExitPolicy || {
        tp1Ratio: 0.33,
        tp2Ratio: 0.33,
        tp3Ratio: 0.34,
        moveStopToBreakevenOnTp1: true,
        trailStopOnTp2: true,
        trailStopOffsetR: 1.0,
      },
    };
    const fillModel = executionConfigParam?.fillModel || 'OHLC_PATH';
    const ambiguityMode = executionConfigParam?.ambiguityMode || 'CONSERVATIVE';
    const latencyMs = typeof executionConfigParam?.latencyMs === 'number' ? executionConfigParam.latencyMs : 50;

    return {
      id: `baseline-${baseStrategyVersion}`,
      baseStrategyVersion,
      candidateVersion: `baseline-${baseStrategyVersion}`,
      type: 'BASELINE',
      description: `Baseline Benchmark Strategy (${baseStrategyVersion})`,
      symbol,
      riskConfig,
      executionConfig: {
        candidateId: `baseline-${baseStrategyVersion}`,
        candidateVersion: `baseline-${baseStrategyVersion}`,
        strategyVersion: baseStrategyVersion,
        symbol,
        fillModel,
        ambiguityMode,
        latencyMs,
        minMtfScore: 0,
        configHash: 'baseline_exec_config',
      },
      change: {
        action: 'BASELINE_BENCHMARK',
        minMtfScore: 0,
        stopLossAtrMultiplier: 1.0,
        sizingMultiplier: 1.0,
        symbol,
        riskConfig,
        fillModel,
        ambiguityMode,
        latencyMs,
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
    marketData: { dataset?: CandidateMarketDataset; candles?: ICandle[]; evaluationStartTimestamp?: number; evaluationEndTimestamp?: number } | ICandle[],
    options?: {
      baselineCandidate?: StrategyCandidate | CandidateArtifact;
      costPerTradeR?: number;
      evaluationStartTimestamp?: number;
      evaluationEndTimestamp?: number;
      minimumCandles?: number;
      warmupBars?: number;
      symbol?: string;
      timeframe?: string;
    },
  ): ICandidateEvaluationResult {
    const candidateId = 'artifactId' in candidate ? candidate.candidateId : candidate.id;
    const dataset = Array.isArray(marketData) ? undefined : marketData.dataset;
    const candles = Array.isArray(marketData) ? marketData : (marketData.candles || dataset?.executionCandles || []);
    const baseStrategyVersion = (candidate as any).baseStrategyVersion || (candidate as any).strategyVersion || 'v2.0';
    const evaluationStartTimestamp = !Array.isArray(marketData) ? marketData.evaluationStartTimestamp : options?.evaluationStartTimestamp;
    const evaluationEndTimestamp = !Array.isArray(marketData) ? marketData.evaluationEndTimestamp : options?.evaluationEndTimestamp;

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
        simulatedTrades: [],
        rejectionReason: `Insufficient market data for candidate evaluation (requires >= ${minimumCandles} candles).`,
      };
    }

    const defaultRisk = {
      initialCapital: 100000,
      maxRiskPerTrade: 0.01,
      partialExitPolicy: {
        tp1Ratio: 0.33,
        tp2Ratio: 0.33,
        tp3Ratio: 0.34,
        moveStopToBreakevenOnTp1: true,
        trailStopOnTp2: true,
        trailStopOffsetR: 1.0,
      },
    };
    const resolvedSymbol =
      options?.symbol ||
      dataset?.symbol ||
      (candidate as any).symbol ||
      (candidate as any).change?.symbol ||
      'BTCUSDT';
    const candRisk = (candidate as any).riskConfig || (candidate as any).change?.riskConfig || {};
    const resolvedRisk = {
      ...defaultRisk,
      ...candRisk,
      initialCapital: (typeof candRisk.initialCapital === 'number' && Number.isFinite(candRisk.initialCapital) && candRisk.initialCapital > 0)
        ? candRisk.initialCapital
        : defaultRisk.initialCapital,
    };

    // 1. Evaluate baseline strategy benchmark on authoritative BacktestSimulator using continuous market candles
    const baselineCandidate =
      options?.baselineCandidate ||
      this.createBaselineBenchmarkCandidate(
        baseStrategyVersion,
        resolvedSymbol,
        resolvedRisk,
        (candidate as any).executionConfig,
      );
    const baselineRes = CandidateBacktestRunner.runCandidateBacktest(baselineCandidate, {
      dataset,
      candles,
      evaluationStartTimestamp,
      evaluationEndTimestamp,
      minimumCandles: options?.minimumCandles,
      warmupBars: options?.warmupBars,
      symbol: resolvedSymbol,
      timeframe: options?.timeframe,
      riskConfig: (baselineCandidate as any).riskConfig || defaultRisk,
    });

    const baselineExpectancy = baselineRes.expectancyR;

    // 2. Evaluate candidate strategy on authoritative BacktestSimulator using continuous market candles
    const backtestRes = CandidateBacktestRunner.runCandidateBacktest(candidate, {
      dataset,
      candles,
      evaluationStartTimestamp,
      evaluationEndTimestamp,
      minimumCandles: options?.minimumCandles,
      warmupBars: options?.warmupBars,
      symbol: resolvedSymbol,
      timeframe: options?.timeframe,
      riskConfig: resolvedRisk,
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
        simulatedTrades: [],
        rejectionReason: 'Candidate generated zero trades in backtest execution simulation.',
        baselineTrades: baselineRes.totalTrades,
      };
    }

    const candidateExpectancy = backtestRes.expectancyR;
    const expectancyDelta = Number((candidateExpectancy - baselineExpectancy).toFixed(2));
    const profitFactor = backtestRes.profitFactor;
    const maxDrawdownPercent = backtestRes.maxDrawdownR;

    const passed = expectancyDelta > 0.02 && (profitFactor === Infinity || profitFactor >= 1.25) && candidateExpectancy > 0;
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
      simulatedTrades: backtestRes.trades,
      rejectionReason,
      baselineTrades: baselineRes.totalTrades,
    };
  }

  /**
   * Orchestrates candidate strategy evaluation against a formal baseline strategy benchmark
   * using continuous market candles and authoritative execution engine (BacktestSimulator).
   *
   * Pure Market-Data Execution: Accepts exclusively (candidate, options: ICandidateEvaluationOptions).
   * For test fixtures using deterministic historical experiences, use evaluateDeterministicTestFixture().
   */
  public static evaluate(
    candidate: StrategyCandidate | CandidateArtifact,
    options?: ICandidateEvaluationOptions,
  ): ICandidateEvaluationResult {
    const opts = options || {};
    const marketDataset = opts.marketDataset || opts.dataset;
    const candles = opts.candles;

    if (!candles && !marketDataset) {
      throw new Error('INSUFFICIENT_MARKET_DATA_FOR_CANDIDATE_EXECUTION: Missing market data for backtest execution');
    }

    return this.evaluateCandidateOnMarketData(
      candidate,
      { dataset: marketDataset, candles },
      {
        baselineCandidate: opts.baselineCandidate,
        costPerTradeR: opts.costPerTradeR ?? 0.05,
        evaluationStartTimestamp: opts.evaluationStartTimestamp,
        evaluationEndTimestamp: opts.evaluationEndTimestamp,
        minimumCandles: opts.minimumCandles,
        warmupBars: opts.warmupBars,
        symbol: opts.symbol,
        timeframe: opts.timeframe,
      },
    );
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
