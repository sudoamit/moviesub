import { createHash, randomUUID } from 'crypto';
import { canonicalJsonStringify } from '../canonical-serializer';
import {
  EvaluationIdentity,
  EvaluationBundle,
  EvaluationMetrics,
  TradeStatistics,
  RiskStatistics,
  CostStatistics
} from './types';

/**
 * Deep freezes an object and all nested properties recursively without using unsafe casts.
 */
export function deepFreeze<T extends object>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = Reflect.get(obj, key);
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * Deterministic evaluation input parameter structure used strictly for computing
 * the reproducible evaluation fingerprint.
 * Excludes non-deterministic runtime metadata such as evaluationId and createdAt.
 */
export interface EvaluationInputParameters {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly artifactHash: string;
  readonly trainingRunId: string;
  readonly datasetVersion: string;
  readonly datasetHash: string;
  readonly featureVersion: string;
  readonly featureSchemaHash: string;
  readonly labelVersion: string;
  readonly codeCommit: string;
  readonly walkForwardConfigVersion: string;
  readonly walkForwardConfigHash: string;
  readonly executionConfigVersion: string;
  readonly executionConfigHash: string;
  readonly riskConfigVersion: string;
  readonly riskConfigHash: string;
  readonly costConfigVersion: string;
  readonly costConfigHash: string;
  readonly partialExitPolicyVersion: string;
  readonly partialExitPolicyHash: string;
  readonly strategyConfigVersion: string;
  readonly strategyConfigHash: string;
  readonly evaluationWindowStart: number;
  readonly evaluationWindowEnd: number;
  readonly randomSeed: number;
}

/**
 * Computes a deterministic SHA-256 evaluation fingerprint from evaluation input parameters.
 * Crucially, this ONLY includes immutable evaluation inputs and ignores runtime metadata
 * (e.g., evaluationId, createdAt, timestamps).
 */
export function computeEvaluationFingerprint(
  identity: EvaluationIdentity | EvaluationInputParameters
): string {
  const pureInputs: EvaluationInputParameters = {
    modelId: identity.modelId,
    modelVersion: identity.modelVersion,
    artifactHash: identity.artifactHash,
    trainingRunId: identity.trainingRunId,
    datasetVersion: identity.datasetVersion,
    datasetHash: identity.datasetHash,
    featureVersion: identity.featureVersion,
    featureSchemaHash: identity.featureSchemaHash,
    labelVersion: identity.labelVersion,
    codeCommit: identity.codeCommit,
    walkForwardConfigVersion: identity.walkForwardConfigVersion,
    walkForwardConfigHash: identity.walkForwardConfigHash,
    executionConfigVersion: identity.executionConfigVersion,
    executionConfigHash: identity.executionConfigHash,
    riskConfigVersion: identity.riskConfigVersion,
    riskConfigHash: identity.riskConfigHash,
    costConfigVersion: identity.costConfigVersion,
    costConfigHash: identity.costConfigHash,
    partialExitPolicyVersion: identity.partialExitPolicyVersion,
    partialExitPolicyHash: identity.partialExitPolicyHash,
    strategyConfigVersion: identity.strategyConfigVersion,
    strategyConfigHash: identity.strategyConfigHash,
    evaluationWindowStart: identity.evaluationWindowStart,
    evaluationWindowEnd: identity.evaluationWindowEnd,
    randomSeed: identity.randomSeed,
  };

  const canonicalString = canonicalJsonStringify(pureInputs);
  return createHash('sha256').update(canonicalString).digest('hex');
}

/**
 * Computes a cryptographic SHA-256 hash covering the evaluation results (metrics, statistics, validation).
 */
export function computeResultHash(params: {
  metrics: EvaluationMetrics;
  tradeStatistics: TradeStatistics;
  riskStatistics: RiskStatistics;
  costStatistics: CostStatistics;
  walkForwardStatistics?: Readonly<Record<string, unknown>>;
  perWindowResults?: ReadonlyArray<Record<string, unknown>>;
  validationResults?: Readonly<Record<string, unknown>>;
}): string {
  const canonicalString = canonicalJsonStringify({
    metrics: params.metrics,
    tradeStatistics: params.tradeStatistics,
    riskStatistics: params.riskStatistics,
    costStatistics: params.costStatistics,
    walkForwardStatistics: params.walkForwardStatistics || null,
    perWindowResults: params.perWindowResults || null,
    validationResults: params.validationResults || null,
  });
  return createHash('sha256').update(canonicalString).digest('hex');
}

