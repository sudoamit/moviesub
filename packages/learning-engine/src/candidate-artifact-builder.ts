import { createHash } from 'crypto';
import {
  CandidateArtifact,
  CandidateExecutionConfig,
  CandidateRiskConfig,
  CandidateStatus,
  CandidateStrategyConfig,
  StrategyCandidate,
  ValidatedCandidateArtifact,
} from './types';
import { TemporalFeatureScaler } from './feature-scaler';
import { DEFAULT_LEARNING_SEED } from './walk-forward-validator';
import { CandidateArtifactValidator } from './candidate-artifact-validator';

export interface CandidateArtifactBuildOptions {
  datasetHash?: string;
  trainingSeed?: number;
  provenance?: {
    trainingDatasetHash?: string;
    validationDatasetHash?: string;
    oosDatasetHash?: string;
    marketDatasetHash?: string;
    createdBy?: string;
    symbol?: string;
    riskConfig?: CandidateRiskConfig | Record<string, unknown>;
  };
  symbol?: string;
  riskConfig?: CandidateRiskConfig | Record<string, unknown>;
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

    const change = candidate.change || {};
    const minMtfScore =
      change.parameter === 'minMtfScore'
        ? (typeof change.fittedValue === 'number'
            ? change.fittedValue
            : typeof change.value === 'number'
              ? change.value
              : undefined)
        : typeof change.minMtfScore === 'number'
          ? change.minMtfScore
          : typeof change.minScore === 'number'
            ? change.minScore
            : typeof (candidate as any).minMtfScore === 'number'
              ? (candidate as any).minMtfScore
              : typeof (candidate as any).strategyConfig?.minMtfScore === 'number'
                ? (candidate as any).strategyConfig.minMtfScore
                : typeof (candidate as any).executionConfig?.minMtfScore === 'number'
                  ? (candidate as any).executionConfig.minMtfScore
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
        : change.parameter === 'stopLossAtrMultiplier'
          ? (change.value as number)
          : 1.0;

    const sizingMultiplier =
      typeof change.sizingMultiplier === 'number'
        ? change.sizingMultiplier
        : change.parameter === 'sizingMultiplier'
          ? (change.value as number)
          : 1.0;

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

    const symbol =
      options?.symbol ||
      options?.provenance?.symbol ||
      (candidate as any).symbol ||
      (change as any).symbol ||
      (candidate as any).executionConfig?.symbol ||
      (candidate as any).strategyConfig?.symbol ||
      (candidate as any).instrument?.symbol;

    if (!symbol || typeof symbol !== 'string' || symbol.trim() === '') {
      throw new Error(`CANDIDATE_SYMBOL_MISSING: Candidate '${candidate.id}' is missing authoritative symbol`);
    }

    const fillModel = (change as any).fillModel || (candidate as any).fillModel || 'OHLC_PATH';
    const ambiguityMode =
      (change as any).ambiguityMode || (candidate as any).ambiguityMode || 'CONSERVATIVE';
    const latencyMs =
      typeof (change as any).latencyMs === 'number'
        ? (change as any).latencyMs
        : typeof (candidate as any).latencyMs === 'number'
          ? (candidate as any).latencyMs
          : 50;

    // Canonical SHA-256 hash over candidate parameters
    const hashPayload = JSON.stringify({
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
        (change.modelArtifact as any)?.modelVersion || (change.modelArtifact as any)?.modelId,
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

    const resolvedDatasetHash =
      datasetHash ||
      provenance?.marketDatasetHash ||
      provenance?.trainingDatasetHash ||
      (candidate.change?.marketDatasetHash as string) ||
      (candidate.change?.datasetHash as string) ||
      (candidate as any).datasetHash ||
      (candidate.change?.trainingDatasetHash as string);

    if (!resolvedDatasetHash || typeof resolvedDatasetHash !== 'string' || resolvedDatasetHash.trim() === '') {
      throw new Error(`DATASET_HASH_MISSING: Candidate '${candidate.id}' is missing authoritative dataset provenance hash`);
    }

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
      (candidate.change?.featureSchemaHash as string) ||
      createHash('sha256').update(`canonical_schema_${featureSchemaVersion}`).digest('hex');

    const selectedFeatures = [...((candidate.change?.selectedFeatures as string[]) || [])];
    if (selectedFeatures.length === 0 && (candidate.change?.modelArtifact as any)?.selectedFeatures) {
      selectedFeatures.push(...((candidate.change?.modelArtifact as any)?.selectedFeatures as string[]));
    }
    if (selectedFeatures.length === 0) {
      selectedFeatures.push('smcScore', 'mtfAlignment', 'rvol');
    }
    const selectedFeatureHash =
      (candidate.change?.modelArtifact as any)?.selectedFeatureHash ||
      (candidate.change?.selectedFeatureHash as string) ||
      createHash('sha256').update(selectedFeatures.join(',')).digest('hex');

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

    const candidateRisk =
      (candidate as any).riskConfig ||
      (candidate.change as any)?.riskConfig ||
      options?.riskConfig ||
      provenance?.riskConfig ||
      (candidate.type === 'BASELINE'
        ? {
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
          }
        : undefined);

    if (!candidateRisk || typeof candidateRisk !== 'object' || Object.keys(candidateRisk).length === 0) {
      throw new Error(`CANDIDATE_RISK_CONFIG_MISSING: Candidate '${candidate.id}' is missing authoritative riskConfig`);
    }

    const resolvedRiskConfig: CandidateRiskConfig = deepFreeze({
      ...candidateRisk,
      initialCapital: candidateRisk.initialCapital,
      maxRiskPerTrade: candidateRisk.maxRiskPerTrade,
      partialExitPolicy: candidateRisk.partialExitPolicy,
    } as CandidateRiskConfig);

    const strategyConfig: CandidateStrategyConfig = {
      ...((candidate as any).strategyConfig || {}),
      ...(candidate.change || {}),
      symbol: config.symbol,
      minMtfScore: config.minMtfScore,
    };

    // Remove any test hooks from production strategyConfig
    delete (strategyConfig as any).deterministicSignal;
    delete (strategyConfig as any).deterministicSignals;
    delete (strategyConfig as any).strategy;

    if ((candidate as any).evidence) {
      (strategyConfig as any).evidence = (candidate as any).evidence;
    }

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
      executionConfig: config,
      status: (candidate.status as CandidateStatus) || 'TRAINED',
      createdBy,
      createdAt,
      configHash: config.configHash,
      artifactHash,
      symbol: config.symbol,
      ...((candidate as any).evidence ? { evidence: (candidate as any).evidence } : {}),
    };

    const frozen = deepFreeze(rawArtifact);
    return CandidateArtifactValidator.validate(frozen);
  }
}
