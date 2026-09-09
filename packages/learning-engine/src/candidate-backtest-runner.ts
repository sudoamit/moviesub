import { createHash } from 'crypto';
import { ICandle, IBacktestTrade } from '@quant/shared';
import { BacktestSimulator, IBacktestOptions } from '@quant/backtesting';
import { CandidateArtifact, CandidateMarketDataset, StrategyCandidate, TradingExperience } from './types';
import { TemporalFeatureScaler } from './feature-scaler';
import { DEFAULT_LEARNING_SEED } from './walk-forward-validator';

export interface CandidateExecutionConfig {
  candidateId: string;
  candidateVersion: string;
  configHash: string;
  minMtfScore?: number;
  stopLossAtrMultiplier?: number;
  enablePartialTp1Trailing?: boolean;
  highVolatilitySizingMultiplier?: number;
  sizingMultiplier?: number;
  filterRegime?: string;
  regimeMode?: 'INCLUDE' | 'EXCLUDE';
  minProbability?: number;
  conditionRules?: string[];
  fittedValue?: number;
}

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
  candles?: ICandle[];
  minimumCandles?: number;
  warmupBars?: number;
  symbol?: string;
  timeframe?: string;
  initialCapital?: number;
}

export interface IDeterministicTestFixtureOptions {
  candles: ICandle[];
  experiences?: TradingExperience[];
  signals?: any[];
  minimumCandles?: number;
  warmupBars?: number;
  symbol?: string;
  timeframe?: string;
  initialCapital?: number;
}

