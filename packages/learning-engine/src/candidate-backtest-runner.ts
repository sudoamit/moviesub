import { ICandle, IBacktestTrade } from '@quant/shared';
import { BacktestSimulator, IBacktestOptions } from '@quant/backtesting';
import {
  CandidateArtifact,
  CandidateExecutionConfig,
  CandidateMarketDataset,
  CandidateRiskConfig,
  StrategyCandidate,
  TradingExperience,
  ValidatedCandidateArtifact,
} from './types';
import { DEFAULT_LEARNING_SEED } from './walk-forward-validator';
import { DatasetManager } from './dataset-manager';
import { CandidateArtifactValidator } from './candidate-artifact-validator';
import { CandidateArtifactBuilder, CandidateArtifactBuildOptions } from './candidate-artifact-builder';
import { DeterministicTestStrategyAdapter } from './deterministic-test-adapter';

export { CandidateExecutionConfig };

export interface CandidateExecutionResult {
  candidateId: string;
  totalTrades: number;
  trades: IBacktestTrade[];
  rMultiples: number[];
  netPnL: number;
  grossProfit: number;
  grossLoss: number;
  winRate: number;
  expectancyR: number;
  profitFactor: number;
  maxDrawdownR: number;
}

export interface ICandidateBacktestOptions {
  dataset?: CandidateMarketDataset;
  marketDataset?: CandidateMarketDataset;
  candles?: ICandle[];
  evaluationStartTimestamp?: number;
  evaluationEndTimestamp?: number;
  minimumCandles?: number;
  warmupBars?: number;
  symbol?: string;
  timeframe?: string;
  initialCapital?: number;
  riskConfig?: CandidateRiskConfig | Record<string, unknown>;
  provenance?: {
    trainingDatasetHash?: string;
    validationDatasetHash?: string;
    oosDatasetHash?: string;
    marketDatasetHash?: string;
    createdBy?: string;
    symbol?: string;
    riskConfig?: CandidateRiskConfig | Record<string, unknown>;
  };
}

export interface IDeterministicTestFixtureOptions {
  candles: ICandle[];
  dataset?: CandidateMarketDataset;
  marketDataset?: CandidateMarketDataset;
  experiences?: TradingExperience[];
  signals?: any[];
  minimumCandles?: number;
  warmupBars?: number;
  symbol?: string;
  timeframe?: string;
  initialCapital?: number;
}

export const PRODUCTION_DEFAULT_MINIMUM_CANDLES = 50;
export const PRODUCTION_DEFAULT_WARMUP_BARS = 40;

export class CandidateBacktestRunner {
  public static readonly PRODUCTION_DEFAULT_MINIMUM_CANDLES = PRODUCTION_DEFAULT_MINIMUM_CANDLES;
  public static readonly PRODUCTION_DEFAULT_WARMUP_BARS = PRODUCTION_DEFAULT_WARMUP_BARS;

  /**
   * Creates an immutable, reproducible, content-addressable ValidatedCandidateArtifact
   * using the canonical CandidateArtifactBuilder.
   */
  public static createCandidateArtifact(
    candidate: StrategyCandidate,
    datasetHash?: string,
    trainingSeed = DEFAULT_LEARNING_SEED,
    provenance?: {
      trainingDatasetHash?: string;
      validationDatasetHash?: string;
      oosDatasetHash?: string;
      marketDatasetHash?: string;
      createdBy?: string;
      symbol?: string;
      riskConfig?: CandidateRiskConfig | Record<string, unknown>;
    },
  ): ValidatedCandidateArtifact {
    const options: CandidateArtifactBuildOptions = {
      datasetHash,
      trainingSeed,
      provenance,
      symbol: provenance?.symbol || candidate.symbol,
      riskConfig: provenance?.riskConfig || candidate.riskConfig || (candidate.change as any)?.riskConfig,
    };
    return CandidateArtifactBuilder.build(candidate, options);
  }

  /**
   * Validates that an artifact has not been tampered with and that all internal cryptographic hashes match.
   */
  public static validateArtifactIntegrity(
    artifact: unknown,
  ): { isValid: boolean; reason?: string } {
    try {
      CandidateArtifactValidator.validate(artifact);
      return { isValid: true };
    } catch (err: any) {
      return { isValid: false, reason: err.message || 'ARTIFACT_VALIDATION_FAILED' };
    }
  }

  /**
   * Converts a StrategyCandidate into an executable strategy configuration object
   * with a canonical SHA-256 configuration hash.
   */
  public static createExecutionConfig(
    candidate: StrategyCandidate,
    options?: CandidateArtifactBuildOptions,
  ): CandidateExecutionConfig {
    return CandidateArtifactBuilder.createExecutionConfig(candidate, options);
  }

