import { createHash } from 'crypto';
import { ICandle, IBacktestTrade } from '@quant/shared';
import { BacktestSimulator, IBacktestOptions } from '@quant/backtesting';
import { DEFAULT_PARTIAL_EXIT_POLICY, TradeLifecycleManager } from '@quant/risk-engine';
import { CandidateArtifact, CandidateMarketDataset, CandidateStatus, StrategyCandidate, TradingExperience } from './types';
import { TemporalFeatureScaler } from './feature-scaler';
import { DEFAULT_LEARNING_SEED } from './walk-forward-validator';
import { DatasetManager } from './dataset-manager';

export interface CandidateExecutionConfig {
  candidateId: string;
  candidateVersion: string;
  strategyVersion?: string;
  configHash: string;
  symbol?: string;
  fillModel?: string;
  ambiguityMode?: string;
  latencyMs?: number;
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
  marketDataset?: CandidateMarketDataset;
  candles?: ICandle[];
  evaluationStartTimestamp?: number;
  evaluationEndTimestamp?: number;
  minimumCandles?: number;
  warmupBars?: number;
  symbol?: string;
  timeframe?: string;
  initialCapital?: number;
  riskConfig?: any;
  provenance?: any;
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
   * Creates an immutable, reproducible, content-addressable CandidateArtifact.
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
      riskConfig?: any;
    },
  ): CandidateArtifact {
    const config = this.createExecutionConfig(candidate);
    const resolvedDatasetHash =
      datasetHash && datasetHash !== 'canonical_default_hash'
        ? datasetHash
        : ((candidate.change?.datasetHash as string) ||
          (candidate.change?.marketDatasetHash as string) ||
          (candidate.evidence as any)?.datasetHash ||
          (candidate.evidence as any)?.validationDatasetHash ||
          (provenance?.marketDatasetHash as string) ||
          createHash('sha256').update(`canonical_dataset_${candidate.id}`).digest('hex'));

    const trainingDatasetHash =
      provenance?.trainingDatasetHash ||
      (candidate.change?.trainingDatasetHash as string) ||
      resolvedDatasetHash;

    const validationDatasetHash =
      provenance?.validationDatasetHash ||
      (candidate.change?.validationDatasetHash as string) ||
      resolvedDatasetHash;

    const oosDatasetHash =
      provenance?.oosDatasetHash ||
      (candidate.change?.oosDatasetHash as string) ||
      resolvedDatasetHash;

    const marketDatasetHash =
      (datasetHash && datasetHash !== 'canonical_default_hash' ? datasetHash : undefined) ||
      provenance?.marketDatasetHash ||
      (candidate.change?.marketDatasetHash as string) ||
      resolvedDatasetHash;

    const scalerParams =
      (candidate.change?.scalerArtifact as any)?.scalerParameters ||
      (candidate.change?.modelArtifact as any)?.scalerArtifact?.scalerParameters;
    const scalerHash = scalerParams
      ? TemporalFeatureScaler.computeScalerHash(scalerParams)
      : ((candidate.change?.modelArtifact as any)?.scalerHash ||
        (candidate.change?.scalerHash as string) ||
        createHash('sha256').update('canonical_baseline_scaler_v2').digest('hex'));

    const featureSchemaVersion = candidate.featureSchemaVersion || '2.0';
    const featureSchemaHash =
      (candidate.change?.modelArtifact as any)?.featureSchemaHash ||
      createHash('sha256').update(`canonical_schema_${featureSchemaVersion}`).digest('hex');

    const selectedFeatures = [...((candidate.change?.selectedFeatures as string[]) || [])];
    if (selectedFeatures.length === 0 && (candidate.change?.modelArtifact as any)?.selectedFeatures) {
      selectedFeatures.push(...((candidate.change?.modelArtifact as any)?.selectedFeatures as string[]));
    }
    if (selectedFeatures.length === 0) {
      selectedFeatures.push('smcScore', 'mtfAlignment', 'rvol');
    }
    const selectedFeatureHash = createHash('sha256').update(selectedFeatures.join(',')).digest('hex');

    const modelArtifact = candidate.change?.modelArtifact as any;
    const modelHash =
      modelArtifact?.weights && Array.isArray(modelArtifact.weights)
        ? createHash('sha256')
            .update(
              `${modelArtifact.modelVersion || 'v2.0'}|${modelArtifact.weights.join(',')}|${modelArtifact.bias ?? 0}`,
            )
            .digest('hex')
        : (modelArtifact?.modelHash ||
          (candidate.change?.modelHash as string) ||
          createHash('sha256').update('canonical_baseline_model_v2').digest('hex'));

    const modelId = modelArtifact?.modelId || `model-${candidate.id}`;
    const modelVersion = modelArtifact?.modelVersion || candidate.baseStrategyVersion || 'ml-v2-0';
    const strategyVersion = candidate.baseStrategyVersion || '1.0.0';
    const candidateVersion = candidate.candidateVersion || candidate.id;
    const artifactVersion = 'v2.0';
    const createdBy = provenance?.createdBy || 'LearningEngine';
    const createdAt = candidate.createdAt instanceof Date ? candidate.createdAt : new Date();
    const strategyConfig = { ...((candidate as any).strategyConfig || {}), ...(candidate.change || {}) };

    const candidateSymbol =
      (candidate as any).symbol ||
      (candidate.change as any)?.symbol ||
      (candidate as any).strategyConfig?.symbol ||
      provenance?.symbol ||
      config.symbol;

    if (candidateSymbol) {
      strategyConfig.symbol = candidateSymbol;
    }

    if ((candidate as any).evidence) {
      strategyConfig.evidence = (candidate as any).evidence;
    }
    if ((candidate as any).deterministicSignal) {
      (strategyConfig as any).deterministicSignal = (candidate as any).deterministicSignal;
    }
    if ((candidate as any).deterministicSignals) {
      (strategyConfig as any).deterministicSignals = (candidate as any).deterministicSignals;
    }
    if ((candidate as any).strategyConfig?.deterministicSignal) {
      (strategyConfig as any).deterministicSignal = (candidate as any).strategyConfig.deterministicSignal;
    }
    if ((candidate as any).strategyConfig?.deterministicSignals) {
      (strategyConfig as any).deterministicSignals = (candidate as any).strategyConfig.deterministicSignals;
    }
    if ((candidate as any).strategy) {
      (strategyConfig as any).strategy = (candidate as any).strategy;
    }

    const candidateRisk =
      (candidate as any).riskConfig ||
      (candidate.change as any)?.riskConfig ||
      provenance?.riskConfig;
    const resolvedRiskConfig = candidateRisk ? { ...candidateRisk } : {};

    const canonicalPayload = {
      candidateId: candidate.id,
      candidateVersion,
      modelId,
      modelVersion,
      strategyVersion,
      artifactVersion,
      featureSchemaVersion,
      featureSchemaHash,
      selectedFeatures,
      selectedFeatureHash,
      scalerHash,
      modelHash,
      trainingDatasetHash,
      validationDatasetHash,
      oosDatasetHash,
      marketDatasetHash,
      datasetHash: resolvedDatasetHash,
      configHash: config.configHash,
      trainingSeed,
      riskConfig: resolvedRiskConfig,
      executionConfig: config,
      strategyConfig,
    };

    const artifactHash = createHash('sha256')
      .update(JSON.stringify(canonicalPayload))
      .digest('hex');

    const artifact: CandidateArtifact = {
      artifactId: artifactHash,
      candidateId: candidate.id,
      modelId,
      modelVersion,
      strategyVersion,
      candidateVersion,
      artifactVersion,
      featureSchemaVersion,
      featureSchemaHash,
      selectedFeatures,
      selectedFeatureHash,
      scalerHash,
      scalerArtifact:
        (candidate.change?.scalerArtifact as any) ||
        (candidate.change?.modelArtifact as any)?.scalerArtifact ||
        undefined,
      modelArtifact: modelArtifact || undefined,
      modelHash,
      strategyConfig,
      trainingDatasetHash,
      validationDatasetHash,
      oosDatasetHash,
      marketDatasetHash,
      datasetHash: resolvedDatasetHash,
      trainingSeed,
      riskConfig: resolvedRiskConfig,
      executionConfig: config as any,
      status: (candidate.status as CandidateStatus) || 'TRAINED',
      createdBy,
      createdAt,
      configHash: config.configHash,
      artifactHash,
      ...((candidate as any).evidence ? { evidence: (candidate as any).evidence } : {}),
      ...(candidateSymbol ? { symbol: candidateSymbol } : {}),
    } as any;
    return deepFreeze(artifact);
  }

  /**
   * Validates that an artifact has not been tampered with and that all internal cryptographic hashes match.
   */
  public static validateArtifactIntegrity(artifact: CandidateArtifact): { isValid: boolean; reason?: string } {
    if (!artifact || typeof artifact !== 'object') {
      return { isValid: false, reason: 'INVALID_ARTIFACT_OBJECT' };
    }

    // 1. Validate Schema Hash
    const expectedSchemaHash = createHash('sha256').update(`canonical_schema_${artifact.featureSchemaVersion || '2.0'}`).digest('hex');
    if (artifact.featureSchemaHash && artifact.featureSchemaHash !== expectedSchemaHash && !artifact.featureSchemaHash.startsWith('canonical_')) {
      return { isValid: false, reason: `FEATURE_SCHEMA_HASH_MISMATCH: expected ${expectedSchemaHash}, got ${artifact.featureSchemaHash}` };
    }

    // 2. Validate Scaler Hash if scaler parameters exist
    const scalerParams = (artifact.scalerArtifact as any)?.scalerParameters;
    if (scalerParams) {
      try {
        const computedScalerHash = TemporalFeatureScaler.computeScalerHash(scalerParams);
        if (artifact.scalerHash && artifact.scalerHash !== computedScalerHash) {
          return { isValid: false, reason: `SCALER_HASH_MISMATCH: expected ${computedScalerHash}, got ${artifact.scalerHash}` };
        }
      } catch {
        return { isValid: false, reason: 'SCALER_HASH_MISMATCH: corrupted scaler parameters' };
      }
    }

    // 3. Validate Model Hash if model weights exist
    const model = artifact.modelArtifact as any;
    if (model && Array.isArray(model.weights)) {
      const computedModelHash = createHash('sha256')
        .update(`${model.modelVersion || 'v2.0'}|${model.weights.join(',')}|${model.bias ?? 0}`)
        .digest('hex');
      if (artifact.modelHash && artifact.modelHash !== computedModelHash) {
        return { isValid: false, reason: `MODEL_HASH_MISMATCH: expected ${computedModelHash}, got ${artifact.modelHash}` };
      }
    }

    // 4. Validate Root Artifact Hash
    const canonicalPayload = {
      candidateId: artifact.candidateId,
      candidateVersion: artifact.candidateVersion,
      modelId: artifact.modelId,
      modelVersion: artifact.modelVersion,
      strategyVersion: artifact.strategyVersion,
      artifactVersion: artifact.artifactVersion,
      featureSchemaVersion: artifact.featureSchemaVersion,
      featureSchemaHash: artifact.featureSchemaHash,
      selectedFeatures: artifact.selectedFeatures,
      selectedFeatureHash: artifact.selectedFeatureHash,
      scalerHash: artifact.scalerHash,
      modelHash: artifact.modelHash,
      trainingDatasetHash: artifact.trainingDatasetHash,
      validationDatasetHash: artifact.validationDatasetHash,
      oosDatasetHash: artifact.oosDatasetHash,
      marketDatasetHash: artifact.marketDatasetHash,
      datasetHash: artifact.datasetHash,
      configHash: artifact.configHash,
      trainingSeed: artifact.trainingSeed,
      riskConfig: artifact.riskConfig,
      executionConfig: artifact.executionConfig,
      strategyConfig: artifact.strategyConfig ?? {},
    };

    const computedArtifactHash = createHash('sha256').update(JSON.stringify(canonicalPayload)).digest('hex');
    if (artifact.artifactHash !== computedArtifactHash) {
      return { isValid: false, reason: `ARTIFACT_HASH_MISMATCH: expected ${computedArtifactHash}, got ${artifact.artifactHash}` };
    }

    return { isValid: true };
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

    const symbol =
      (candidate as any).symbol ||
      (change as any).symbol ||
      (candidate as any).executionConfig?.symbol ||
      (candidate as any).strategyConfig?.symbol;

    return {
      candidateId: candidate.id,
      candidateVersion: candidate.candidateVersion || candidate.id,
      strategyVersion: candidate.baseStrategyVersion || '1.0.0',
      configHash,
      symbol,
      fillModel: (change as any).fillModel || (candidate as any).fillModel || 'OHLC_PATH',
      ambiguityMode:
        (change as any).ambiguityMode ||
        (candidate as any).ambiguityMode ||
        'CONSERVATIVE',
      latencyMs:
        typeof (change as any).latencyMs === 'number'
          ? (change as any).latencyMs
          : typeof (candidate as any).latencyMs === 'number'
            ? (candidate as any).latencyMs
            : 15,
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
   * Preflight validation for CandidateArtifact execution configuration.
   * Enforces strict fail-closed requirements before BacktestSimulator is invoked.
   */
  public static validateCandidateExecutionConfig(
    artifactOrCandidate: StrategyCandidate | CandidateArtifact,
    options?: ICandidateBacktestOptions,
  ): void {
    if (!artifactOrCandidate || typeof artifactOrCandidate !== 'object') {
      throw new Error('CANDIDATE_CONFIG_INVALID: Candidate or artifact is undefined/null');
    }

    const candidateId =
      (artifactOrCandidate as any).id || (artifactOrCandidate as CandidateArtifact).candidateId || 'unknown';

    // 1. Symbol validation
    const symbol =
      (options as any)?.symbol ||
      (options as any)?.marketDataset?.symbol ||
      (options as any)?.dataset?.symbol ||
      (artifactOrCandidate as any).executionConfig?.symbol ||
      (artifactOrCandidate as any).strategyConfig?.symbol ||
      (artifactOrCandidate as any).change?.symbol ||
      (artifactOrCandidate as any).symbol;

    if (!symbol || typeof symbol !== 'string' || symbol.trim() === '') {
      throw new Error(`CANDIDATE_SYMBOL_MISSING: Candidate '${candidateId}' is missing authoritative symbol`);
    }

    // 2. Risk Configuration Validation (Strict Fail-Closed)
    const riskConfig =
      ((artifactOrCandidate as any).riskConfig && Object.keys((artifactOrCandidate as any).riskConfig).length > 0
        ? (artifactOrCandidate as any).riskConfig
        : undefined) ||
      ((artifactOrCandidate as any).change?.riskConfig && Object.keys((artifactOrCandidate as any).change.riskConfig).length > 0
        ? (artifactOrCandidate as any).change.riskConfig
        : undefined) ||
      ((options as any)?.riskConfig && Object.keys((options as any).riskConfig).length > 0
        ? (options as any).riskConfig
        : undefined);

    if (!riskConfig || typeof riskConfig !== 'object' || Object.keys(riskConfig).length === 0) {
      throw new Error(`CANDIDATE_RISK_CONFIG_MISSING: Candidate '${candidateId}' is missing authoritative riskConfig`);
    }

    const initialCapital = (riskConfig as any).initialCapital ?? options?.initialCapital;
    if (typeof initialCapital !== 'number' || !Number.isFinite(initialCapital) || initialCapital <= 0) {
      throw new Error(
        `INVALID_CANDIDATE_RISK_CONFIG: Candidate '${candidateId}' riskConfig is missing valid initialCapital`,
      );
    }

    const maxRiskPerTrade = (riskConfig as any).maxRiskPerTrade;
    if (typeof maxRiskPerTrade !== 'number' || !Number.isFinite(maxRiskPerTrade) || maxRiskPerTrade <= 0) {
      throw new Error(
        `INVALID_CANDIDATE_RISK_CONFIG: Candidate '${candidateId}' riskConfig is missing valid maxRiskPerTrade`,
      );
    }

    const partialPolicy = (riskConfig as any).partialExitPolicy;
    if (!partialPolicy) {
      throw new Error(
        `INVALID_CANDIDATE_RISK_CONFIG: Candidate '${candidateId}' riskConfig is missing partialExitPolicy`,
      );
    }

    const policyVal = TradeLifecycleManager.validatePartialExitPolicy(partialPolicy);
    if (!policyVal.isValid) {
      throw new Error(
        `INVALID_CANDIDATE_RISK_CONFIG: Candidate '${candidateId}' partialExitPolicy is invalid: ${policyVal.reason}`,
      );
    }
  }

  /**
   * Replays candidate execution strictly through the authoritative BacktestSimulator engine
   * using continuous market candles and the immutable CandidateArtifact as the single source of truth.
   *
   * PRODUCTION EXECUTION: Always evaluates candidates via SignalGenerator continuous replay.
   * Strictly requires continuous market data (CandidateMarketDataset | ICandle[]).
   */
  public static runCandidateBacktest(
    candidateOrArtifact: StrategyCandidate | CandidateArtifact,
    options: ICandidateBacktestOptions,
  ): CandidateExecutionResult;
  public static runCandidateBacktest(
    candidateOrArtifact: StrategyCandidate | CandidateArtifact,
    legacyExperiences: TradingExperience[],
    options?: ICandidateBacktestOptions,
  ): CandidateExecutionResult;
  public static runCandidateBacktest(
    candidateOrArtifact: StrategyCandidate | CandidateArtifact,
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

    // 2. Resolve or construct immutable CandidateArtifact
    const artifact: CandidateArtifact =
      candidateOrArtifact && 'artifactId' in candidateOrArtifact && 'configHash' in candidateOrArtifact
        ? (candidateOrArtifact as CandidateArtifact)
        : this.createCandidateArtifact(candidateOrArtifact as StrategyCandidate, resolvedHash, {
            ...options?.provenance,
            symbol: options?.symbol || options?.marketDataset?.symbol || options?.dataset?.symbol,
            riskConfig: options?.riskConfig,
          });

    // 2b. Preflight validation for CandidateArtifact execution configuration (Fail-Closed)
    this.validateCandidateExecutionConfig(artifact, options);

    const config: CandidateExecutionConfig = artifact.executionConfig as any;
    const riskConfig = artifact.riskConfig;
    const candidateId = artifact.candidateId;

    // 3. Cryptographic Linkage Verification between Model and Candidate Scaler/Schema/Features
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
      timeframe: dataset?.timeframe || (options as any)?.timeframe || '15m',
      candles,
      initialCapital: options?.initialCapital,
      minimumCandles,
      warmupBars,
      candidateArtifact: artifact,
      minScore: config.minMtfScore,
      stopLossAtrMultiplier: (riskConfig?.stopLossAtrMultiplier as number | undefined) ?? config.stopLossAtrMultiplier,
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
   * This is strictly for isolated deterministic unit tests and never exposed to production workflows.
   */
  public static runDeterministicTestFixture(
    candidateOrArtifact: StrategyCandidate | CandidateArtifact,
    fixture: IDeterministicTestFixtureOptions,
  ): CandidateExecutionResult {
    const candles: ICandle[] = fixture.candles || [];
    if (!candles || candles.length === 0) {
      throw new Error(
        'INSUFFICIENT_MARKET_DATA_FOR_CANDIDATE_EXECUTION: INSUFFICIENT_CONTINUOUS_MARKET_DATA: Test fixture requires candles',
      );
    }

    let fixtureHash: string | undefined = fixture.dataset?.datasetHash || fixture.marketDataset?.datasetHash;
    if (!fixtureHash && candles.length > 0) {
      try {
        fixtureHash = DatasetManager.requireCanonicalMarketDatasetHash(
          candles,
          fixture.timeframe || fixture.dataset?.timeframe || fixture.marketDataset?.timeframe,
        );
      } catch {
        fixtureHash = DatasetManager.computeCanonicalMarketDatasetHash(
          candles,
          fixture.timeframe || fixture.dataset?.timeframe || fixture.marketDataset?.timeframe || '15m',
        );
      }
    }

    // 1. Resolve or construct immutable CandidateArtifact
    const artifact: CandidateArtifact =
      'artifactId' in candidateOrArtifact && 'configHash' in candidateOrArtifact
        ? (candidateOrArtifact as CandidateArtifact)
        : this.createCandidateArtifact(candidateOrArtifact as StrategyCandidate, fixtureHash);

    const config: CandidateExecutionConfig = artifact.executionConfig as any;
    const riskConfig = artifact.riskConfig;
    const candidateId = artifact.candidateId;

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
      stopLossAtrMultiplier: (riskConfig?.stopLossAtrMultiplier as number | undefined) ?? config.stopLossAtrMultiplier,
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
