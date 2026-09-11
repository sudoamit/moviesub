import { createHash } from 'crypto';
import {
  CandidateArtifact,
  CandidateExecutionConfig,
  CandidateRiskConfig,
  CandidateStatus,
  CandidateStrategyConfig,
  ModelArtifact,
  ScalerArtifact,
  StrategyCandidate,
  ValidatedCandidateArtifact,
} from './types';
import {
  createExecutionContext,
  ProductionExecutionContext,
} from './execution-context';
import { TemporalFeatureScaler } from './feature-scaler';
import { DEFAULT_LEARNING_SEED } from './walk-forward-validator';
import { CandidateArtifactValidator } from './candidate-artifact-validator';
import { canonicalJsonStringify } from './canonical-serializer';
import { ModelTrainer } from './model-trainer';

export const ALLOWED_FILL_MODELS: ReadonlySet<string> = new Set([
  'OHLC_PATH',
  'NEXT_BAR_OPEN',
  'NEXT_BAR_MARKET',
  'LIMIT_TOUCH',
  'LIMIT_WITH_SLIPPAGE',
  'LOWER_TIMEFRAME',
  'TICK_ACCURATE',
]);

export const ALLOWED_AMBIGUITY_MODES: ReadonlySet<string> = new Set([
  'CONSERVATIVE',
  'OPTIMISTIC',
  'OHLC_PATH',
  'LOWER_TIMEFRAME',
  'AGGRESSIVE',
]);

export interface CandidateArtifactBuildOptions {
  datasetHash?: string;
  trainingSeed?: number;
  provenance?: {
    trainingDatasetHash?: string;
    validationDatasetHash?: string;
    oosDatasetHash?: string;
    marketDatasetHash?: string;
    developmentMarketDatasetHash?: string;
    trainingMarketDatasetHash?: string;
    validationMarketDatasetHash?: string;
    oosMarketDatasetHash?: string;
    trainingExperienceDatasetHash?: string;
    validationExperienceDatasetHash?: string;
    oosExperienceDatasetHash?: string;
    createdBy?: string;
    symbol?: string;
    riskConfig?: CandidateRiskConfig | Record<string, unknown>;
    productionExecutionContext?: ProductionExecutionContext;
    executionContext?: 'PRODUCTION' | 'EXPERIMENTAL';
  };
  symbol?: string;
  riskConfig?: CandidateRiskConfig | Record<string, unknown>;
  executionConfig?: CandidateExecutionConfig | Record<string, unknown>;
  productionExecutionContext?: ProductionExecutionContext;
  executionContext?: 'PRODUCTION' | 'EXPERIMENTAL';
  minimumCandles?: number;
  warmupBars?: number;
  timeframe?: string;
  latencyConfig?: any;
  feeConfig?: any;
  slippageConfig?: any;
  spreadConfig?: any;
  costStressConfig?: any;
}

function deepFreeze<T extends object>(obj: T): Readonly<T> {
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && (typeof val === 'object' || typeof val === 'function') && !Object.isFrozen(val)) {
      deepFreeze(val as object);
    }
  }
  return obj;
}