/**
 * Computes a complete cryptographic bundle hash combining evaluation fingerprint and result hash.
 */
export function computeBundleHash(fingerprint: string, resultHash: string): string {
  const canonicalString = canonicalJsonStringify({
    evaluationFingerprint: fingerprint,
    resultHash,
  });
  return createHash('sha256').update(canonicalString).digest('hex');
}

/**
 * Creates and deep-freezes an EvaluationIdentity.
 */
export function createEvaluationIdentity(params: {
  evaluationId?: string;
  modelId: string;
  modelVersion: string;
  artifactHash: string;
  trainingRunId: string;
  datasetVersion: string;
  datasetHash: string;
  featureVersion: string;
  featureSchemaHash: string;
  labelVersion: string;
  codeCommit: string;
  walkForwardConfigVersion: string;
  walkForwardConfigHash: string;
  executionConfigVersion: string;
  executionConfigHash: string;
  riskConfigVersion: string;
  riskConfigHash: string;
  costConfigVersion: string;
  costConfigHash: string;
  partialExitPolicyVersion: string;
  partialExitPolicyHash: string;
  strategyConfigVersion: string;
  strategyConfigHash: string;
  evaluationWindowStart: number;
  evaluationWindowEnd: number;
  randomSeed: number;
  createdAt?: number;
}): EvaluationIdentity {
  // Validate all mandatory fields
  const requiredStringFields: Array<[string, string]> = [
    ['modelId', params.modelId],
    ['modelVersion', params.modelVersion],
    ['artifactHash', params.artifactHash],
    ['trainingRunId', params.trainingRunId],
    ['datasetVersion', params.datasetVersion],
    ['datasetHash', params.datasetHash],
    ['featureVersion', params.featureVersion],
    ['featureSchemaHash', params.featureSchemaHash],
    ['labelVersion', params.labelVersion],
    ['codeCommit', params.codeCommit],
    ['walkForwardConfigVersion', params.walkForwardConfigVersion],
    ['walkForwardConfigHash', params.walkForwardConfigHash],
    ['executionConfigVersion', params.executionConfigVersion],
    ['executionConfigHash', params.executionConfigHash],
    ['riskConfigVersion', params.riskConfigVersion],
    ['riskConfigHash', params.riskConfigHash],
    ['costConfigVersion', params.costConfigVersion],
    ['costConfigHash', params.costConfigHash],
    ['partialExitPolicyVersion', params.partialExitPolicyVersion],
    ['partialExitPolicyHash', params.partialExitPolicyHash],
    ['strategyConfigVersion', params.strategyConfigVersion],
    ['strategyConfigHash', params.strategyConfigHash],
  ];

  for (const [name, val] of requiredStringFields) {
    if (!val || typeof val !== 'string' || val.trim() === '') {
      throw new Error(`INVALID_EVALUATION_IDENTITY: Missing or invalid required field '${name}'`);
    }
  }

  if (typeof params.evaluationWindowStart !== 'number' || typeof params.evaluationWindowEnd !== 'number') {
    throw new Error('INVALID_EVALUATION_IDENTITY: evaluationWindowStart and evaluationWindowEnd must be numbers');
  }

  if (params.evaluationWindowStart >= params.evaluationWindowEnd) {
    throw new Error('INVALID_EVALUATION_IDENTITY: evaluationWindowStart must be strictly less than evaluationWindowEnd');
  }

  if (typeof params.randomSeed !== 'number') {
    throw new Error('INVALID_EVALUATION_IDENTITY: randomSeed must be a number');
  }

  const identity: EvaluationIdentity = {
    evaluationId: params.evaluationId || `eval_${randomUUID()}`,
    modelId: params.modelId,
    modelVersion: params.modelVersion,
    artifactHash: params.artifactHash,
    trainingRunId: params.trainingRunId,
    datasetVersion: params.datasetVersion,
    datasetHash: params.datasetHash,
    featureVersion: params.featureVersion,
    featureSchemaHash: params.featureSchemaHash,
    labelVersion: params.labelVersion,
    codeCommit: params.codeCommit,
    walkForwardConfigVersion: params.walkForwardConfigVersion,
    walkForwardConfigHash: params.walkForwardConfigHash,
    executionConfigVersion: params.executionConfigVersion,
    executionConfigHash: params.executionConfigHash,
    riskConfigVersion: params.riskConfigVersion,
    riskConfigHash: params.riskConfigHash,
    costConfigVersion: params.costConfigVersion,
    costConfigHash: params.costConfigHash,
    partialExitPolicyVersion: params.partialExitPolicyVersion,
    partialExitPolicyHash: params.partialExitPolicyHash,
    strategyConfigVersion: params.strategyConfigVersion,
    strategyConfigHash: params.strategyConfigHash,
    evaluationWindowStart: params.evaluationWindowStart,
    evaluationWindowEnd: params.evaluationWindowEnd,
    randomSeed: params.randomSeed,
    createdAt: params.createdAt ?? Date.now(),
  };

  return deepFreeze(identity);
}