function deepFreeze<T extends object>(obj: T): Readonly<T> {
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as any)[key];
    if (val !== null && (typeof val === 'object' || typeof val === 'function') && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

export const PRODUCTION_DEFAULT_MINIMUM_CANDLES = 50;
export const PRODUCTION_DEFAULT_WARMUP_BARS = 40;

export class CandidateBacktestRunner {
  public static readonly PRODUCTION_DEFAULT_MINIMUM_CANDLES = PRODUCTION_DEFAULT_MINIMUM_CANDLES;
  public static readonly PRODUCTION_DEFAULT_WARMUP_BARS = PRODUCTION_DEFAULT_WARMUP_BARS;

  /**
   * Creates an immutable, reproducible CandidateArtifact.
   */
  public static createCandidateArtifact(
    candidate: StrategyCandidate,
    datasetHash?: string,
    trainingSeed = DEFAULT_LEARNING_SEED,
  ): CandidateArtifact {
    const config = this.createExecutionConfig(candidate);
    const resolvedDatasetHash =
      datasetHash && datasetHash !== 'canonical_default_hash'
        ? datasetHash
        : ((candidate.change?.datasetHash as string) ||
          (candidate.evidence as any)?.datasetHash ||
          createHash('sha256').update(candidate.id + '_' + (candidate.candidateVersion || candidate.id)).digest('hex').slice(0, 16));

    const scalerParams =
      (candidate.change?.scalerArtifact as any)?.scalerParameters ||
      (candidate.change?.modelArtifact as any)?.scalerArtifact?.scalerParameters;
    const scalerHash = scalerParams
      ? TemporalFeatureScaler.computeScalerHash(scalerParams)
      : (candidate.change?.modelArtifact as any)?.scalerHash;

    const featureSchemaVersion = candidate.featureSchemaVersion || '2.0';
    const featureSchemaHash =
      (candidate.change?.modelArtifact as any)?.featureSchemaHash ||
      createHash('sha256').update(`canonical_schema_${featureSchemaVersion}`).digest('hex');

    const selectedFeatures = [...((candidate.change?.selectedFeatures as string[]) || [])];
    const selectedFeatureHash =
      selectedFeatures.length > 0
        ? createHash('sha256').update(selectedFeatures.join(',')).digest('hex')
        : (candidate.change?.modelArtifact as any)?.selectedFeatureHash;

    const canonicalPayload = {
      candidateId: candidate.id,
      candidateVersion: candidate.candidateVersion || candidate.id,
      strategyVersion: candidate.baseStrategyVersion || '1.0.0',
      datasetHash: resolvedDatasetHash,
      configHash: config.configHash,
      featureSchemaVersion,
      featureSchemaHash,
      selectedFeatures,
      selectedFeatureHash,
      scalerHash,
      modelArtifact: candidate.change?.modelArtifact
        ? {
            modelVersion: (candidate.change.modelArtifact as any).modelVersion,
            modelHash: (candidate.change.modelArtifact as any).modelHash,
            weights: (candidate.change.modelArtifact as any).weights,
            bias: (candidate.change.modelArtifact as any).bias,
          }
        : undefined,
      trainingSeed,
      riskConfig: { stopLossAtrMultiplier: config.stopLossAtrMultiplier, sizingMultiplier: config.sizingMultiplier },
      executionConfig: config,
    };

    const artifactId = createHash('sha256')
      .update(JSON.stringify(canonicalPayload))
      .digest('hex');

    const artifact: CandidateArtifact = {
      artifactId,
      candidateId: candidate.id,
      candidateVersion: candidate.candidateVersion || candidate.id,
      datasetHash: resolvedDatasetHash,
      strategyVersion: candidate.baseStrategyVersion || '1.0.0',
      strategyConfig: { ...(candidate.change || {}) },
      featureSchemaVersion,
      featureSchemaHash,
      selectedFeatures,
      selectedFeatureHash,
      modelArtifact: (candidate.change?.modelArtifact as any) || undefined,
      scalerArtifact:
        (candidate.change?.scalerArtifact as any) ||
        (candidate.change?.modelArtifact as any)?.scalerArtifact ||
        undefined,
      scalerHash,
      riskConfig: { stopLossAtrMultiplier: config.stopLossAtrMultiplier, sizingMultiplier: config.sizingMultiplier },
      executionConfig: config as any,
      trainingSeed,
      artifactVersion: 'v2.0',
      createdAt: new Date(),
      configHash: config.configHash,
    };
    return deepFreeze(artifact);
  }

  /**
   * Converts a StrategyCandidate into an executable strategy configuration object
   * with a canonical SHA-256 configuration hash.
   */
  public static createExecutionConfig(candidate: StrategyCandidate): CandidateExecutionConfig {
    const change = candidate.change || {};
    const minMtfScore =
      change.parameter === 'minMtfScore'
        ? (typeof change.fittedValue === 'number' ? change.fittedValue : (typeof change.value === 'number' ? change.value : undefined))
        : (typeof change.minMtfScore === 'number' ? change.minMtfScore : (change.minScore as number));

    const stopLossAtrMultiplier =
      typeof change.stopLossAtrMultiplier === 'number'
        ? change.stopLossAtrMultiplier
        : (change.parameter === 'stopLossAtrMultiplier' ? (change.value as number) : 1.0);

    const sizingMultiplier =
      typeof change.sizingMultiplier === 'number'
        ? change.sizingMultiplier
        : (change.parameter === 'sizingMultiplier' ? (change.value as number) : 1.0);

    const highVolatilitySizingMultiplier =
      typeof change.highVolatilitySizingMultiplier === 'number'
        ? change.highVolatilitySizingMultiplier
        : (change.parameter === 'highVolatilitySizingMultiplier' ? (change.value as number) : undefined);

    const minProbability =
      typeof change.minProbability === 'number'
        ? change.minProbability
        : (change.parameter === 'minProbability' ? (change.value as number) : undefined);

    const filterRegime = (change.filterRegime as string) || (change.parameter === 'filterRegime' ? (change.value as string) : undefined);
    const regimeMode: 'INCLUDE' | 'EXCLUDE' = (change.regimeMode as 'INCLUDE' | 'EXCLUDE') || (candidate.type === 'REGIME' && change.includeRegime ? 'INCLUDE' : 'EXCLUDE');
    const conditionRules = (change.conditionRules as string[]) || [];

    // Canonical SHA-256 hash over candidate parameters
    const hashPayload = JSON.stringify({
      id: candidate.id,
      candidateVersion: candidate.candidateVersion,
      type: candidate.type,
      baseStrategyVersion: candidate.baseStrategyVersion,
      minMtfScore,
      stopLossAtrMultiplier,
      sizingMultiplier,
      highVolatilitySizingMultiplier,
      filterRegime,
      regimeMode,
      minProbability,
      conditionRules,
      enablePartialTp1Trailing: change.parameter === 'enablePartialTp1Trailing',
      fittedValue: typeof change.fittedValue === 'number' ? change.fittedValue : undefined,
      fittedOnFold: change.fittedOnFold,
      modelArtifactId: (change.modelArtifact as any)?.modelVersion || (change.modelArtifact as any)?.modelId,
      changeValues: Object.keys(change).sort().map(k => [k, change[k]]),
    });
    const configHash = createHash('sha256').update(hashPayload).digest('hex');

    return {
      candidateId: candidate.id,
      candidateVersion: candidate.candidateVersion || candidate.id,
      configHash,
      minMtfScore,
      stopLossAtrMultiplier,
      enablePartialTp1Trailing: change.parameter === 'enablePartialTp1Trailing',
      highVolatilitySizingMultiplier,
      sizingMultiplier,
      filterRegime,
      regimeMode,
      minProbability,
      conditionRules,
      fittedValue: typeof change.fittedValue === 'number' ? change.fittedValue : undefined,
    };
  }

  /**
   * Replays candidate execution strictly through the authoritative BacktestSimulator engine
   * using continuous market candles and the immutable CandidateArtifact as the single source of truth.
   *
   * PRODUCTION EXECUTION: Always evaluates candidates via SignalGenerator continuous replay.
   */
  public static runCandidateBacktest(
    candidateOrArtifact: StrategyCandidate | CandidateArtifact,
    experiencesOrOptions?: TradingExperience[] | ICandidateBacktestOptions,
    maybeOptions?: ICandidateBacktestOptions,
  ): CandidateExecutionResult {
    const options: ICandidateBacktestOptions | undefined = Array.isArray(experiencesOrOptions)
      ? maybeOptions
      : (experiencesOrOptions as ICandidateBacktestOptions);

    // 1. Resolve or construct immutable CandidateArtifact
    const artifact: CandidateArtifact =
      'artifactId' in candidateOrArtifact && 'configHash' in candidateOrArtifact
        ? (candidateOrArtifact as CandidateArtifact)
        : this.createCandidateArtifact(candidateOrArtifact as StrategyCandidate);

    const config: CandidateExecutionConfig = artifact.executionConfig as any;
    const riskConfig = artifact.riskConfig;
    const candidateId = artifact.candidateId;

    // 2. Cryptographic Linkage Verification between Model and Candidate Scaler/Schema/Features
    if (artifact.modelArtifact) {
      const model = artifact.modelArtifact as any;
      if (model.featureSchemaHash && artifact.featureSchemaHash && model.featureSchemaHash !== artifact.featureSchemaHash) {
        throw new Error(
          `INCOMPATIBLE_MODEL_SCHEMA_HASH: Model schema hash ${model.featureSchemaHash} does not match artifact ${artifact.featureSchemaHash}`,
        );
      }
      if (model.scalerHash && artifact.scalerHash && model.scalerHash !== artifact.scalerHash) {
        throw new Error(
          `INCOMPATIBLE_MODEL_SCALER_HASH: Model scaler hash ${model.scalerHash} does not match artifact scaler hash ${artifact.scalerHash}`,
        );
      }
      if (model.selectedFeatureHash && artifact.selectedFeatureHash && model.selectedFeatureHash !== artifact.selectedFeatureHash) {
        throw new Error(
          `INCOMPATIBLE_MODEL_SELECTED_FEATURE_HASH: Model selected feature hash ${model.selectedFeatureHash} does not match artifact ${artifact.selectedFeatureHash}`,
        );
      }
    }

    // 3. Collect and validate continuous market candles
    const candles: ICandle[] = options?.dataset?.executionCandles || options?.candles || [];

    if (!candles || candles.length === 0) {
      throw new Error(
        'INSUFFICIENT_MARKET_DATA_FOR_CANDIDATE_EXECUTION: INSUFFICIENT_CONTINUOUS_MARKET_DATA: Candidate evaluation requires continuous market dataset',
      );
    }

    const strategyConfig = {
      ...artifact.strategyConfig,
      scoringWeights: (artifact.strategyConfig as any)?.scoringWeights,
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
      symbol: (options as any)?.symbol || 'BTCUSDT',
      timeframe: options?.dataset?.timeframe || (options as any)?.timeframe || '15m',
      candles,
      initialCapital: options?.initialCapital,
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
      scoringWeights: (artifact.strategyConfig as any)?.scoringWeights,
      strategyConfig,
      modelArtifact: artifact.modelArtifact || (artifact.strategyConfig as any)?.modelArtifact,
    };

    // Invoke authoritative BacktestSimulator engine directly
    const simResult = BacktestSimulator.runSimulation(backtestOptions);
    const trades = simResult.trades || [];
    const rMultiples = trades.map((t) => t.pnlRMultiple || 0);

    return {
      candidateId,
      totalTrades: simResult.totalTrades,
      trades,
      rMultiples,
      netPnL: simResult.netPnL,
      grossProfit: simResult.trades.filter((t) => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0),
      grossLoss: simResult.trades.filter((t) => t.pnl < 0).reduce((sum, t) => sum + Math.abs(t.pnl), 0),
      winRate: simResult.winRate,
      expectancyR: simResult.averageR,
      profitFactor: simResult.profitFactor,
      maxDrawdownR: simResult.maxDrawdownPercent,
    };
  }

  /**
   * TEST-ONLY FIXTURE RUNNER:
   * Replays candidate execution using explicit deterministic test fixture signals.
   * This is strictly for isolated deterministic unit tests and never exposed to production workflows.
   */
  public static runDeterministicTestFixture(
    candidateOrArtifact: StrategyCandidate | CandidateArtifact,
    fixture: IDeterministicTestFixtureOptions,
  ): CandidateExecutionResult {
    // 1. Resolve or construct immutable CandidateArtifact
    const artifact: CandidateArtifact =
      'artifactId' in candidateOrArtifact && 'configHash' in candidateOrArtifact
        ? (candidateOrArtifact as CandidateArtifact)
        : this.createCandidateArtifact(candidateOrArtifact as StrategyCandidate);

    const config: CandidateExecutionConfig = artifact.executionConfig as any;
    const riskConfig = artifact.riskConfig;
    const candidateId = artifact.candidateId;

    const candles: ICandle[] = fixture.candles || [];
    if (!candles || candles.length === 0) {
      throw new Error(
        'INSUFFICIENT_MARKET_DATA_FOR_CANDIDATE_EXECUTION: INSUFFICIENT_CONTINUOUS_MARKET_DATA: Test fixture requires candles',
      );
    }

    const fixtureSignals =
      fixture.signals ||
      (fixture.experiences && fixture.experiences.length > 0
        ? fixture.experiences
            .filter((e: TradingExperience) => e.execution?.entryPrice)
            .map((e: TradingExperience) => ({
              id: e.id,
              direction: e.decision?.action === 'SELL' ? 'BEARISH' : 'BULLISH',
              score: e.decision?.score ?? 80,
              entryPrice: e.execution?.entryPrice,
              stopLoss: e.risk?.stopLoss,
              tp1: e.risk?.target1,
              tp2: e.risk?.target2,
              tp3: e.risk?.target3,
              reasons: [...(e.reasons || []), ...(e.failureReasons || [])],
              marketContext: e.marketContext,
              features: (e as any).features,
              marketState: e.marketState,
              prediction: e.prediction,
              timestamp: e.timestamp,
            }))
        : (artifact.strategyConfig as any)?.TEST_ONLY_deterministicSignals ||
          (artifact.strategyConfig as any)?.deterministicSignals ||
          ((artifact.strategyConfig as any)?.deterministicSignal
            ? [(artifact.strategyConfig as any).deterministicSignal]
            : undefined));

    const strategyConfig = {
      ...artifact.strategyConfig,
      scoringWeights: (artifact.strategyConfig as any)?.scoringWeights,
      deterministicSignals: fixtureSignals,
      deterministicSignal:
        fixtureSignals && fixtureSignals.length === 1
          ? fixtureSignals[0]
          : undefined,
    };

    const minimumCandles = fixture.minimumCandles ?? 1;
    const warmupBars = fixture.warmupBars ?? 0;

    const backtestOptions: IBacktestOptions = {
      runId: `cand_test_bt_${candidateId}`,
      symbol: fixture.experiences?.[0]?.instrument?.symbol || fixture.symbol || 'BTCUSDT',
      timeframe: (fixture.experiences?.[0] as any)?.timeframe || fixture.timeframe || '15m',
      candles,
      experiences: fixture.experiences,
      initialCapital: fixture.initialCapital,
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
      scoringWeights: (artifact.strategyConfig as any)?.scoringWeights,
      strategyConfig,
      modelArtifact: artifact.modelArtifact || (artifact.strategyConfig as any)?.modelArtifact,
    };

    const simResult = BacktestSimulator.runSimulation(backtestOptions);
    const trades = simResult.trades || [];
    const rMultiples = trades.map((t) => t.pnlRMultiple || 0);

    return {
      candidateId,
      totalTrades: simResult.totalTrades,
      trades,
      rMultiples,
      netPnL: simResult.netPnL,
      grossProfit: simResult.trades.filter((t) => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0),
      grossLoss: simResult.trades.filter((t) => t.pnl < 0).reduce((sum, t) => sum + Math.abs(t.pnl), 0),
      winRate: simResult.winRate,
      expectancyR: simResult.averageR,
      profitFactor: simResult.profitFactor,
      maxDrawdownR: simResult.maxDrawdownPercent,
    };
  }
}