export class CandidateArtifactBuilder {
  /**
   * Constructs an execution configuration object with canonical SHA-256 parameter hash.
   */
  public static createExecutionConfig(
    candidate: StrategyCandidate,
    options?: CandidateArtifactBuildOptions,
  ): CandidateExecutionConfig {
    if (!candidate.id || typeof candidate.id !== 'string' || candidate.id.trim() === '') {
      throw new Error(`CANDIDATE_ID_MISSING: Strategy candidate is missing a valid identifier`);
    }
    if (
      !candidate.candidateVersion ||
      typeof candidate.candidateVersion !== 'string' ||
      candidate.candidateVersion.trim() === ''
    ) {
      throw new Error(`CANDIDATE_VERSION_MISSING: Candidate '${candidate.id}' is missing candidateVersion`);
    }

    const rawCandidate = candidate as unknown as Record<string, unknown>;
    const symbol =
      options?.symbol ||
      options?.provenance?.symbol ||
      (candidate as unknown as Record<string, unknown>).symbol ||
      (candidate.change as Record<string, unknown>)?.symbol ||
      (rawCandidate.executionConfig as Record<string, unknown>)?.symbol ||
      (rawCandidate.strategyConfig as Record<string, unknown>)?.symbol ||
      (rawCandidate.instrument as Record<string, unknown>)?.symbol;

    if (!symbol || typeof symbol !== 'string' || symbol.trim() === '') {
      throw new Error(`CANDIDATE_SYMBOL_MISSING: Candidate '${candidate.id}' is missing authoritative symbol`);
    }

    const fillModel =
      ((candidate.executionConfig as Record<string, unknown>)?.fillModel as string) ||
      ((options?.executionConfig as Record<string, unknown>)?.fillModel as string) ||
      ((candidate.change as Record<string, unknown>)?.fillModel as string) ||
      ((candidate.change as Record<string, unknown>)?.executionConfig as Record<string, unknown>)?.fillModel as string ||
      ((rawCandidate.executionConfig as Record<string, unknown>)?.fillModel as string) ||
      ((rawCandidate.strategyConfig as Record<string, unknown>)?.executionConfig as Record<string, unknown>)?.fillModel as string ||
      ((rawCandidate.strategyConfig as Record<string, unknown>)?.fillModel as string) ||
      ((options?.provenance as any)?.executionConfig?.fillModel as string) ||
      (rawCandidate.fillModel as string);

    if (!fillModel || typeof fillModel !== 'string' || fillModel.trim() === '') {
      throw new Error(`MISSING_FILL_MODEL: Candidate '${candidate.id}' is missing authoritative fillModel`);
    }
    if (!ALLOWED_FILL_MODELS.has(fillModel)) {
      throw new Error(`INVALID_FILL_MODEL: Candidate '${candidate.id}' has invalid fillModel '${fillModel}'. Allowed: ${Array.from(ALLOWED_FILL_MODELS).join(', ')}`);
    }

    const ambiguityMode =
      ((candidate.executionConfig as Record<string, unknown>)?.ambiguityMode as string) ||
      ((options?.executionConfig as Record<string, unknown>)?.ambiguityMode as string) ||
      ((candidate.change as Record<string, unknown>)?.ambiguityMode as string) ||
      ((candidate.change as Record<string, unknown>)?.executionConfig as Record<string, unknown>)?.ambiguityMode as string ||
      ((rawCandidate.executionConfig as Record<string, unknown>)?.ambiguityMode as string) ||
      ((rawCandidate.strategyConfig as Record<string, unknown>)?.executionConfig as Record<string, unknown>)?.ambiguityMode as string ||
      ((rawCandidate.strategyConfig as Record<string, unknown>)?.ambiguityMode as string) ||
      ((options?.provenance as any)?.executionConfig?.ambiguityMode as string) ||
      (rawCandidate.ambiguityMode as string);

    if (!ambiguityMode || typeof ambiguityMode !== 'string' || ambiguityMode.trim() === '') {
      throw new Error(`MISSING_AMBIGUITY_MODE: Candidate '${candidate.id}' is missing authoritative ambiguityMode`);
    }
    if (!ALLOWED_AMBIGUITY_MODES.has(ambiguityMode)) {
      throw new Error(`INVALID_AMBIGUITY_MODE: Candidate '${candidate.id}' has invalid ambiguityMode '${ambiguityMode}'. Allowed: ${Array.from(ALLOWED_AMBIGUITY_MODES).join(', ')}`);
    }

    const rawLatency =
      (candidate.executionConfig as Record<string, unknown>)?.latencyMs ??
      (options?.executionConfig as Record<string, unknown>)?.latencyMs ??
      (candidate.change as Record<string, unknown>)?.latencyMs ??
      ((candidate.change as Record<string, unknown>)?.executionConfig as Record<string, unknown>)?.latencyMs ??
      (rawCandidate.executionConfig as Record<string, unknown>)?.latencyMs ??
      ((rawCandidate.strategyConfig as Record<string, unknown>)?.executionConfig as Record<string, unknown>)?.latencyMs ??
      (rawCandidate.strategyConfig as Record<string, unknown>)?.latencyMs ??
      ((options?.provenance as any)?.executionConfig?.latencyMs) ??
      rawCandidate.latencyMs;

    if (rawLatency === undefined || rawLatency === null || typeof rawLatency !== 'number' || !Number.isFinite(rawLatency) || rawLatency < 0) {
      throw new Error(`MISSING_LATENCY_MS: Candidate '${candidate.id}' must specify valid non-negative latencyMs`);
    }
    const latencyMs = rawLatency;

    const change = (candidate.change || {}) as Record<string, unknown>;
    const minMtfScore =
      change.parameter === 'minMtfScore'
        ? (typeof change.fittedValue === 'number'
            ? change.fittedValue
            : typeof change.value === 'number'
              ? (change.value as number)
              : undefined)
        : typeof change.minMtfScore === 'number'
          ? (change.minMtfScore as number)
          : typeof change.minScore === 'number'
            ? (change.minScore as number)
            : typeof (candidate as unknown as Record<string, unknown>).minMtfScore === 'number'
              ? ((candidate as unknown as Record<string, unknown>).minMtfScore as number)
              : typeof ((candidate as unknown as Record<string, unknown>).strategyConfig as Record<string, unknown>)?.minMtfScore === 'number'
                ? (((candidate as unknown as Record<string, unknown>).strategyConfig as Record<string, unknown>).minMtfScore as number)
                : typeof ((candidate as unknown as Record<string, unknown>).executionConfig as Record<string, unknown>)?.minMtfScore === 'number'
                  ? (((candidate as unknown as Record<string, unknown>).executionConfig as Record<string, unknown>).minMtfScore as number)
                  : typeof (options?.executionConfig as Record<string, unknown>)?.minMtfScore === 'number'
                    ? ((options?.executionConfig as Record<string, unknown>).minMtfScore as number)
                    : undefined;

    if (minMtfScore === undefined || !Number.isFinite(minMtfScore)) {
      throw new Error(`MISSING_MIN_MTF_SCORE: Candidate '${candidate.id}' must specify minMtfScore`);
    }

    if (minMtfScore < 0 || minMtfScore > 100) {
      throw new Error(`INVALID_MIN_MTF_SCORE: Candidate '${candidate.id}' minMtfScore must be in range [0, 100], got ${minMtfScore}`);
    }

    const stopLossAtrMultiplier =
      typeof change.stopLossAtrMultiplier === 'number'
        ? change.stopLossAtrMultiplier
        : change.parameter === 'stopLossAtrMultiplier' && typeof change.value === 'number'
          ? (change.value as number)
          : typeof (candidate as unknown as Record<string, unknown>).stopLossAtrMultiplier === 'number'
            ? ((candidate as unknown as Record<string, unknown>).stopLossAtrMultiplier as number)
            : typeof ((candidate as unknown as Record<string, unknown>).strategyConfig as Record<string, unknown>)?.stopLossAtrMultiplier === 'number'
              ? (((candidate as unknown as Record<string, unknown>).strategyConfig as Record<string, unknown>).stopLossAtrMultiplier as number)
              : typeof ((candidate as unknown as Record<string, unknown>).executionConfig as Record<string, unknown>)?.stopLossAtrMultiplier === 'number'
                ? (((candidate as unknown as Record<string, unknown>).executionConfig as Record<string, unknown>).stopLossAtrMultiplier as number)
                : typeof (options?.executionConfig as Record<string, unknown>)?.stopLossAtrMultiplier === 'number'
                  ? ((options?.executionConfig as Record<string, unknown>).stopLossAtrMultiplier as number)
                  : undefined;

    if (stopLossAtrMultiplier === undefined || !Number.isFinite(stopLossAtrMultiplier) || stopLossAtrMultiplier <= 0) {
      throw new Error(`MISSING_STOP_LOSS_ATR_MULTIPLIER: Candidate '${candidate.id}' must specify valid positive stopLossAtrMultiplier`);
    }

    const sizingMultiplier =
      typeof change.sizingMultiplier === 'number'
        ? change.sizingMultiplier
        : change.parameter === 'sizingMultiplier' && typeof change.value === 'number'
          ? (change.value as number)
          : typeof (candidate as unknown as Record<string, unknown>).sizingMultiplier === 'number'
            ? ((candidate as unknown as Record<string, unknown>).sizingMultiplier as number)
            : typeof ((candidate as unknown as Record<string, unknown>).strategyConfig as Record<string, unknown>)?.sizingMultiplier === 'number'
              ? (((candidate as unknown as Record<string, unknown>).strategyConfig as Record<string, unknown>).sizingMultiplier as number)
              : typeof ((candidate as unknown as Record<string, unknown>).executionConfig as Record<string, unknown>)?.sizingMultiplier === 'number'
                ? (((candidate as unknown as Record<string, unknown>).executionConfig as Record<string, unknown>).sizingMultiplier as number)
                : typeof (options?.executionConfig as Record<string, unknown>)?.sizingMultiplier === 'number'
                  ? ((options?.executionConfig as Record<string, unknown>).sizingMultiplier as number)
                  : undefined;

    if (sizingMultiplier === undefined || !Number.isFinite(sizingMultiplier) || sizingMultiplier <= 0) {
      throw new Error(`MISSING_SIZING_MULTIPLIER: Candidate '${candidate.id}' must specify valid positive sizingMultiplier`);
    }

    const highVolatilitySizingMultiplier =
      typeof change.highVolatilitySizingMultiplier === 'number'
        ? change.highVolatilitySizingMultiplier
        : change.parameter === 'highVolatilitySizingMultiplier'
          ? (change.value as number)
          : undefined;

    const minProbability =
      typeof change.minProbability === 'number'
        ? change.minProbability
        : change.parameter === 'minProbability'
          ? (change.value as number)
          : undefined;

    const filterRegime =
      (change.filterRegime as string) ||
      (change.parameter === 'filterRegime' ? (change.value as string) : undefined);
    const regimeMode: 'INCLUDE' | 'EXCLUDE' =
      (change.regimeMode as 'INCLUDE' | 'EXCLUDE') ||
      (candidate.type === 'REGIME' && change.includeRegime ? 'INCLUDE' : 'EXCLUDE');
    const conditionRules = (change.conditionRules as string[]) || [];

    // Canonical SHA-256 hash over candidate parameters using canonical JSON serialization
    const hashPayload = canonicalJsonStringify({
      id: candidate.id,
      candidateVersion: candidate.candidateVersion,
      type: candidate.type,
      baseStrategyVersion: candidate.baseStrategyVersion,
      symbol,
      minMtfScore,
      stopLossAtrMultiplier,
      sizingMultiplier,
      highVolatilitySizingMultiplier,
      filterRegime,
      regimeMode,
      minProbability,
      conditionRules,
      fillModel,
      ambiguityMode,
      latencyMs,
      enablePartialTp1Trailing: change.parameter === 'enablePartialTp1Trailing',
      fittedValue: typeof change.fittedValue === 'number' ? change.fittedValue : undefined,
      fittedOnFold: change.fittedOnFold,
      modelArtifactId:
        (change.modelArtifact as ModelArtifact | undefined)?.modelVersion ||
        (change.modelArtifact as ModelArtifact | undefined)?.modelId,
      changeValues: Object.keys(change)
        .sort()
        .map((k) => [k, change[k]]),
    });
    const configHash = createHash('sha256').update(hashPayload).digest('hex');

    return {
      candidateId: candidate.id,
      candidateVersion: candidate.candidateVersion,
      strategyVersion: candidate.baseStrategyVersion || '1.0.0',
      configHash,
      symbol,
      fillModel,
      ambiguityMode,
      latencyMs,
      minMtfScore,
      stopLossAtrMultiplier,
      sizingMultiplier,
      highVolatilitySizingMultiplier,
      filterRegime,
      regimeMode,
      minProbability,
      conditionRules,
      fittedValue: typeof change.fittedValue === 'number' ? change.fittedValue : undefined,
    };
  }

