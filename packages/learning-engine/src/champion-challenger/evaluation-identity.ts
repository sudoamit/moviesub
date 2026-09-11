import { createHash } from 'crypto';
import { canonicalJsonStringify } from '../canonical-serializer';
import {
  EvaluationIdentity,
  EvaluationBundle,
  EvaluationMetrics,
  TradeStatistics,
  RiskStatistics,
  CostStatistics,
} from './types';

/**
 * Deep freezes an object recursively to guarantee immutability.
 */
export function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as any)[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * Validates and creates an immutable EvaluationIdentity.
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
  executionConfigVersion: string;
  executionConfigHash: string;
  riskConfigVersion: string;
  riskConfigHash: string;
  costConfigVersion: string;
  costConfigHash: string;
  partialExitPolicyVersion: string;
  strategyConfigVersion: string;
  evaluationWindowStart: number;
  evaluationWindowEnd: number;
  randomSeed: number;
  createdAt?: number;
}): EvaluationIdentity {
  const requiredStringFields: (keyof typeof params)[] = [
    'modelId',
    'modelVersion',
    'artifactHash',
    'trainingRunId',
    'datasetVersion',
    'datasetHash',
    'featureVersion',
    'featureSchemaHash',
    'labelVersion',
    'codeCommit',
    'walkForwardConfigVersion',
    'executionConfigVersion',
    'executionConfigHash',
    'riskConfigVersion',
    'riskConfigHash',
    'costConfigVersion',
    'costConfigHash',
    'partialExitPolicyVersion',
    'strategyConfigVersion',
  ];

  for (const field of requiredStringFields) {
    const val = params[field];
    if (typeof val !== 'string' || val.trim() === '') {
      throw new Error(`INVALID_EVALUATION_IDENTITY: Missing or invalid required string field "${field}"`);
    }
  }

  if (typeof params.evaluationWindowStart !== 'number' || !Number.isFinite(params.evaluationWindowStart) || params.evaluationWindowStart <= 0) {
    throw new Error('INVALID_EVALUATION_IDENTITY: evaluationWindowStart must be a positive finite number');
  }
  if (typeof params.evaluationWindowEnd !== 'number' || !Number.isFinite(params.evaluationWindowEnd) || params.evaluationWindowEnd <= 0) {
    throw new Error('INVALID_EVALUATION_IDENTITY: evaluationWindowEnd must be a positive finite number');
  }
  if (params.evaluationWindowEnd <= params.evaluationWindowStart) {
    throw new Error(
      `INVALID_EVALUATION_IDENTITY: evaluationWindowEnd (${params.evaluationWindowEnd}) must be greater than evaluationWindowStart (${params.evaluationWindowStart})`,
    );
  }
  if (typeof params.randomSeed !== 'number' || !Number.isFinite(params.randomSeed)) {
    throw new Error('INVALID_EVALUATION_IDENTITY: randomSeed must be a finite number');
  }

  const evaluationId = params.evaluationId || `eval_${params.modelId}_${params.evaluationWindowStart}_${params.randomSeed}`;
  const createdAt = params.createdAt ?? Date.now();

  const identity: EvaluationIdentity = {
    evaluationId,
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
    executionConfigVersion: params.executionConfigVersion,
    executionConfigHash: params.executionConfigHash,
    riskConfigVersion: params.riskConfigVersion,
    riskConfigHash: params.riskConfigHash,
    costConfigVersion: params.costConfigVersion,
    costConfigHash: params.costConfigHash,
    partialExitPolicyVersion: params.partialExitPolicyVersion,
    strategyConfigVersion: params.strategyConfigVersion,
    evaluationWindowStart: params.evaluationWindowStart,
    evaluationWindowEnd: params.evaluationWindowEnd,
    randomSeed: params.randomSeed,
    createdAt,
  };

  return deepFreeze(identity);
}

/**
 * Computes a deterministic SHA-256 fingerprint from an EvaluationIdentity.
 */
export function computeEvaluationFingerprint(identity: EvaluationIdentity): string {
  const canonicalString = canonicalJsonStringify(identity);
  return createHash('sha256').update(canonicalString).digest('hex');
}

/**
 * Creates an immutable EvaluationBundle encapsulating evaluation identity, fingerprint, and results.
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

  const evaluationFingerprint = computeEvaluationFingerprint(params.evaluationIdentity);

  const bundle: EvaluationBundle = {
    evaluationIdentity: params.evaluationIdentity,
    evaluationFingerprint,
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
