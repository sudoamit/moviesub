import { ICandle, IBacktestTrade } from '@quant/shared';
import { CandidateArtifact, CandidateMarketDataset, StrategyCandidate, TradingExperience, CandidateRiskConfig } from './types';
import { CandidateBacktestRunner } from './candidate-backtest-runner';

export interface ICandidateEvaluationCriteria {
  minExpectancyDelta?: number;
  minProfitFactor?: number;
  minCandidateExpectancy?: number;
  minTrades?: number;
  maxDrawdownPercent?: number;
}

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
  riskConfig?: CandidateRiskConfig | Record<string, unknown>;
  criteria?: ICandidateEvaluationCriteria;
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
   * Requires explicit riskConfig and symbol.
   */
  public static createBaselineBenchmarkCandidate(
    baseStrategyVersion: string,
    symbol: string,
    riskConfigParam: CandidateRiskConfig | Record<string, unknown>,
    executionConfigParam?: any,
  ): StrategyCandidate {
    if (!symbol || typeof symbol !== 'string' || symbol.trim() === '') {
      throw new Error('MISSING_SYMBOL: createBaselineBenchmarkCandidate requires explicit non-empty symbol');
    }
    if (!riskConfigParam || typeof riskConfigParam !== 'object') {
      throw new Error('MISSING_RISK_CONFIG: createBaselineBenchmarkCandidate requires explicit riskConfig');
    }
    const initialCapital = (riskConfigParam as any).initialCapital;
    if (typeof initialCapital !== 'number' || !Number.isFinite(initialCapital) || initialCapital <= 0) {
      throw new Error('INVALID_CANDIDATE_RISK_CONFIG: createBaselineBenchmarkCandidate riskConfig initialCapital must be a positive finite number');
    }
    const maxRiskPerTrade = (riskConfigParam as any).maxRiskPerTrade;
    if (typeof maxRiskPerTrade !== 'number' || !Number.isFinite(maxRiskPerTrade) || maxRiskPerTrade <= 0) {
      throw new Error('INVALID_CANDIDATE_RISK_CONFIG: createBaselineBenchmarkCandidate riskConfig maxRiskPerTrade must be a positive finite number');
    }
    const partialExitPolicy = (riskConfigParam as any).partialExitPolicy;
    if (!partialExitPolicy || typeof partialExitPolicy !== 'object') {
      throw new Error('INVALID_CANDIDATE_RISK_CONFIG: createBaselineBenchmarkCandidate riskConfig requires valid partialExitPolicy');
    }

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
      riskConfig: riskConfigParam as any,
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
        riskConfig: riskConfigParam,
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
    options?: ICandidateEvaluationOptions,
  ): ICandidateEvaluationResult {
    const candidateId = 'artifactId' in candidate ? candidate.candidateId : candidate.id;
    const dataset = Array.isArray(marketData) ? undefined : marketData.dataset;
    const candles = Array.isArray(marketData) ? marketData : (marketData.candles || dataset?.executionCandles || []);
    const evaluationStartTimestamp = !Array.isArray(marketData) ? marketData.evaluationStartTimestamp : options?.evaluationStartTimestamp;
    const evaluationEndTimestamp = !Array.isArray(marketData) ? marketData.evaluationEndTimestamp : options?.evaluationEndTimestamp;

    // Strict minimumCandles requirement (FAIL CLOSED)
    const minimumCandles = options?.minimumCandles;
    if (typeof minimumCandles !== 'number' || !Number.isFinite(minimumCandles) || minimumCandles <= 0) {
      throw new Error('MISSING_MINIMUM_CANDLES: CandidateEvaluator requires explicit positive minimumCandles in evaluation options');
    }

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

    // Strict symbol requirement (FAIL CLOSED - zero BTC default)
    const resolvedSymbol =
      options?.symbol ||
      dataset?.symbol ||
      (candidate as any).symbol ||
      (candidate as any).change?.symbol ||
      (candidate as any).provenance?.symbol ||
      (candidate as any).strategyConfig?.symbol;

    if (!resolvedSymbol || typeof resolvedSymbol !== 'string' || resolvedSymbol.trim() === '') {
      throw new Error(`MISSING_SYMBOL: Candidate '${candidateId}' is missing authoritative instrument symbol`);
    }

    // Strict riskConfig requirement (FAIL CLOSED - zero defaultRisk)
    const rawRisk =
      options?.riskConfig ||
      (candidate as any).riskConfig ||
      (candidate as any).change?.riskConfig ||
      (candidate as any).provenance?.riskConfig ||
      (candidate as any).strategyConfig?.riskConfig;

    if (!rawRisk || typeof rawRisk !== 'object') {
      throw new Error(`MISSING_RISK_CONFIG: Candidate '${candidateId}' is missing authoritative riskConfig`);
    }

    const initialCapital = (rawRisk as any).initialCapital;
    if (typeof initialCapital !== 'number' || !Number.isFinite(initialCapital) || initialCapital <= 0) {
      throw new Error(`INVALID_CANDIDATE_RISK_CONFIG: Candidate '${candidateId}' riskConfig initialCapital must be a positive finite number`);
    }

    const maxRiskPerTrade = (rawRisk as any).maxRiskPerTrade;
    if (typeof maxRiskPerTrade !== 'number' || !Number.isFinite(maxRiskPerTrade) || maxRiskPerTrade <= 0) {
      throw new Error(`INVALID_CANDIDATE_RISK_CONFIG: Candidate '${candidateId}' riskConfig maxRiskPerTrade must be a positive finite number`);
    }

    const partialExitPolicy = (rawRisk as any).partialExitPolicy;
    if (!partialExitPolicy || typeof partialExitPolicy !== 'object') {
      throw new Error(`INVALID_CANDIDATE_RISK_CONFIG: Candidate '${candidateId}' riskConfig requires a valid partialExitPolicy`);
    }

    const resolvedRisk = rawRisk;

    const baselineCandidate = options?.baselineCandidate;
    const criteria = options?.criteria;

    let baselineExpectancy = 0;
    let baselineTrades = 0;

    if (baselineCandidate) {
      // 1. Evaluate baseline strategy benchmark on authoritative BacktestSimulator using continuous market candles
      const baselineRes = CandidateBacktestRunner.runCandidateBacktest(baselineCandidate, {
        dataset,
        candles,
        evaluationStartTimestamp,
        evaluationEndTimestamp,
        minimumCandles: options?.minimumCandles,
        warmupBars: options?.warmupBars,
        symbol: resolvedSymbol,
        timeframe: options?.timeframe,
        riskConfig: (baselineCandidate as any).riskConfig || resolvedRisk,
      });
      baselineExpectancy = baselineRes.expectancyR;
      baselineTrades = baselineRes.totalTrades;
    }

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

    const candidateExpectancy = backtestRes.expectancyR;
    const expectancyDelta = Number((candidateExpectancy - baselineExpectancy).toFixed(2));
    const profitFactor = backtestRes.profitFactor;
    const maxDrawdownPercent = backtestRes.maxDrawdownR;

    let passed: boolean;
    let rejectionReason: string | undefined;

    if (criteria) {
      const minExpectancyDelta = criteria.minExpectancyDelta ?? 0.0;
      const minProfitFactor = criteria.minProfitFactor ?? 1.0;
      const minCandidateExpectancy = criteria.minCandidateExpectancy ?? 0.0;
      const minTrades = criteria.minTrades ?? 1;

      passed =
        expectancyDelta >= minExpectancyDelta &&
        (profitFactor === Infinity || profitFactor >= minProfitFactor) &&
        candidateExpectancy >= minCandidateExpectancy &&
        backtestRes.totalTrades >= minTrades;

      if (!passed) {
        if (backtestRes.totalTrades < minTrades) {
          rejectionReason = `Candidate generated ${backtestRes.totalTrades} trades in backtest execution simulation (min required: ${minTrades}).`;
        } else {
          rejectionReason = `Candidate did not meet criteria (Delta: ${expectancyDelta}R vs min ${minExpectancyDelta}R, Profit Factor: ${profitFactor} vs min ${minProfitFactor}, Expectancy: ${candidateExpectancy}R vs min ${minCandidateExpectancy}R, Trades: ${backtestRes.totalTrades} vs min ${minTrades}).`;
        }
      }
    } else {
      passed = backtestRes.totalTrades > 0 && candidateExpectancy > 0 && profitFactor >= 1.0;
      if (!passed) {
        if (backtestRes.totalTrades === 0) {
          rejectionReason = 'Candidate generated zero trades in backtest execution simulation.';
        } else {
          rejectionReason = `Candidate did not meet default profitability thresholds (Expectancy: ${candidateExpectancy}R, Profit Factor: ${profitFactor}).`;
        }
      }
    }

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
      baselineTrades,
    };
  }

  /**
   * Orchestrates candidate strategy evaluation against a formal baseline strategy benchmark
   * using continuous market candles and authoritative execution engine (BacktestSimulator).
   *
   * Pure Market-Data Execution: Accepts exclusively (candidate, options: ICandidateEvaluationOptions).
   * Requires explicit baselineCandidate and criteria (FAIL CLOSED).
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

    if (!opts.baselineCandidate) {
      throw new Error('MISSING_BASELINE_CANDIDATE: CandidateEvaluator requires an explicit baselineCandidate for comparative benchmark evaluation');
    }

    if (!opts.criteria || typeof opts.criteria !== 'object') {
      throw new Error('MISSING_EVALUATION_CRITERIA: CandidateEvaluator requires explicit validation/acceptance criteria in options.criteria');
    }

    return this.evaluateCandidateOnMarketData(
      candidate,
      { dataset: marketDataset, candles },
      opts,
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

    const fixtureRisk = (candidate as any).riskConfig || {
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
    const fixtureSymbol = options?.symbol || (candidate as any).symbol || 'BTCUSDT';
    const baselineCandidate =
      options?.baselineCandidate ||
      this.createBaselineBenchmarkCandidate(baseStrategyVersion, fixtureSymbol, fixtureRisk);
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