  /**
   * Builds an immutable, reproducible, validated CandidateArtifact with strict cryptographic linkage.
   */
  public static build(
    candidate: StrategyCandidate,
    options?: CandidateArtifactBuildOptions,
  ): ValidatedCandidateArtifact {
    const config = this.createExecutionConfig(candidate, options);
    const datasetHash = options?.datasetHash;
    const trainingSeed = options?.trainingSeed ?? DEFAULT_LEARNING_SEED;
    const provenance = options?.provenance;

    const rawCandidate = candidate as unknown as Record<string, unknown>;
    const candidateChange = candidate.change as Record<string, unknown> | undefined;

    const resolvedDatasetHash =
      datasetHash ||
      provenance?.marketDatasetHash ||
      provenance?.trainingDatasetHash ||
      (candidateChange?.marketDatasetHash as string) ||
      (candidateChange?.datasetHash as string) ||
      (rawCandidate.datasetHash as string) ||
      (candidateChange?.trainingDatasetHash as string);

    if (!resolvedDatasetHash || typeof resolvedDatasetHash !== 'string' || resolvedDatasetHash.trim() === '') {
      throw new Error(`DATASET_HASH_MISSING: Candidate '${candidate.id}' is missing authoritative dataset provenance hash`);
    }

    const trainingDatasetHash =
      provenance?.trainingDatasetHash ||
      (candidateChange?.trainingDatasetHash as string) ||
      resolvedDatasetHash;

    const validationDatasetHash =
      provenance?.validationDatasetHash ||
      (candidateChange?.validationDatasetHash as string) ||
      resolvedDatasetHash;

    const oosDatasetHash =
      provenance?.oosDatasetHash ||
      (candidateChange?.oosDatasetHash as string) ||
      resolvedDatasetHash;

    const developmentMarketDatasetHash =
      provenance?.developmentMarketDatasetHash ||
      (datasetHash && datasetHash !== 'canonical_default_hash' ? datasetHash : undefined) ||
      provenance?.marketDatasetHash ||
      (candidateChange?.developmentMarketDatasetHash as string) ||
      (candidateChange?.marketDatasetHash as string) ||
      resolvedDatasetHash;

    const marketDatasetHash = developmentMarketDatasetHash;

    const trainingMarketDatasetHash =
      provenance?.trainingMarketDatasetHash ||
      provenance?.trainingDatasetHash ||
      (candidateChange?.trainingMarketDatasetHash as string) ||
      trainingDatasetHash;

    const validationMarketDatasetHash =
      provenance?.validationMarketDatasetHash ||
      provenance?.validationDatasetHash ||
      (candidateChange?.validationMarketDatasetHash as string) ||
      validationDatasetHash;

    const oosMarketDatasetHash =
      provenance?.oosMarketDatasetHash ||
      provenance?.oosDatasetHash ||
      (candidateChange?.oosMarketDatasetHash as string) ||
      oosDatasetHash;

    const trainingExperienceDatasetHash =
      provenance?.trainingExperienceDatasetHash ||
      (candidateChange?.trainingExperienceDatasetHash as string) ||
      trainingDatasetHash;

    const validationExperienceDatasetHash =
      provenance?.validationExperienceDatasetHash ||
      (candidateChange?.validationExperienceDatasetHash as string) ||
      validationDatasetHash;

    const oosExperienceDatasetHash =
      provenance?.oosExperienceDatasetHash ||
      (candidateChange?.oosExperienceDatasetHash as string) ||
      oosDatasetHash;

    const candidateRisk =
      candidate.riskConfig ||
      (candidateChange?.riskConfig as CandidateRiskConfig | undefined) ||
      options?.riskConfig ||
      options?.provenance?.riskConfig;

    if (!candidateRisk || typeof candidateRisk !== 'object' || Object.keys(candidateRisk).length === 0) {
      throw new Error(`CANDIDATE_RISK_CONFIG_MISSING: Candidate '${candidate.id}' is missing authoritative riskConfig`);
    }

    const resolvedRiskConfig: CandidateRiskConfig = deepFreeze({
      ...candidateRisk,
      initialCapital: candidateRisk.initialCapital,
      maxRiskPerTrade: candidateRisk.maxRiskPerTrade,
      partialExitPolicy: candidateRisk.partialExitPolicy,
    } as CandidateRiskConfig);
    const strategyVersion = candidate.baseStrategyVersion || '1.0.0';
    const candidateVersion = candidate.candidateVersion || candidate.id;
    const artifactVersion = 'v2.0';

    const candidateChangeConfig = candidateChange || {};
    const suppliedExecutionContext = options?.productionExecutionContext;
    const productionExecutionContext = suppliedExecutionContext
      ? suppliedExecutionContext.executionContext === (options?.executionContext || suppliedExecutionContext.executionContext)
        ? suppliedExecutionContext
        : createExecutionContext(suppliedExecutionContext, options?.executionContext)
      : createExecutionContext(
      {
        symbol: config.symbol,
        timeframe: options?.timeframe || (candidateChangeConfig.timeframe as string) || 'UNSPECIFIED',
        minimumCandles: Number(options?.minimumCandles ?? candidateChangeConfig.minimumCandles ?? 50),
        warmupBars: Number(options?.warmupBars ?? candidateChangeConfig.warmupBars ?? 40),
        fillModel: config.fillModel,
        ambiguityMode: config.ambiguityMode,
        latencyConfig: {
          submissionLatencyMs: options?.latencyConfig?.submissionLatencyMs ?? config.latencyMs,
          processingLatencyMs: Number(candidateChangeConfig.processingLatencyMs ?? 0),
        },
        feeConfig: options?.feeConfig || candidateChangeConfig.feeConfig as any,
        slippageConfig: options?.slippageConfig || candidateChangeConfig.slippageConfig as any,
        spreadConfig: options?.spreadConfig || candidateChangeConfig.spreadConfig as any,
        costStressConfig: options?.costStressConfig || candidateChangeConfig.costStressConfig as any,
        riskConfig: resolvedRiskConfig,
        sizingConfig: {
          lotSize: resolvedRiskConfig.lotSize,
          contractSize: resolvedRiskConfig.contractSize,
          sizingMultiplier: config.sizingMultiplier,
          highVolatilitySizingMultiplier: config.highVolatilitySizingMultiplier,
        },
        strategyVersion,
        executionVersion: artifactVersion,
      },
      options?.executionContext || 'PRODUCTION',
      );

    const modelArtifact = candidateChange?.modelArtifact as ModelArtifact | undefined;
    const scalerArtifact =
      (candidateChange?.scalerArtifact as ScalerArtifact | undefined) ||
      (candidateChange?.modelArtifact as ModelArtifact | undefined)?.scalerArtifact ||
      undefined;

    const isMlCandidate =
      candidate.type === 'MODEL' ||
      modelArtifact !== undefined ||
      scalerArtifact !== undefined;

    const selectedFeatures: string[] = [];
    if (Array.isArray(candidateChange?.selectedFeatures)) {
      selectedFeatures.push(...(candidateChange.selectedFeatures as string[]));
    }
    if (selectedFeatures.length === 0 && modelArtifact?.selectedFeatures && Array.isArray(modelArtifact.selectedFeatures)) {
      selectedFeatures.push(...modelArtifact.selectedFeatures);
    }

    if (selectedFeatures.length === 0) {
      if (isMlCandidate) {
        throw new Error(`SELECTED_FEATURES_MISSING: ML candidate '${candidate.id}' must explicitly specify selectedFeatures`);
      } else {
        selectedFeatures.push('none');
      }
    }
    const selectedFeatureHash = createHash('sha256').update(selectedFeatures.join(',')).digest('hex');

    const featureSchemaVersion = candidate.featureSchemaVersion || '2.0';
    let featureSchemaHash =
      modelArtifact?.featureSchemaHash ||
      (candidateChange?.featureSchemaHash as string | undefined) ||
      (rawCandidate.featureSchemaHash as string | undefined);

    if (isMlCandidate) {
      if (!featureSchemaHash || typeof featureSchemaHash !== 'string' || featureSchemaHash.trim() === '') {
        throw new Error(
          `FEATURE_SCHEMA_HASH_MISSING: ML candidate '${candidate.id}' must explicitly specify authoritative featureSchemaHash`,
        );
      }
    } else {
      featureSchemaHash = featureSchemaHash || 'none';
    }

    let scalerHash = 'none';
    let modelHash = 'none';
    let modelId = 'none';
    let modelVersion = 'none';

    if (isMlCandidate) {
      const scalerParams = scalerArtifact?.scalerParameters;
      if (scalerParams) {
        scalerHash = TemporalFeatureScaler.computeScalerHash(scalerParams);
      } else if (candidateChange?.scalerHash && typeof candidateChange.scalerHash === 'string') {
        scalerHash = candidateChange.scalerHash as string;
      }

      if (modelArtifact?.weights && Array.isArray(modelArtifact.weights) && typeof modelArtifact.bias === 'number') {
        modelHash = ModelTrainer.computeModelHash(
          modelArtifact.weights,
          modelArtifact.bias,
          scalerHash,
          modelArtifact.modelVersion,
        );
      } else if (candidateChange?.modelHash && typeof candidateChange.modelHash === 'string') {
        modelHash = candidateChange.modelHash as string;
      } else if (modelArtifact?.modelHash && typeof modelArtifact.modelHash === 'string') {
        modelHash = modelArtifact.modelHash as string;
      }

      if (!modelHash || modelHash === 'none' || typeof modelHash !== 'string' || modelHash.trim() === '') {
        throw new Error(`MODEL_HASH_MISSING: ML candidate '${candidate.id}' must specify valid non-empty modelHash`);
      }

      const mId = modelArtifact?.modelId || (candidateChange?.modelId as string | undefined);
      if (!mId || typeof mId !== 'string' || mId.trim() === '') {
        throw new Error(`MODEL_ID_MISSING: ML candidate '${candidate.id}' is missing modelArtifact.modelId`);
      }
      modelId = mId;

      const mVer = modelArtifact?.modelVersion || (candidateChange?.modelVersion as string | undefined);
      if (!mVer || typeof mVer !== 'string' || mVer.trim() === '') {
        throw new Error(`MODEL_VERSION_MISSING: ML candidate '${candidate.id}' is missing modelArtifact.modelVersion`);
      }
      modelVersion = mVer;
    }

    const createdBy = provenance?.createdBy || 'LearningEngine';
    const createdAt = candidate.createdAt instanceof Date ? candidate.createdAt : new Date();

    const stratConfigObj: Record<string, unknown> = {
      ...((rawCandidate.strategyConfig as Record<string, unknown>) || {}),
      ...(candidateChange || {}),
      symbol: config.symbol,
      minMtfScore: config.minMtfScore,
    };

    // Remove any test hooks from production strategyConfig
    delete stratConfigObj.deterministicSignal;
    delete stratConfigObj.deterministicSignals;
    delete stratConfigObj.strategy;

    if (candidate.evidence) {
      stratConfigObj.evidence = candidate.evidence;
    }

    const strategyConfig: CandidateStrategyConfig = stratConfigObj as unknown as CandidateStrategyConfig;

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
      ...(developmentMarketDatasetHash ? { developmentMarketDatasetHash } : {}),
      ...(trainingMarketDatasetHash ? { trainingMarketDatasetHash } : {}),
      ...(validationMarketDatasetHash ? { validationMarketDatasetHash } : {}),
      ...(oosMarketDatasetHash ? { oosMarketDatasetHash } : {}),
      ...(trainingExperienceDatasetHash ? { trainingExperienceDatasetHash } : {}),
      ...(validationExperienceDatasetHash ? { validationExperienceDatasetHash } : {}),
      ...(oosExperienceDatasetHash ? { oosExperienceDatasetHash } : {}),
      datasetHash: resolvedDatasetHash,
      configHash: config.configHash,
      trainingSeed,
      riskConfig: resolvedRiskConfig,
      executionConfig: config,
      strategyConfig,
      productionEligible: productionExecutionContext.productionEligible,
      executionContext: productionExecutionContext,
      executionContextHash: productionExecutionContext.executionContextHash,
      executionContextVersion: productionExecutionContext.executionContextVersion,
    };