  /**
   * Preflight validation for CandidateArtifact execution configuration.
   * Enforces strict canonical fail-closed requirements before BacktestSimulator is invoked.
   */
  public static validateCandidateExecutionConfig(
    artifactOrCandidate: StrategyCandidate | CandidateArtifact | ValidatedCandidateArtifact,
    options?: ICandidateBacktestOptions,
  ): void {
    if (!artifactOrCandidate || typeof artifactOrCandidate !== 'object') {
      throw new Error('CANDIDATE_CONFIG_INVALID: Candidate or artifact is undefined/null');
    }

    if ('artifactId' in artifactOrCandidate && 'configHash' in artifactOrCandidate) {
      CandidateArtifactValidator.validate(artifactOrCandidate);
      return;
    }

    // Build and validate candidate to enforce canonical boundary
    CandidateArtifactBuilder.build(artifactOrCandidate as StrategyCandidate, {
      datasetHash: options?.marketDataset?.datasetHash || options?.dataset?.datasetHash,
      symbol: options?.symbol || options?.marketDataset?.symbol || options?.dataset?.symbol,
      riskConfig: options?.riskConfig,
      provenance: options?.provenance,
    });
  }

  /**
   * Replays candidate execution strictly through the authoritative BacktestSimulator engine
   * using continuous market candles and the immutable ValidatedCandidateArtifact as the single source of truth.
   *
   * PRODUCTION EXECUTION: Always evaluates candidates via SignalGenerator continuous replay.
   * Strictly requires continuous market data (CandidateMarketDataset | ICandle[]).
   */
  public static runCandidateBacktest(
    candidateOrArtifact: StrategyCandidate | CandidateArtifact | ValidatedCandidateArtifact,
    options: ICandidateBacktestOptions,
  ): CandidateExecutionResult;
  public static runCandidateBacktest(
    candidateOrArtifact: StrategyCandidate | CandidateArtifact | ValidatedCandidateArtifact,
    legacyExperiences: TradingExperience[],
    options?: ICandidateBacktestOptions,
  ): CandidateExecutionResult;
  public static runCandidateBacktest(
    candidateOrArtifact: StrategyCandidate | CandidateArtifact | ValidatedCandidateArtifact,
    optionsOrExperiences?: ICandidateBacktestOptions | TradingExperience[],
    legacyOptions?: ICandidateBacktestOptions,
  ): CandidateExecutionResult {
    let options: ICandidateBacktestOptions;
    if (Array.isArray(optionsOrExperiences)) {
      options = legacyOptions || {};
    } else {
      options = (optionsOrExperiences as ICandidateBacktestOptions) || {};
    }

    const resolvedHash =
      options?.marketDataset?.datasetHash ||
      options?.dataset?.datasetHash ||
      (options?.candles && options.candles.length > 0
        ? DatasetManager.requireCanonicalMarketDatasetHash(
            options.candles,
            options.timeframe || options.marketDataset?.timeframe || options.dataset?.timeframe,
          )
        : undefined);

    // 1. Collect and validate continuous market candles
    const dataset = options?.marketDataset || options?.dataset;
    const candles: ICandle[] = dataset?.executionCandles || options?.candles || [];

    if (!candles || candles.length === 0) {
      throw new Error(
        'INSUFFICIENT_MARKET_DATA_FOR_CANDIDATE_EXECUTION: INSUFFICIENT_CONTINUOUS_MARKET_DATA: Candidate evaluation requires continuous market dataset',
      );
    }

    // 2. Resolve or construct immutable ValidatedCandidateArtifact via canonical boundary
    const artifact: ValidatedCandidateArtifact =
      candidateOrArtifact && 'artifactId' in candidateOrArtifact && 'configHash' in candidateOrArtifact
        ? CandidateArtifactValidator.validate(candidateOrArtifact)
        : CandidateArtifactBuilder.build(candidateOrArtifact as StrategyCandidate, {
            datasetHash: resolvedHash,
            symbol: options?.symbol || options?.marketDataset?.symbol || options?.dataset?.symbol,
            riskConfig: options?.riskConfig,
            provenance: options?.provenance,
          });

    const config = artifact.executionConfig;
    const riskConfig = artifact.riskConfig;
    const candidateId = artifact.candidateId;

    const strategyConfig = {
      ...artifact.strategyConfig,
      scoringWeights: artifact.strategyConfig.scoringWeights,
    };

    // Enforce production backtester warm-up standards (minimumCandles = 50, warmupBars = 40)
    // to preserve SMC swings, BOS, CHOCH, FVG, order blocks, indicators, and MTF context integrity.
    const minimumCandles =
      options?.minimumCandles !== undefined
        ? options.minimumCandles
        : PRODUCTION_DEFAULT_MINIMUM_CANDLES;

    const warmupBars =
      options?.warmupBars !== undefined
        ? options.warmupBars
        : PRODUCTION_DEFAULT_WARMUP_BARS;

    const backtestOptions: IBacktestOptions = {
      runId: `cand_bt_${candidateId}`,
      symbol: options?.symbol || artifact.symbol || 'BTCUSDT',
      timeframe: dataset?.timeframe || options?.timeframe || '15m',
      candles,
      initialCapital: options?.initialCapital ?? riskConfig.initialCapital,
      minimumCandles,
      warmupBars,
      candidateArtifact: artifact,
      minScore: config.minMtfScore,
      stopLossAtrMultiplier: (riskConfig.stopLossAtrMultiplier as number | undefined) ?? config.stopLossAtrMultiplier,
      sizingMultiplier: config.sizingMultiplier,
      highVolatilitySizingMultiplier: config.highVolatilitySizingMultiplier,
      filterRegime: config.filterRegime,
      regimeMode: config.regimeMode,
      minProbability: config.minProbability,
      conditionRules: config.conditionRules,
      enablePartialTp1Trailing: config.enablePartialTp1Trailing,
      scoringWeights: artifact.strategyConfig.scoringWeights,
      strategyConfig,
      modelArtifact: (artifact.modelArtifact as any) || (artifact.strategyConfig as any)?.modelArtifact,
    };

    // Invoke authoritative BacktestSimulator engine directly
    const simResult = BacktestSimulator.runSimulation(backtestOptions);
    const rawTrades = simResult.trades || [];
    const evaluationStartTimestamp = options?.evaluationStartTimestamp;
    const evaluationEndTimestamp = options?.evaluationEndTimestamp;

    // Entry-based evaluation: Filter out any trades whose entry occurred outside the evaluation window
    const trades = rawTrades.filter((t) => {
      const entryTs = t.entryTime instanceof Date ? t.entryTime.getTime() : new Date(t.entryTime).getTime();
      if (evaluationStartTimestamp !== undefined && entryTs < evaluationStartTimestamp) {
        return false;
      }
      if (evaluationEndTimestamp !== undefined && entryTs > evaluationEndTimestamp) {
        return false;
      }
      return true;
    });

    const rMultiples = trades.map((t) => t.pnlRMultiple || 0);
    const winningTrades = trades.filter((t) => t.pnl > 0);
    const losingTrades = trades.filter((t) => t.pnl < 0);
    const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = losingTrades.reduce((sum, t) => sum + Math.abs(t.pnl), 0);
    const totalPnL = trades.reduce((sum, t) => sum + t.pnl, 0);
    const winRate = trades.length > 0 ? (winningTrades.length / trades.length) * 100 : 0;
    const expectancyR = trades.length > 0 ? rMultiples.reduce((sum, r) => sum + r, 0) / trades.length : 0;
    const profitFactor =
      grossLoss === 0
        ? grossProfit > 0
          ? Infinity
          : 0
        : Number((grossProfit / grossLoss).toFixed(2));

    // Calculate evaluation-window drawdown strictly from the evaluation trade ledger (isolating from warmup)
    let peakR = 0;
    let currentR = 0;
    let maxDrawdownR = 0;
    for (const t of trades) {
      currentR += t.pnlRMultiple || 0;
      if (currentR > peakR) {
        peakR = currentR;
      }
      const dd = peakR - currentR;
      if (dd > maxDrawdownR) {
        maxDrawdownR = dd;
      }
    }

    return {
      candidateId,
      totalTrades: trades.length,
      trades,
      rMultiples,
      netPnL: totalPnL,
      grossProfit,
      grossLoss,
      winRate: Number(winRate.toFixed(1)),
      expectancyR: Number(expectancyR.toFixed(2)),
      profitFactor,
      maxDrawdownR: Number(maxDrawdownR.toFixed(2)),
    };
  }

  /**
   * TEST-ONLY FIXTURE RUNNER:
   * Replays candidate execution using explicit deterministic test fixture signals.
   * Strictly decoupled from production ValidatedCandidateArtifact boundaries.
   */
  public static runDeterministicTestFixture(
    candidateOrArtifact: StrategyCandidate | CandidateArtifact | ValidatedCandidateArtifact,
    fixture: IDeterministicTestFixtureOptions,
  ): CandidateExecutionResult {
    return DeterministicTestStrategyAdapter.runTestFixture(candidateOrArtifact, fixture);
  }
}
