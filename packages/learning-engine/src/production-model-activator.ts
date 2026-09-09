import {
  CandidateArtifact,
  ProductionModelState,
  PromotionDecision,
  PromotionEvidence,
  PromotionPolicy,
} from './types';
import { ModelRegistry } from './model-registry';
import { CandidateBacktestRunner } from './candidate-backtest-runner';

export interface IActivateCandidateOptions {
  candidateId: string;
  promotionDecision: PromotionDecision;
  policy: PromotionPolicy;
  environment?: 'paper' | 'live';
  strategyId?: string;
  operatorNotes?: string;
}

export interface IRollbackProductionOptions {
  strategyId?: string;
  environment?: 'paper' | 'live';
  targetCandidateId?: string;
  reason: string;
}

export class ProductionModelActivator {
  /**
   * Atomically activates an approved candidate into authoritative production state.
   * Enforces fail-closed validation, lock acquisition, integrity checks, and evidence recording.
   */
  public static activateCandidate(options: IActivateCandidateOptions): ProductionModelState {
    const strategyId = options.strategyId ?? 'smc-quant-baseline';
    const environment = options.environment ?? 'paper';

    if (!options.candidateId) {
      throw new Error('INVALID_ACTIVATION: candidateId is required');
    }

    if (!options.promotionDecision || options.promotionDecision.decision !== 'PROMOTE') {
      throw new Error(
        `PROMOTION_NOT_APPROVED: Candidate ${options.candidateId} cannot be activated because promotion decision was '${options.promotionDecision?.decision ?? 'MISSING'}': ${options.promotionDecision?.reasons.join(', ') || 'No reason provided'}`,
      );
    }

    const candidate = ModelRegistry.getCandidateArtifact(options.candidateId);
    if (!candidate) {
      throw new Error(`CANDIDATE_NOT_FOUND: Candidate ${options.candidateId} not found in model registry`);
    }

    if (candidate.status === 'PROMOTED') {
      const currentState = ModelRegistry.getProductionState(strategyId, environment);
      if (currentState?.activeCandidateId === candidate.candidateId) {
        return currentState;
      }
    }

    // Acquire activation concurrency lock
    const lockAcquired = ModelRegistry.acquireActivationLock(strategyId, environment);
    if (!lockAcquired) {
      throw new Error(
        `CONCURRENT_ACTIVATION_IN_PROGRESS: Activation lock already held for strategy ${strategyId} in ${environment}`,
      );
    }

    try {
      // Re-verify artifact cryptographic integrity
      const valResult = CandidateBacktestRunner.validateArtifactIntegrity(candidate);
      if (!valResult.isValid) {
        throw new Error(`ARTIFACT_INTEGRITY_VIOLATION: Candidate artifact tampered: ${valResult.reason}`);
      }

      const currentState = ModelRegistry.getProductionState(strategyId, environment);

      // Retire previous active model if present
      if (currentState?.activeCandidateId && currentState.activeCandidateId !== candidate.candidateId) {
        try {
          const prevArtifact = ModelRegistry.getCandidateArtifact(currentState.activeCandidateId);
          if (prevArtifact && prevArtifact.status === 'PROMOTED') {
            ModelRegistry.updateCandidateStatus(
              currentState.activeCandidateId,
              'RETIRED',
              `Superseded by activation of candidate ${candidate.candidateId}`,
            );
          }
        } catch {
          // If previous artifact is not in registry (e.g. baseline stub), proceed
        }
      }

      // Record promotion evidence
      const evidenceId = `ev-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      const evidence: PromotionEvidence = {
        evidenceId,
        candidateId: candidate.candidateId,
        artifactHash: candidate.artifactHash,
        trainingDatasetHash: candidate.trainingDatasetHash,
        validationDatasetHash: candidate.validationDatasetHash,
        oosDatasetHash: candidate.oosDatasetHash,
        shadowDatasetHash: candidate.marketDatasetHash,
        shadowWindowStart: 0,
        shadowWindowEnd: Date.now(),
        shadowMetrics: options.promotionDecision.metrics,
        promotionPolicyVersion: options.policy.policyVersion || 'v2.0',
        promotionDecision: options.promotionDecision.decision,
        decisionReasons: options.promotionDecision.reasons,
        evaluatedAt: options.promotionDecision.evaluatedAt,
      };
      ModelRegistry.savePromotionEvidence(evidence);

      // Transition candidate status to PROMOTED
      ModelRegistry.updateCandidateStatus(
        candidate.candidateId,
        'PROMOTED',
        `Promoted and activated to ${environment} for strategy ${strategyId}`,
      );

      // Atomically update production state
      const activationId = `act-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      const newProductionState: ProductionModelState = {
        strategyId,
        environment,
        activeCandidateId: candidate.candidateId,
        activeModelVersion: candidate.modelVersion,
        activeStrategyVersion: candidate.strategyVersion,
        activeArtifactHash: candidate.artifactHash,
        activatedAt: Date.now(),
        previousCandidateId: currentState?.activeCandidateId,
        previousArtifactHash: currentState?.activeArtifactHash,
        promotionEvidenceId: evidenceId,
        activationId,
      };

      ModelRegistry.setProductionState(newProductionState);

      return newProductionState;
    } finally {
      ModelRegistry.releaseActivationLock(strategyId, environment);
    }
  }

