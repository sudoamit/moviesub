import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CandidateArtifact, ShadowEvaluationMetrics } from './types';
import { canonicalJsonStringify } from './canonical-serializer';
import { assertCompatibleExecutionContexts } from './execution-context';
import { CandidateBacktestRunner } from './candidate-backtest-runner';
import { ModelRegistry } from './model-registry';
import { ProductionModelActivator } from './production-model-activator';

export type ChallengerLifecycleState =
  | 'CHALLENGER_CREATED'
  | 'TRAINING_COMPLETE'
  | 'VALIDATION_COMPLETE'
  | 'WFV_COMPLETE'
  | 'OOS_COMPLETE'
  | 'ROBUSTNESS_COMPLETE'
  | 'SHADOW_RUNNING'
  | 'SHADOW_COMPLETE'
  | 'PROMOTION_ELIGIBLE'
  | 'PROMOTED'
  | 'VALIDATION_FAILED'
  | 'WFV_FAILED'
  | 'OOS_FAILED'
  | 'ROBUSTNESS_FAILED'
  | 'SHADOW_FAILED'
  | 'PROMOTION_REJECTED'
  | 'INVALIDATED';

export type ChampionArtifact = CandidateArtifact;
export type ChallengerArtifact = CandidateArtifact;
export type ShadowEvaluation = ShadowEvaluationMetrics;
export type PromotionGateResult = Phase10PromotionDecision;

const VALID_TRANSITIONS: Record<ChallengerLifecycleState, readonly ChallengerLifecycleState[]> = {
  CHALLENGER_CREATED: ['TRAINING_COMPLETE', 'VALIDATION_FAILED', 'INVALIDATED'],
  TRAINING_COMPLETE: ['VALIDATION_COMPLETE', 'VALIDATION_FAILED', 'INVALIDATED'],
  VALIDATION_COMPLETE: ['WFV_COMPLETE', 'WFV_FAILED', 'INVALIDATED'],
  WFV_COMPLETE: ['OOS_COMPLETE', 'OOS_FAILED', 'INVALIDATED'],
  OOS_COMPLETE: ['ROBUSTNESS_COMPLETE', 'ROBUSTNESS_FAILED', 'INVALIDATED'],
  ROBUSTNESS_COMPLETE: ['SHADOW_RUNNING', 'ROBUSTNESS_FAILED', 'INVALIDATED'],
  SHADOW_RUNNING: ['SHADOW_COMPLETE', 'SHADOW_FAILED', 'INVALIDATED'],
  SHADOW_COMPLETE: ['PROMOTION_ELIGIBLE', 'PROMOTION_REJECTED', 'INVALIDATED'],
  PROMOTION_ELIGIBLE: ['PROMOTED', 'PROMOTION_REJECTED', 'INVALIDATED'],
  PROMOTED: [],
  VALIDATION_FAILED: ['INVALIDATED'],
  WFV_FAILED: ['INVALIDATED'],
  OOS_FAILED: ['INVALIDATED'],
  ROBUSTNESS_FAILED: ['INVALIDATED'],
  SHADOW_FAILED: ['INVALIDATED'],
  PROMOTION_REJECTED: [],
  INVALIDATED: [],
};

export interface ChampionSnapshot {
  readonly snapshotId: string;
  readonly artifactId: string;
  readonly artifactHash: string;
  readonly modelHash: string;
  readonly executionContextHash: string;
  readonly executionContextVersion: string;
  readonly datasetHash: string;
  readonly baselineMetrics: Readonly<Record<string, number>>;
  readonly promotionHistoryReference?: string;
  readonly snapshotTimestamp: number;
  readonly snapshotHash: string;
}

export interface ChallengerEvidence {
  readonly validation?: Readonly<Record<string, number>>;
  readonly wfv?: Readonly<Record<string, number>>;
  readonly oos?: Readonly<Record<string, number>>;
  readonly robustness?: Readonly<Record<string, number>>;
  readonly shadow?: ShadowEvaluationMetrics;
}