    const artifactHash = createHash('sha256')
      .update(canonicalJsonStringify(canonicalPayload))
      .digest('hex');

    const rawArtifact: CandidateArtifact = {
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
      scalerArtifact,
      modelArtifact,
      modelHash,
      strategyConfig,
      trainingDatasetHash,
      validationDatasetHash,
      oosDatasetHash,
      marketDatasetHash,
      developmentMarketDatasetHash,
      trainingMarketDatasetHash,
      validationMarketDatasetHash,
      oosMarketDatasetHash,
      trainingExperienceDatasetHash,
      validationExperienceDatasetHash,
      oosExperienceDatasetHash,
      datasetHash: resolvedDatasetHash,
      trainingSeed,
      riskConfig: resolvedRiskConfig,
      executionConfig: config,
      productionEligible: productionExecutionContext.productionEligible,
      executionContext: productionExecutionContext,
      executionContextHash: productionExecutionContext.executionContextHash,
      executionContextVersion: productionExecutionContext.executionContextVersion,
      status: (candidate.status as CandidateStatus) || 'TRAINED',
      createdBy,
      createdAt,
      configHash: config.configHash,
      artifactHash,
      symbol: config.symbol,
      ...(candidate.evidence ? { evidence: candidate.evidence } : {}),
    };

    const frozen = deepFreeze(rawArtifact);
    return CandidateArtifactValidator.validate(frozen);
  }
}

