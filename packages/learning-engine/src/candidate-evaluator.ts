import * as crypto from 'crypto';
import { ICandle, IBacktestTrade } from '@quant/shared';
import { CandidateArtifact, CandidateMarketDataset, StrategyCandidate, TradingExperience, CandidateRiskConfig, CandidateExecutionConfig, ICandidateMeasurementOptions, CandidateMeasurementResult } from './types';
import { CandidateBacktestRunner } from './candidate-backtest-runner';
import { canonicalJsonStringify } from './canonical-serializer';

export interface ICandidateEvaluationCriteria {
  minExpectancyDelta?: number;
  minProfitFactor?: number;
  minCandidateExpectancy?: number;
  minTrades?: number;
  maxDrawdownPercent?: number;
}

export interface ICandidateEvaluationOptions extends ICandidateMeasurementOptions {
  criteria?: ICandidateEvaluationCriteria;
}

export interface ICandidateEvaluationResult extends CandidateMeasurementResult {
  passed: boolean;
  rejectionReason?: string;
}

export class CandidateEvaluator {
  /**
   * Constructs a canonical frozen baseline benchmark strategy candidate.
   * Requires explicit riskConfig, executionConfig, and symbol.
   */
  public static createBaselineBenchmarkCandidate(
    baseStrategyVersion: string,
    symbol: string,
    riskConfigParam: CandidateRiskConfig | Record<string, unknown>,
    executionConfigParam: CandidateExecutionConfig | Record<string, unknown>,
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

    if (!executionConfigParam || typeof executionConfigParam !== 'object') {
      throw new Error('MISSING_EXECUTION_CONFIG: createBaselineBenchmarkCandidate requires explicit executionConfig');
    }

    const fillModel = (executionConfigParam as any).fillModel;
    if (!fillModel || typeof fillModel !== 'string' || fillModel.trim() === '') {
      throw new Error('MISSING_FILL_MODEL: createBaselineBenchmarkCandidate requires explicit fillModel');
    }
    const ambiguityMode = (executionConfigParam as any).ambiguityMode;
    if (!ambiguityMode || typeof ambiguityMode !== 'string' || ambiguityMode.trim() === '') {
      throw new Error('MISSING_AMBIGUITY_MODE: createBaselineBenchmarkCandidate requires explicit ambiguityMode');
    }
    const latencyMs = (executionConfigParam as any).latencyMs;
    if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs < 0) {
      throw new Error('INVALID_LATENCY_MS: createBaselineBenchmarkCandidate requires explicit non-negative latencyMs');
    }

    const minMtfScore = (executionConfigParam as any).minMtfScore;
    if (typeof minMtfScore !== 'number' || !Number.isFinite(minMtfScore)) {
      throw new Error('MISSING_MIN_MTF_SCORE: createBaselineBenchmarkCandidate requires explicit minMtfScore');
    }
    const stopLossAtrMultiplier = (executionConfigParam as any).stopLossAtrMultiplier;
    if (typeof stopLossAtrMultiplier !== 'number' || !Number.isFinite(stopLossAtrMultiplier) || stopLossAtrMultiplier <= 0) {
      throw new Error('MISSING_STOP_LOSS_ATR_MULTIPLIER: createBaselineBenchmarkCandidate requires explicit positive stopLossAtrMultiplier');
    }
    const sizingMultiplier = (executionConfigParam as any).sizingMultiplier;
    if (typeof sizingMultiplier !== 'number' || !Number.isFinite(sizingMultiplier) || sizingMultiplier <= 0) {
      throw new Error('MISSING_SIZING_MULTIPLIER: createBaselineBenchmarkCandidate requires explicit positive sizingMultiplier');
    }

    const execPayload = {
      strategyVersion: baseStrategyVersion,
      symbol,
      fillModel,
      ambiguityMode,
      latencyMs,
      minMtfScore,
      stopLossAtrMultiplier,
      sizingMultiplier,
    };
    const configHash = crypto.createHash('sha256').update(canonicalJsonStringify(execPayload)).digest('hex').substring(0, 16);

    const riskConfig = riskConfigParam as CandidateRiskConfig;
    const id = `cand_baseline_${baseStrategyVersion}_${configHash}`;
    const candidateVersion = `baseline_${baseStrategyVersion}`;
    const executionConfig: CandidateExecutionConfig = {
      candidateId: id,
      candidateVersion,
      strategyVersion: baseStrategyVersion,
      symbol,
      fillModel: fillModel as any,
      ambiguityMode: ambiguityMode as any,
      latencyMs,
      minMtfScore,
      stopLossAtrMultiplier,
      sizingMultiplier,
      configHash,
    };

