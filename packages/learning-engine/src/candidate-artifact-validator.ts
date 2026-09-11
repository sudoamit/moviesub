import { createHash } from 'crypto';
import { TradeLifecycleManager } from '@quant/risk-engine';
import {
  CandidateArtifact,
  CandidateExecutionConfig,
  CandidateRiskConfig,
  CandidateStrategyConfig,
  ValidatedCandidateArtifact,
} from './types';
import { TemporalFeatureScaler } from './feature-scaler';
import { canonicalJsonStringify } from './canonical-serializer';
import { ALLOWED_AMBIGUITY_MODES, ALLOWED_FILL_MODELS } from './candidate-artifact-builder';
import { ModelTrainer } from './model-trainer';
import { computeExecutionContextHash, EXECUTION_CONTEXT_VERSION } from './execution-context';

export class CandidateArtifactValidator {
  /**
   * Central canonical validation boundary for CandidateArtifact.
   * Ensures that any artifact consumed across Backtest, Shadow, Registry, Promotion, and WFV
   * strictly conforms to the immutable, validated financial ledger contract.
   * Zero test-hook tolerance in production validation.
   */
  public static validate(artifact: unknown): ValidatedCandidateArtifact {
    if (!artifact || typeof artifact !== 'object') {
      throw new Error('INVALID_CANDIDATE_ARTIFACT: Artifact must be a non-null object');
    }

    const art = artifact as Record<string, unknown>;

    // 1. Identity validation
    const candidateId = art.candidateId;
    if (typeof candidateId !== 'string' || candidateId.trim() === '') {
      throw new Error('CANDIDATE_ID_MISSING: Artifact is missing authoritative candidateId');
    }

    const candidateVersion = art.candidateVersion;
    if (typeof candidateVersion !== 'string' || candidateVersion.trim() === '') {
      throw new Error(`CANDIDATE_VERSION_MISSING: Candidate '${candidateId}' is missing candidateVersion`);
    }

    const strategyVersion = art.strategyVersion;
    if (typeof strategyVersion !== 'string' || strategyVersion.trim() === '') {
      throw new Error(`STRATEGY_VERSION_MISSING: Candidate '${candidateId}' is missing strategyVersion`);
    }

    const executionContext = art.executionContext as Record<string, unknown> | undefined;
    if (!executionContext || typeof executionContext !== 'object') {
      throw new Error(`EXECUTION_CONTEXT_MISSING: Candidate '${candidateId}' is missing canonical execution context`);
    }
    if (executionContext.executionContextVersion !== EXECUTION_CONTEXT_VERSION) {
      throw new Error(`EXECUTION_CONTEXT_VERSION_INVALID: Candidate '${candidateId}' has unsupported execution context version`);
    }
    const contextHash = executionContext.executionContextHash;
    if (typeof contextHash !== 'string' || contextHash !== computeExecutionContextHash(executionContext as any)) {
      throw new Error(`EXECUTION_CONTEXT_HASH_MISMATCH: Candidate '${candidateId}' execution context hash is invalid`);
    }
    if (art.executionContextHash !== contextHash || art.executionContextVersion !== executionContext.executionContextVersion) {
      throw new Error(`EXECUTION_CONTEXT_BINDING_MISMATCH: Candidate '${candidateId}' artifact context binding is invalid`);
    }
    if (typeof art.productionEligible !== 'boolean' || art.productionEligible !== (executionContext.productionEligible === true)) {
      throw new Error(`PRODUCTION_ELIGIBILITY_MISMATCH: Candidate '${candidateId}' eligibility does not match execution context`);
    }

    // 2. Authoritative Symbol Validation (Canonical authority on artifact root)
    const symbol = art.symbol;
    if (typeof symbol !== 'string' || symbol.trim() === '') {
      throw new Error(`CANDIDATE_SYMBOL_MISSING: Candidate '${candidateId}' is missing authoritative symbol`);
    }

    // 3. Risk Configuration Validation (Strict Fail-Closed)
    const riskConfig = art.riskConfig as Record<string, unknown> | undefined;
    if (!riskConfig || typeof riskConfig !== 'object' || Object.keys(riskConfig).length === 0) {
      throw new Error(`CANDIDATE_RISK_CONFIG_MISSING: Candidate '${candidateId}' is missing authoritative riskConfig`);
    }

    const initialCapital = riskConfig.initialCapital;
    if (typeof initialCapital !== 'number' || !Number.isFinite(initialCapital) || initialCapital <= 0) {
      throw new Error(
        `INVALID_CANDIDATE_RISK_CONFIG: Candidate '${candidateId}' riskConfig initialCapital must be a positive finite number`,
      );
    }

    const maxRiskPerTrade = riskConfig.maxRiskPerTrade;
    if (typeof maxRiskPerTrade !== 'number' || !Number.isFinite(maxRiskPerTrade) || maxRiskPerTrade <= 0 || maxRiskPerTrade > 1) {
      throw new Error(
        `INVALID_CANDIDATE_RISK_CONFIG: Candidate '${candidateId}' riskConfig maxRiskPerTrade must be a positive number <= 1.0`,
      );
    }

    const partialPolicy = riskConfig.partialExitPolicy;
    if (!partialPolicy || typeof partialPolicy !== 'object') {
      throw new Error(
        `INVALID_CANDIDATE_RISK_CONFIG: Candidate '${candidateId}' riskConfig is missing partialExitPolicy`,
      );
    }

    const policyVal = TradeLifecycleManager.validatePartialExitPolicy(partialPolicy as any);
    if (!policyVal.isValid) {
      throw new Error(
        `INVALID_CANDIDATE_RISK_CONFIG: Candidate '${candidateId}' partialExitPolicy is invalid: ${policyVal.reason}`,
      );
    }

    // 4. Execution Configuration Validation
    const execConfig = art.executionConfig as Record<string, unknown> | undefined;
    if (!execConfig || typeof execConfig !== 'object' || Object.keys(execConfig).length === 0) {
      throw new Error(`CANDIDATE_EXECUTION_CONFIG_MISSING: Candidate '${candidateId}' is missing executionConfig`);
    }

    if (execConfig.candidateId !== candidateId) {
      throw new Error(
        `EXECUTION_CONFIG_MISMATCH: Execution config candidateId '${execConfig.candidateId}' does not match artifact '${candidateId}'`,
      );
    }

    if (execConfig.symbol !== symbol) {
      throw new Error(
        `CANDIDATE_SYMBOL_MISMATCH: Execution config symbol '${execConfig.symbol}' does not match artifact symbol '${symbol}'`,
      );
    }

    if (typeof execConfig.configHash !== 'string' || execConfig.configHash.trim() === '') {
      throw new Error(`CONFIG_HASH_MISSING: Candidate '${candidateId}' executionConfig is missing configHash`);
    }

    // minMtfScore must be strictly defined, finite, and in range [0, 100]
    const execMinMtfScore = execConfig.minMtfScore;
    if (typeof execMinMtfScore !== 'number' || !Number.isFinite(execMinMtfScore) || execMinMtfScore < 0 || execMinMtfScore > 100) {
      throw new Error(
        `MISSING_MIN_MTF_SCORE: Candidate '${candidateId}' executionConfig must specify a finite minMtfScore in range [0, 100]`,
      );
    }

    // Sizing and Stop Loss Multipliers
    if (
      typeof execConfig.stopLossAtrMultiplier !== 'number' ||
      !Number.isFinite(execConfig.stopLossAtrMultiplier) ||
      (execConfig.stopLossAtrMultiplier as number) <= 0
    ) {
      throw new Error(
        `INVALID_STOP_MULTIPLIER: Candidate '${candidateId}' stopLossAtrMultiplier must be a positive finite number`,
      );
    }

    if (
      typeof execConfig.sizingMultiplier !== 'number' ||
      !Number.isFinite(execConfig.sizingMultiplier) ||
      (execConfig.sizingMultiplier as number) <= 0
    ) {
      throw new Error(
        `INVALID_SIZING_MULTIPLIER: Candidate '${candidateId}' sizingMultiplier must be a positive finite number`,
      );
    }

    // Fill model and ambiguity mode validation against canonical sets
    const fillModel = execConfig.fillModel as string;
    if (!fillModel || typeof fillModel !== 'string' || !ALLOWED_FILL_MODELS.has(fillModel)) {
      throw new Error(`INVALID_FILL_MODEL: Candidate '${candidateId}' has invalid fillModel '${fillModel}'`);
    }

    const ambiguityMode = execConfig.ambiguityMode as string;
    if (!ambiguityMode || typeof ambiguityMode !== 'string' || !ALLOWED_AMBIGUITY_MODES.has(ambiguityMode)) {
      throw new Error(
        `INVALID_AMBIGUITY_MODE: Candidate '${candidateId}' has invalid ambiguityMode '${ambiguityMode}'`,
      );
    }

    const latencyMs = execConfig.latencyMs;
    if (typeof latencyMs !== 'number' || latencyMs < 0 || !Number.isFinite(latencyMs)) {
      throw new Error(`INVALID_LATENCY: Candidate '${candidateId}' latencyMs must be non-negative finite number`);
    }

    // 5. Strategy Configuration Integrity
    const stratConfig = art.strategyConfig as Record<string, unknown> | undefined;
    if (!stratConfig || typeof stratConfig !== 'object') {
      throw new Error(`MISSING_STRATEGY_CONFIG: Candidate '${candidateId}' is missing strategyConfig`);
    }

    if (stratConfig.symbol !== symbol) {
      throw new Error(
        `CANDIDATE_SYMBOL_MISMATCH: Strategy config symbol '${stratConfig.symbol}' does not match artifact symbol '${symbol}'`,
      );
    }

    // Test hooks are strictly prohibited in production CandidateArtifact
    if ('deterministicSignal' in stratConfig || 'deterministicSignals' in stratConfig || 'strategy' in stratConfig) {
      throw new Error(
        `TEST_HOOKS_PROHIBITED_IN_PRODUCTION_ARTIFACT: Candidate '${candidateId}' strategyConfig contains test hooks (deterministicSignal/strategy)`,
      );
    }

    if ('deterministicSignal' in art || 'deterministicSignals' in art) {
      throw new Error(
        `TEST_HOOKS_PROHIBITED_IN_PRODUCTION_ARTIFACT: Candidate '${candidateId}' root artifact contains test hooks`,
      );
    }

    // 6. Schema and Feature Selection Integrity
    const featureSchemaVersion = art.featureSchemaVersion;
    if (typeof featureSchemaVersion !== 'string' || featureSchemaVersion.trim() === '') {
      throw new Error(`FEATURE_SCHEMA_VERSION_MISSING: Candidate '${candidateId}' is missing featureSchemaVersion`);
    }

    const featureSchemaHash = art.featureSchemaHash;
    if (typeof featureSchemaHash !== 'string' || featureSchemaHash.trim() === '') {
      throw new Error(`FEATURE_SCHEMA_HASH_MISSING: Candidate '${candidateId}' is missing featureSchemaHash`);
    }

    const selectedFeatures = art.selectedFeatures;
    if (!Array.isArray(selectedFeatures) || selectedFeatures.length === 0) {
      throw new Error(`SELECTED_FEATURES_MISSING: Candidate '${candidateId}' must specify non-empty selectedFeatures`);
    }

    // Canonical feature hash: SHA-256 over selectedFeatures without placeholder bypass
    const computedFeatureHash = createHash('sha256').update(selectedFeatures.join(',')).digest('hex');
    if (typeof art.selectedFeatureHash !== 'string' || art.selectedFeatureHash !== computedFeatureHash) {
      throw new Error(
        `SELECTED_FEATURE_HASH_MISMATCH: Candidate '${candidateId}' expected ${computedFeatureHash}, got ${art.selectedFeatureHash}`,
      );
    }

    // 7. Scaler & Model Integrity
    const scalerHash = art.scalerHash;
    if (typeof scalerHash !== 'string' || scalerHash.trim() === '') {
      throw new Error(`SCALER_HASH_MISSING: Candidate '${candidateId}' is missing scalerHash`);
    }

    const modelHash = art.modelHash;
    if (typeof modelHash !== 'string' || modelHash.trim() === '') {
      throw new Error(`MODEL_HASH_MISSING: Candidate '${candidateId}' is missing modelHash`);
    }

    if (scalerHash !== 'none') {
      const scalerParams = (art.scalerArtifact as any)?.scalerParameters;
      if (!scalerParams) {
        throw new Error(
          `SCALER_ARTIFACT_MISSING: Candidate '${candidateId}' has scalerHash '${scalerHash}' but is missing scalerArtifact with scalerParameters`,
        );
      }
      try {
        const computedScalerHash = TemporalFeatureScaler.computeScalerHash(scalerParams);
        if (scalerHash !== computedScalerHash) {
          throw new Error(
            `SCALER_HASH_MISMATCH: Candidate '${candidateId}' expected ${computedScalerHash}, got ${scalerHash}`,
          );
        }
      } catch (err: any) {
        throw new Error(`SCALER_HASH_MISMATCH: ${err.message || 'corrupted scaler parameters'}`);
      }
    } else if (art.scalerArtifact !== undefined && (art.scalerArtifact as any)?.scalerParameters) {
      throw new Error(
        `SCALER_HASH_MISMATCH: Candidate '${candidateId}' has scalerArtifact parameters but scalerHash is 'none'`,
      );
    }

    if (modelHash !== 'none') {
      const model = art.modelArtifact as any;
      if (!model || !Array.isArray(model.weights) || model.weights.length === 0) {
        throw new Error(
          `MODEL_ARTIFACT_MISSING: Candidate '${candidateId}' has modelHash '${modelHash}' but is missing modelArtifact with weights`,
        );
      }
      const canonicalModelHash = ModelTrainer.computeModelHash(
        model.weights,
        model.bias ?? 0,
        scalerHash,
        model.modelVersion,
      );
      const legacyModelHash = createHash('sha256')
        .update(`${model.modelVersion || 'v2.0'}|${model.weights.join(',')}|${model.bias ?? 0}`)
        .digest('hex');
      if (modelHash !== canonicalModelHash && modelHash !== legacyModelHash) {
        throw new Error(
          `MODEL_HASH_MISMATCH: Candidate '${candidateId}' expected ${canonicalModelHash}, got ${modelHash}`,
        );
      }
    } else if (art.modelArtifact && Array.isArray((art.modelArtifact as any).weights) && (art.modelArtifact as any).weights.length > 0) {
      throw new Error(
        `MODEL_HASH_MISMATCH: Candidate '${candidateId}' has modelArtifact weights but modelHash is 'none'`,
      );
    }

    // Cryptographic Linkage Verification
    const model = art.modelArtifact as any;
    if (model) {
      if (model.featureSchemaHash && art.featureSchemaHash && model.featureSchemaHash !== art.featureSchemaHash) {
        throw new Error(
          `INCOMPATIBLE_MODEL_SCHEMA_HASH: Model schema hash ${model.featureSchemaHash} does not match artifact ${art.featureSchemaHash}`,
        );
      }
      if (model.scalerHash && art.scalerHash && model.scalerHash !== art.scalerHash) {
        throw new Error(
          `INCOMPATIBLE_MODEL_SCALER_HASH: Model scaler hash ${model.scalerHash} does not match artifact scaler hash ${art.scalerHash}`,
        );
      }
      if (model.selectedFeatureHash && art.selectedFeatureHash && model.selectedFeatureHash !== art.selectedFeatureHash) {
        throw new Error(
          `INCOMPATIBLE_MODEL_SELECTED_FEATURE_HASH: Model selected feature hash ${model.selectedFeatureHash} does not match artifact selected feature hash ${art.selectedFeatureHash}`,
        );
      }
    }

    // 8. Dataset Provenance Hashes
    const datasetHash = art.datasetHash || art.marketDatasetHash;
    if (typeof datasetHash !== 'string' || datasetHash.trim() === '') {
      throw new Error(`DATASET_HASH_MISSING: Candidate '${candidateId}' is missing datasetHash`);
    }

    const trainingDatasetHash = art.trainingDatasetHash;
    if (typeof trainingDatasetHash !== 'string' || trainingDatasetHash.trim() === '') {
      throw new Error(`TRAINING_DATASET_HASH_MISSING: Candidate '${candidateId}' is missing trainingDatasetHash`);
    }

    const validationDatasetHash = art.validationDatasetHash;
    if (typeof validationDatasetHash !== 'string' || validationDatasetHash.trim() === '') {
      throw new Error(`VALIDATION_DATASET_HASH_MISSING: Candidate '${candidateId}' is missing validationDatasetHash`);
    }

    const oosDatasetHash = art.oosDatasetHash;
    if (typeof oosDatasetHash !== 'string' || oosDatasetHash.trim() === '') {
      throw new Error(`OOS_DATASET_HASH_MISSING: Candidate '${candidateId}' is missing oosDatasetHash`);
    }

    // 9. Training Seed Validation
    const trainingSeed = art.trainingSeed;
    if (typeof trainingSeed !== 'number' || !Number.isFinite(trainingSeed)) {
      throw new Error(`TRAINING_SEED_MISSING: Candidate '${candidateId}' is missing valid numeric trainingSeed`);
    }

    // 10. Artifact Cryptographic Integrity (Mandatory Artifact Hash)
    const canonicalPayload = {
      candidateId,
      candidateVersion,
      modelId: art.modelId,
      modelVersion: art.modelVersion,
      strategyVersion,
      artifactVersion: art.artifactVersion,
      featureSchemaVersion,
      featureSchemaHash,
      selectedFeatures,
      selectedFeatureHash: art.selectedFeatureHash,
      scalerHash,
      modelHash,
      trainingDatasetHash,
      validationDatasetHash,
      oosDatasetHash,
      marketDatasetHash: art.marketDatasetHash,
      ...(art.developmentMarketDatasetHash ? { developmentMarketDatasetHash: art.developmentMarketDatasetHash } : {}),
      ...(art.trainingMarketDatasetHash ? { trainingMarketDatasetHash: art.trainingMarketDatasetHash } : {}),
      ...(art.validationMarketDatasetHash ? { validationMarketDatasetHash: art.validationMarketDatasetHash } : {}),
      ...(art.oosMarketDatasetHash ? { oosMarketDatasetHash: art.oosMarketDatasetHash } : {}),
      ...(art.trainingExperienceDatasetHash ? { trainingExperienceDatasetHash: art.trainingExperienceDatasetHash } : {}),
      ...(art.validationExperienceDatasetHash ? { validationExperienceDatasetHash: art.validationExperienceDatasetHash } : {}),
      ...(art.oosExperienceDatasetHash ? { oosExperienceDatasetHash: art.oosExperienceDatasetHash } : {}),
      datasetHash,
      configHash: execConfig.configHash,
      trainingSeed,
      riskConfig,
      executionConfig: execConfig,
      strategyConfig: stratConfig,
      productionEligible: art.productionEligible,
      executionContext: art.executionContext,
      executionContextHash: art.executionContextHash,
      executionContextVersion: art.executionContextVersion,
    };

    const computedArtifactHash = createHash('sha256')
      .update(canonicalJsonStringify(canonicalPayload))
      .digest('hex');
    if (typeof art.artifactHash !== 'string' || art.artifactHash.trim() === '') {
      throw new Error(`ARTIFACT_HASH_MISSING: Candidate '${candidateId}' is missing artifactHash`);
    }
    if (art.artifactHash !== computedArtifactHash) {
      throw new Error(
        `ARTIFACT_HASH_MISMATCH: Candidate '${candidateId}' expected ${computedArtifactHash}, got ${art.artifactHash}`,
      );
    }

    const validated: ValidatedCandidateArtifact = Object.freeze({
      ...art,
      _brand: 'ValidatedCandidateArtifact',
      symbol,
      riskConfig: riskConfig as CandidateRiskConfig,
      executionConfig: execConfig as CandidateExecutionConfig,
      strategyConfig: stratConfig as CandidateStrategyConfig,
    } as ValidatedCandidateArtifact);

    return validated;
  }
}