export interface ChallengerEvaluation {
  readonly evaluationId: string;
  readonly challengerArtifactId: string;
  readonly championArtifactId: string;
  readonly championArtifactHash: string;
  readonly championSnapshotHash: string;
  readonly challengerArtifactHash: string;
  readonly executionContextHash: string;
  readonly executionContextVersion: string;
  readonly datasetHash: string;
  readonly mode: 'SHADOW';
  readonly marketDataCutoffTimestamp: number;
  readonly championBaselineMetrics: Readonly<Record<string, number>>;
  readonly validationEvidence?: Readonly<Record<string, number>>;
  readonly wfvEvidence?: Readonly<Record<string, number>>;
  readonly oosEvidence?: Readonly<Record<string, number>>;
  readonly robustnessEvidence?: Readonly<Record<string, number>>;
  readonly shadowEvidence?: ShadowEvaluationMetrics;
  readonly state: ChallengerLifecycleState;
  readonly evaluationVersion: string;
  readonly evaluatorVersion: string;
  readonly createdAt: number;
  readonly completedAt?: number;
  readonly evidenceHash: string;
}

export interface PromotionGateRules {
  readonly gateVersion: string;
  readonly minimumValidationExpectancy?: number;
  readonly minimumWFVExpectancy?: number;
  readonly minimumOOSExpectancy?: number;
  readonly minimumShadowExpectancy?: number;
  readonly minimumShadowTrades?: number;
  readonly maximumShadowDrawdownR?: number;
  readonly minimumPerformanceImprovement?: number;
  readonly requirePositiveNetPnL?: boolean;
  readonly maximumRiskPerTrade?: number;
}

export interface Phase10PromotionDecision {
  readonly decision: 'PROMOTE' | 'REJECT' | 'INSUFFICIENT_EVIDENCE';
  readonly reasonCodes: readonly string[];
  readonly evidenceHash: string;
  readonly promotionGateVersion: string;
  readonly championSnapshotHash: string;
  readonly challengerArtifactHash: string;
  readonly executionContextHash: string;
  readonly decisionTimestamp: number;
  readonly decidedBy: string;
}

function freeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  return value;
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJsonStringify(value)).digest('hex');
}

export class ChampionChallengerCoordinator {
  public static readonly EVALUATION_VERSION = 'phase10-evaluation-v1';
  public static readonly EVALUATOR_VERSION = 'phase10-coordinator-v1';
  private static evaluations = new Map<string, ChallengerEvaluation>();
  private static decisions = new Map<string, Phase10PromotionDecision>();
  private static snapshots = new Map<string, ChampionSnapshot>();
  private static persistencePath: string | null = null;

  public static reset(): void {
    this.evaluations.clear();
    this.decisions.clear();
    this.snapshots.clear();
    this.persistencePath = null;
  }

  public static setPersistencePath(filePath: string | null): void {
    this.persistencePath = filePath;
    if (filePath && fs.existsSync(filePath)) this.loadFromFile(filePath);
  }