/**
 * Creates and deep-freezes an immutable EvaluationBundle with deterministic
 * evaluation fingerprint, resultHash, and bundleHash.
 */
export function createEvaluationBundle(params: {
  evaluationIdentity: EvaluationIdentity;
  modelMetadata?: Record<string, unknown>;
  metrics: EvaluationMetrics;
  tradeStatistics: TradeStatistics;
  riskStatistics: RiskStatistics;
  costStatistics: CostStatistics;
  walkForwardStatistics?: Record<string, unknown>;
  perWindowResults?: Array<Record<string, unknown>>;
  validationResults?: Record<string, unknown>;
  comparisonMetadata?: Record<string, unknown>;
}): EvaluationBundle {
  if (!params.evaluationIdentity) {
    throw new Error('INVALID_EVALUATION_BUNDLE: evaluationIdentity is required');
  }
  if (!params.metrics) {
    throw new Error('INVALID_EVALUATION_BUNDLE: metrics is required');
  }
  if (!params.tradeStatistics) {
    throw new Error('INVALID_EVALUATION_BUNDLE: tradeStatistics is required');
  }
  if (!params.riskStatistics) {
    throw new Error('INVALID_EVALUATION_BUNDLE: riskStatistics is required');
  }
  if (!params.costStatistics) {
    throw new Error('INVALID_EVALUATION_BUNDLE: costStatistics is required');
  }

  const fingerprint = computeEvaluationFingerprint(params.evaluationIdentity);
  const resultHash = computeResultHash({
    metrics: params.metrics,
    tradeStatistics: params.tradeStatistics,
    riskStatistics: params.riskStatistics,
    costStatistics: params.costStatistics,
    walkForwardStatistics: params.walkForwardStatistics,
    perWindowResults: params.perWindowResults,
    validationResults: params.validationResults,
  });
  const bundleHash = computeBundleHash(fingerprint, resultHash);

  const bundle: EvaluationBundle = {
    evaluationIdentity: params.evaluationIdentity,
    evaluationFingerprint: fingerprint,
    resultHash,
    bundleHash,
    modelMetadata: params.modelMetadata ? { ...params.modelMetadata } : {},
    metrics: { ...params.metrics },
    tradeStatistics: { ...params.tradeStatistics },
    riskStatistics: { ...params.riskStatistics },
    costStatistics: { ...params.costStatistics },
    walkForwardStatistics: params.walkForwardStatistics ? { ...params.walkForwardStatistics } : undefined,
    perWindowResults: params.perWindowResults ? [...params.perWindowResults] : undefined,
    validationResults: params.validationResults ? { ...params.validationResults } : undefined,
    comparisonMetadata: params.comparisonMetadata ? { ...params.comparisonMetadata } : undefined,
  };

  return deepFreeze(bundle);
}