  /**
   * Rolls back production state to a target or previously active candidate artifact.
   * Does not retrain or recompute; restores verified immutable artifact state.
   */
  public static rollbackProduction(options: IRollbackProductionOptions): ProductionModelState {
    const strategyId = options.strategyId ?? 'smc-quant-baseline';
    const environment = options.environment ?? 'paper';

    const currentState = ModelRegistry.getProductionState(strategyId, environment);
    if (!currentState) {
      throw new Error(`NO_PRODUCTION_STATE: No production state found for strategy ${strategyId} in ${environment}`);
    }

    const targetCandidateId = options.targetCandidateId ?? currentState.previousCandidateId;
    if (!targetCandidateId) {
      throw new Error(
        `NO_ROLLBACK_TARGET: Cannot rollback strategy ${strategyId} in ${environment} because no previous or target candidateId exists`,
      );
    }

    const lockAcquired = ModelRegistry.acquireActivationLock(strategyId, environment);
    if (!lockAcquired) {
      throw new Error(
        `CONCURRENT_ACTIVATION_IN_PROGRESS: Rollback locked; another operation is active for ${strategyId} in ${environment}`,
      );
    }

    try {
      const targetArtifact = ModelRegistry.getCandidateArtifact(targetCandidateId);
      if (!targetArtifact) {
        throw new Error(
          `ROLLBACK_TARGET_NOT_FOUND: Rollback target candidate ${targetCandidateId} not found in model registry`,
        );
      }

      // Verify integrity of rollback target artifact
      const valResult = CandidateBacktestRunner.validateArtifactIntegrity(targetArtifact);
      if (!valResult.isValid) {
        throw new Error(
          `ARTIFACT_INTEGRITY_VIOLATION: Rollback target candidate ${targetCandidateId} failed integrity: ${valResult.reason}`,
        );
      }

      // Mark current candidate as ROLLED_BACK
      if (currentState.activeCandidateId) {
        try {
          ModelRegistry.updateCandidateStatus(
            currentState.activeCandidateId,
            'ROLLED_BACK',
            `Rolled back due to: ${options.reason}`,
          );
        } catch {
          // Ignore if previous active model not in registry
        }
      }

      // Mark target candidate as PROMOTED (reactivated)
      ModelRegistry.updateCandidateStatus(
        targetCandidateId,
        'PROMOTED',
        `Reactivated via rollback from ${currentState.activeCandidateId}. Reason: ${options.reason}`,
      );

      const rollbackActivationId = `rb-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      const rollbackState: ProductionModelState = {
        strategyId,
        environment,
        activeCandidateId: targetArtifact.candidateId,
        activeModelVersion: targetArtifact.modelVersion,
        activeStrategyVersion: targetArtifact.strategyVersion,
        activeArtifactHash: targetArtifact.artifactHash,
        activatedAt: Date.now(),
        previousCandidateId: currentState.activeCandidateId,
        previousArtifactHash: currentState.activeArtifactHash,
        activationId: rollbackActivationId,
      };

      ModelRegistry.setProductionState(rollbackState);

      return rollbackState;
    } finally {
      ModelRegistry.releaseActivationLock(strategyId, environment);
    }
  }
}