  public static saveToFile(filePath = this.persistencePath): void {
    if (!filePath) throw new Error('PERSISTENCE_NOT_CONFIGURED: Phase 10 store requires a file path');
    const data = {
      version: '1.0',
      snapshots: Array.from(this.snapshots.entries()),
      evaluations: Array.from(this.evaluations.entries()),
      decisions: Array.from(this.decisions.entries()),
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp.${randomUUID()}`;
    fs.writeFileSync(temporaryPath, JSON.stringify(data), 'utf8');
    fs.renameSync(temporaryPath, filePath);
  }

  public static loadFromFile(filePath: string): void {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    if (data.version !== '1.0' || !Array.isArray(data.snapshots) || !Array.isArray(data.evaluations) || !Array.isArray(data.decisions)) {
      throw new Error('INVALID_PHASE10_STORE: Invalid Champion/Challenger persistence payload');
    }
    this.snapshots = new Map(data.snapshots as [string, ChampionSnapshot][]);
    this.evaluations = new Map(data.evaluations as [string, ChallengerEvaluation][]);
    this.decisions = new Map(data.decisions as [string, Phase10PromotionDecision][]);
    this.persistencePath = filePath;
  }

  public static captureChampionSnapshot(
    champion: CandidateArtifact,
    datasetHash: string,
    baselineMetrics: Readonly<Record<string, number>>,
    promotionHistoryReference?: string,
    snapshotTimestamp = Date.now(),
  ): ChampionSnapshot {
    const validated = CandidateBacktestRunner.validateArtifactIntegrity(champion);
    if (!validated.isValid) throw new Error(`INVALID_CHAMPION_ARTIFACT: ${validated.reason}`);
    if (champion.productionEligible !== true) throw new Error('CHAMPION_NOT_PRODUCTION_ELIGIBLE');
    const payload = {
      artifactId: champion.artifactId,
      artifactHash: champion.artifactHash,
      modelHash: champion.modelHash,
      executionContextHash: champion.executionContextHash,
      executionContextVersion: champion.executionContextVersion,
      datasetHash,
      baselineMetrics,
      promotionHistoryReference,
      snapshotTimestamp,
    };
    const snapshot = freeze({
      snapshotId: `champion-snapshot-${randomUUID()}`,
      ...payload,
      snapshotHash: hash(payload),
    });
    this.snapshots.set(snapshot.snapshotId, snapshot);
    this.saveIfConfigured();
    return snapshot;
  }

  public static createEvaluation(
    champion: ChampionSnapshot,
    challenger: CandidateArtifact,
    datasetHash: string,
    marketDataCutoffTimestamp: number,
    createdAt = Date.now(),
  ): ChallengerEvaluation {
    if (challenger.productionEligible !== true) throw new Error('CHALLENGER_NOT_PRODUCTION_ELIGIBLE');
    if (champion.artifactHash === challenger.artifactHash) throw new Error('CHALLENGER_MUST_DIFFER_FROM_CHAMPION');
    if (champion.executionContextVersion !== challenger.executionContextVersion) {
      throw new Error('INCOMPATIBLE_EXECUTION_CONTEXT_VERSION');
    }
    if (champion.executionContextHash !== challenger.executionContextHash) {
      throw new Error('INCOMPATIBLE_EXECUTION_CONTEXT');
    }
    assertCompatibleExecutionContexts(championContext(champion), challenger.executionContext);
    if (marketDataCutoffTimestamp <= 0) throw new Error('INVALID_MARKET_DATA_CUTOFF');
    const evaluation: ChallengerEvaluation = {
      evaluationId: `challenger-evaluation-${randomUUID()}`,
      challengerArtifactId: challenger.artifactId,
      championArtifactId: champion.artifactId,
      championArtifactHash: champion.artifactHash,
      championSnapshotHash: champion.snapshotHash,
      challengerArtifactHash: challenger.artifactHash,
      executionContextHash: challenger.executionContextHash,
      executionContextVersion: challenger.executionContextVersion,
      datasetHash,
      mode: 'SHADOW',
      marketDataCutoffTimestamp,
      championBaselineMetrics: champion.baselineMetrics,
      state: 'CHALLENGER_CREATED',
      evaluationVersion: this.EVALUATION_VERSION,
      evaluatorVersion: this.EVALUATOR_VERSION,
      createdAt,
      evidenceHash: hash({ champion, challengerArtifactHash: challenger.artifactHash, datasetHash, marketDataCutoffTimestamp }),
    };
    const frozen = freeze(evaluation);
    this.evaluations.set(evaluation.evaluationId, frozen);
    this.saveIfConfigured();
    return frozen;
  }

  public static getEvaluation(evaluationId: string): ChallengerEvaluation | undefined {
    return this.evaluations.get(evaluationId);
  }

  public static transition(evaluationId: string, nextState: ChallengerLifecycleState): ChallengerEvaluation {
    const current = this.requireEvaluation(evaluationId);
    if (!VALID_TRANSITIONS[current.state].includes(nextState)) {
      throw new Error(`ILLEGAL_CHALLENGER_TRANSITION: ${current.state} -> ${nextState}`);
    }
    const next = freeze({
      ...current,
      state: nextState,
      completedAt: ['PROMOTION_ELIGIBLE', 'PROMOTED', 'PROMOTION_REJECTED', 'INVALIDATED'].includes(nextState)
        ? Date.now()
        : current.completedAt,
    });
    this.evaluations.set(evaluationId, next);
    this.saveIfConfigured();
    return next;
  }

  public static recordEvidence(
    evaluationId: string,
    stage: 'validation' | 'wfv' | 'oos' | 'robustness' | 'shadow',
    evidence: Readonly<Record<string, number>> | ShadowEvaluationMetrics,
    cutoffTimestamp: number,
  ): ChallengerEvaluation {
    const current = this.requireEvaluation(evaluationId);
    if (cutoffTimestamp !== current.marketDataCutoffTimestamp) throw new Error('MARKET_DATA_CUTOFF_MISMATCH');
    if (stage === 'shadow' && current.state !== 'SHADOW_RUNNING') throw new Error('SHADOW_NOT_RUNNING');
    const next = freeze({
      ...current,
      [`${stage}Evidence`]: evidence,
      evidenceHash: hash({ ...current, [`${stage}Evidence`]: evidence }),
    });
    this.evaluations.set(evaluationId, next);
    this.saveIfConfigured();
    return next;
  }

  public static evaluatePromotion(
    evaluationId: string,
    rules: PromotionGateRules,
    decidedBy: string,
    timestamp = Date.now(),
  ): Phase10PromotionDecision {
    const evaluation = this.requireEvaluation(evaluationId);
    if (evaluation.state !== 'SHADOW_COMPLETE') throw new Error('PROMOTION_REQUIRES_SHADOW_COMPLETE');
    const reasons: string[] = [];
    const challengerArtifact = ModelRegistry.listArtifacts().find((artifact) => artifact.artifactId === evaluation.challengerArtifactId);
    if (!challengerArtifact || !CandidateBacktestRunner.validateArtifactIntegrity(challengerArtifact).isValid) reasons.push('CHALLENGER_ARTIFACT_INTEGRITY_FAILED');
    const challengerRiskPerTrade = challengerArtifact ? Number(challengerArtifact.riskConfig.maxRiskPerTrade) : undefined;
    if (rules.maximumRiskPerTrade !== undefined && challengerRiskPerTrade !== undefined && Number.isFinite(challengerRiskPerTrade) && challengerRiskPerTrade > rules.maximumRiskPerTrade) reasons.push('RISK_CONSTRAINT_EXCEEDED');
    const validation = evaluation.validationEvidence?.expectancy;
    const wfv = evaluation.wfvEvidence?.expectancy;
    const oos = evaluation.oosEvidence?.expectancy;
    const shadow = evaluation.shadowEvidence;
    if (validation === undefined || wfv === undefined || oos === undefined || !shadow) reasons.push('INSUFFICIENT_EVIDENCE');
    if (rules.minimumValidationExpectancy !== undefined && (validation === undefined || validation < rules.minimumValidationExpectancy)) reasons.push('VALIDATION_BELOW_THRESHOLD');
    if (rules.minimumWFVExpectancy !== undefined && (wfv === undefined || wfv < rules.minimumWFVExpectancy)) reasons.push('WFV_BELOW_THRESHOLD');
    if (rules.minimumOOSExpectancy !== undefined && (oos === undefined || oos < rules.minimumOOSExpectancy)) reasons.push('OOS_BELOW_THRESHOLD');
    if (rules.minimumShadowExpectancy !== undefined && (!shadow || shadow.expectancy < rules.minimumShadowExpectancy)) reasons.push('SHADOW_BELOW_THRESHOLD');
    if (rules.minimumShadowTrades !== undefined && (!shadow || shadow.totalTrades < rules.minimumShadowTrades)) reasons.push('SHADOW_TRADES_BELOW_THRESHOLD');
    if (rules.maximumShadowDrawdownR !== undefined && shadow && shadow.maxDrawdownR > rules.maximumShadowDrawdownR) reasons.push('SHADOW_DRAWDOWN_ABOVE_THRESHOLD');
    if (rules.minimumPerformanceImprovement !== undefined && (oos === undefined || oos - (evaluation.championBaselineMetrics.expectancy || 0) < rules.minimumPerformanceImprovement)) reasons.push('PERFORMANCE_IMPROVEMENT_BELOW_THRESHOLD');
    if (rules.requirePositiveNetPnL && (!shadow || shadow.netPnL <= 0)) reasons.push('SHADOW_NET_PNL_NOT_POSITIVE');
    const decision: Phase10PromotionDecision = freeze({
      decision: reasons.length === 0 ? 'PROMOTE' : reasons.includes('INSUFFICIENT_EVIDENCE') ? 'INSUFFICIENT_EVIDENCE' : 'REJECT',
      reasonCodes: reasons,
      evidenceHash: evaluation.evidenceHash,
      promotionGateVersion: rules.gateVersion,
      championSnapshotHash: evaluation.championSnapshotHash,
      challengerArtifactHash: evaluation.challengerArtifactHash,
      executionContextHash: evaluation.executionContextHash,
      decisionTimestamp: timestamp,
      decidedBy,
    });
    this.decisions.set(evaluationId, decision);
    this.saveIfConfigured();
    this.transition(evaluationId, decision.decision === 'PROMOTE' ? 'PROMOTION_ELIGIBLE' : 'PROMOTION_REJECTED');
    return decision;
  }

  public static getDecision(evaluationId: string): Phase10PromotionDecision | undefined {
    return this.decisions.get(evaluationId);
  }

  public static promote(evaluationId: string, options: Parameters<typeof ProductionModelActivator.activateCandidate>[0]): ReturnType<typeof ProductionModelActivator.activateCandidate> {
    const evaluation = this.requireEvaluation(evaluationId);
    const decision = this.decisions.get(evaluationId);
    if (evaluation.state !== 'PROMOTION_ELIGIBLE' || !decision || decision.decision !== 'PROMOTE') {
      throw new Error('PROMOTION_NOT_ELIGIBLE');
    }
    if (options.candidateId !== evaluation.challengerArtifactId) throw new Error('CHALLENGER_ID_MISMATCH');
    const state = ProductionModelActivator.activateCandidate(options);
    this.transition(evaluationId, 'PROMOTED');
    this.saveIfConfigured();
    return state;
  }

  private static saveIfConfigured(): void {
    if (this.persistencePath) this.saveToFile(this.persistencePath);
  }

  private static requireEvaluation(evaluationId: string): ChallengerEvaluation {
    const evaluation = this.evaluations.get(evaluationId);
    if (!evaluation) throw new Error(`CHALLENGER_EVALUATION_NOT_FOUND: ${evaluationId}`);
    return evaluation;
  }
}

function championContext(snapshot: ChampionSnapshot): CandidateArtifact['executionContext'] {
  const artifact = ModelRegistry.listArtifacts().find((candidate) => candidate.artifactId === snapshot.artifactId);
  if (!artifact) throw new Error(`CHAMPION_ARTIFACT_NOT_FOUND: ${snapshot.artifactId}`);
  if (artifact.artifactHash !== snapshot.artifactHash) throw new Error('CHAMPION_SNAPSHOT_ARTIFACT_MISMATCH');
  return artifact.executionContext;
}