    return {
      id,
      baseStrategyVersion,
      candidateVersion,
      symbol,
      type: 'BASELINE',
      description: `Baseline benchmark candidate for strategy ${baseStrategyVersion}`,
      change: {
        symbol,
        minMtfScore,
        stopLossAtrMultiplier,
        sizingMultiplier,
        fillModel,
        ambiguityMode,
        latencyMs,
      },
      evidence: {
        sampleSize: 0,
        expectancyBefore: 0,
        expectancyAfterHistorical: 0,
      },
      riskConfig,
      executionConfig,
      status: 'PROMOTED',
      createdAt: new Date(),
    };
  }

  /**
   * Performs pure performance measurement of a candidate strategy against market candles
   * without applying acceptance gates or criteria checks.
   */
  public static measureCandidateOnMarketData(
    candidate: StrategyCandidate | CandidateArtifact,
    marketData: { dataset?: CandidateMarketDataset; candles?: ICandle[]; evaluationStartTimestamp?: number; evaluationEndTimestamp?: number } | ICandle[],
    options?: ICandidateMeasurementOptions,
  ): CandidateMeasurementResult {
    const candidateId = 'candidateId' in candidate ? candidate.candidateId : candidate.id;
    let dataset: CandidateMarketDataset | undefined;
    let candles: ICandle[] | undefined;
    let evaluationStartTimestamp: number | undefined;
    let evaluationEndTimestamp: number | undefined;

    if (Array.isArray(marketData)) {
      candles = marketData;
    } else if (marketData && typeof marketData === 'object') {
      dataset = marketData.dataset;
      candles = marketData.candles;
      evaluationStartTimestamp = marketData.evaluationStartTimestamp;
      evaluationEndTimestamp = marketData.evaluationEndTimestamp;
    }

    if ((!candles || candles.length === 0) && (!dataset || !dataset.executionCandles || dataset.executionCandles.length === 0)) {
      throw new Error(`MISSING_MARKET_DATA: Candidate '${candidateId}' requires continuous market candles or dataset for execution evaluation`);
    }

    // Strict symbol requirement (FAIL CLOSED)
    const resolvedSymbol =
      options?.symbol ||
      dataset?.symbol ||
      (candidate as any).symbol ||
      (candidate as any).change?.symbol ||
      (candidate as any).executionConfig?.symbol;

    if (!resolvedSymbol || typeof resolvedSymbol !== 'string' || resolvedSymbol.trim() === '') {
      throw new Error(`MISSING_SYMBOL: Candidate '${candidateId}' is missing authoritative trading symbol in evaluation`);
    }

    // Strict candidate riskConfig requirement (FAIL CLOSED)
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
        feeConfig: options?.feeConfig,
        slippageConfig: options?.slippageConfig,
        spreadConfig: options?.spreadConfig,
        latencyConfig: options?.latencyConfig,
        feeRate: options?.feeRate,
        slippageBps: options?.slippageBps,
        costStressConfig: options?.costStressConfig,
        productionExecutionContext: options?.productionExecutionContext,
        executionContext: options?.executionContext,
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
      feeConfig: options?.feeConfig,
      slippageConfig: options?.slippageConfig,
      spreadConfig: options?.spreadConfig,
      latencyConfig: options?.latencyConfig,
      feeRate: options?.feeRate,
      slippageBps: options?.slippageBps,
      costStressConfig: options?.costStressConfig,
      productionExecutionContext: options?.productionExecutionContext,
      executionContext: options?.executionContext,
      riskConfig: resolvedRisk,
    });

    const candidateExpectancy = backtestRes.expectancyR;
    const expectancyDelta = Number((candidateExpectancy - baselineExpectancy).toFixed(2));
    const profitFactor = backtestRes.profitFactor;
    const maxDrawdownPercent = backtestRes.maxDrawdownR;

    return {
      candidateId,
      baselineExpectancy,
      candidateExpectancy,
      expectancyDelta,
      profitFactor,
      maxDrawdownPercent,
      totalSimulatedTrades: backtestRes.totalTrades,
      simulatedRMultiples: backtestRes.rMultiples,
      simulatedTrades: backtestRes.trades,
      baselineTrades,
    };
  }

  /**
   * Evaluates candidate strategy artifact against baseline benchmark strictly on continuous market data
   * (candles / market dataset) and applies explicit acceptance criteria (acceptance gate).
   */
  public static evaluateCandidateOnMarketData(
    candidate: StrategyCandidate | CandidateArtifact,
    marketData: { dataset?: CandidateMarketDataset; candles?: ICandle[]; evaluationStartTimestamp?: number; evaluationEndTimestamp?: number } | ICandle[],
    options?: ICandidateEvaluationOptions,
  ): ICandidateEvaluationResult {
    // Strict evaluation criteria requirement (FAIL CLOSED)
    const criteria = options?.criteria;
    if (!criteria || typeof criteria !== 'object') {
      throw new Error('MISSING_EVALUATION_CRITERIA: CandidateEvaluator requires explicit validation/acceptance criteria in options.criteria');
    }

    if (criteria.minExpectancyDelta === undefined || typeof criteria.minExpectancyDelta !== 'number' || !Number.isFinite(criteria.minExpectancyDelta)) {
      throw new Error('MISSING_EVALUATION_CRITERIA_FIELD: criteria.minExpectancyDelta must be an explicit finite number');
    }
    if (criteria.minProfitFactor === undefined || typeof criteria.minProfitFactor !== 'number' || !Number.isFinite(criteria.minProfitFactor)) {
      throw new Error('MISSING_EVALUATION_CRITERIA_FIELD: criteria.minProfitFactor must be an explicit finite number');
    }
    if (criteria.minCandidateExpectancy === undefined || typeof criteria.minCandidateExpectancy !== 'number' || !Number.isFinite(criteria.minCandidateExpectancy)) {
      throw new Error('MISSING_EVALUATION_CRITERIA_FIELD: criteria.minCandidateExpectancy must be an explicit finite number');
    }
    if (criteria.minTrades === undefined || typeof criteria.minTrades !== 'number' || !Number.isFinite(criteria.minTrades)) {
      throw new Error('MISSING_EVALUATION_CRITERIA_FIELD: criteria.minTrades must be an explicit finite number');
    }

    const measurement = this.measureCandidateOnMarketData(candidate, marketData, options);

    const minExpectancyDelta = criteria.minExpectancyDelta;
    const minProfitFactor = criteria.minProfitFactor;
    const minCandidateExpectancy = criteria.minCandidateExpectancy;
    const minTrades = criteria.minTrades;

    const passed =
      measurement.expectancyDelta >= minExpectancyDelta &&
      (measurement.profitFactor === Infinity || measurement.profitFactor >= minProfitFactor) &&
      measurement.candidateExpectancy >= minCandidateExpectancy &&
      measurement.totalSimulatedTrades >= minTrades;

    const rejectionReason = !passed
      ? measurement.totalSimulatedTrades < minTrades
        ? `Candidate generated ${measurement.totalSimulatedTrades} trades in backtest execution simulation (min required: ${minTrades}).`
        : `Candidate did not meet criteria (Delta: ${measurement.expectancyDelta}R vs min ${minExpectancyDelta}R, Profit Factor: ${measurement.profitFactor} vs min ${minProfitFactor}, Expectancy: ${measurement.candidateExpectancy}R vs min ${minCandidateExpectancy}R, Trades: ${measurement.totalSimulatedTrades} vs min ${minTrades}).`
      : undefined;

    return {
      ...measurement,
      passed,
      rejectionReason,
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

    const minimumCandles = opts.minimumCandles;
    if (typeof minimumCandles !== 'number' || !Number.isFinite(minimumCandles) || minimumCandles <= 0) {
      throw new Error('MISSING_MINIMUM_CANDLES: CandidateEvaluator requires explicit positive minimumCandles in evaluation options');
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
    _fixtureCostR = 0.05,
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
    const fixtureExec = (candidate as any).executionConfig || {
      fillModel: 'OHLC_PATH',
      ambiguityMode: 'CONSERVATIVE',
      latencyMs: 50,
      minMtfScore: 0.5,
      stopLossAtrMultiplier: 1.5,
      sizingMultiplier: 1.0,
    };
    const fixtureSymbol = options?.symbol || (candidate as any).symbol || (candidate as any).executionConfig?.symbol;
    if (!fixtureSymbol || typeof fixtureSymbol !== 'string' || fixtureSymbol.trim() === '') {
      const candId = (candidate as any).id || (candidate as any).candidateId || 'unknown';
      throw new Error(`MISSING_SYMBOL: Candidate '${candId}' is missing authoritative trading symbol`);
    }
    const baselineCandidate =
      options?.baselineCandidate ||
      this.createBaselineBenchmarkCandidate(baseStrategyVersion, fixtureSymbol, fixtureRisk, fixtureExec);
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
