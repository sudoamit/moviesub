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

export type PromotionTransactionState =
  | 'PROMOTION_PREPARED'
  | 'PROMOTION_ACTIVATING'
  | 'PROMOTION_ACTIVATED'
  | 'PROMOTION_VERIFIED'
  | 'PROMOTION_COMMITTED'
  | 'PROMOTION_ROLLING_BACK'
  | 'PROMOTION_ROLLED_BACK'
  | 'PROMOTION_FAILED';

export interface ShadowEvidence extends ShadowEvaluationMetrics {
  readonly challengerArtifactHash: string;
  readonly championArtifactHash: string;
  readonly championSnapshotHash: string;
  readonly executionContextHash: string;
  readonly executionContextVersion: string;
  readonly datasetHash: string;
  readonly marketDataCutoffTimestamp: number;
  readonly shadowEvaluationVersion: string;
}

export interface PromotionJournal {
  readonly journalId: string;
  readonly evaluationId: string;
  readonly state: PromotionTransactionState;
  readonly previousChampionArtifactId?: string;
  readonly previousChampionArtifactHash: string;
  readonly previousModelHash: string;
  readonly previousExecutionContextHash: string;
  readonly previousExecutionContextVersion: string;
  readonly previousRegistryState: unknown;
  readonly previousProductionState?: unknown;
  readonly challengerArtifactHash: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly error?: string;
}

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
  readonly shadowEvidence?: ShadowEvidence;
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
  readonly maximumDrawdownIncrease?: number;
  readonly minimumProfitFactorImprovement?: number;
  readonly minimumTradeCount?: number;
  readonly minimumNetPnLImprovement?: number;
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
  private static journals = new Map<string, PromotionJournal>();
  private static persistencePath: string | null = null;

  public static reset(): void {
    this.evaluations.clear();
    this.decisions.clear();
    this.snapshots.clear();
    this.journals.clear();
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
      journals: Array.from(this.journals.entries()),
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp.${randomUUID()}`;
    fs.writeFileSync(temporaryPath, JSON.stringify(data), 'utf8');
    fs.renameSync(temporaryPath, filePath);
  }

  public static loadFromFile(filePath: string): void {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    if (data.version !== '1.0' || !Array.isArray(data.snapshots) || !Array.isArray(data.evaluations) || !Array.isArray(data.decisions) || !Array.isArray(data.journals)) {
      throw new Error('INVALID_PHASE10_STORE: Invalid Champion/Challenger persistence payload');
    }
    this.snapshots = new Map(data.snapshots as [string, ChampionSnapshot][]);
    this.evaluations = new Map(data.evaluations as [string, ChallengerEvaluation][]);
    this.decisions = new Map(data.decisions as [string, Phase10PromotionDecision][]);
    this.journals = new Map(data.journals as [string, PromotionJournal][]);
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
    if (champion.datasetHash !== datasetHash || challenger.datasetHash !== datasetHash) {
      throw new Error('DATASET_PROVENANCE_MISMATCH');
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
      evidenceHash: hash({ validationEvidence: undefined, wfvEvidence: undefined, oosEvidence: undefined, robustnessEvidence: undefined, shadowEvidence: undefined }),
    };
    const frozen = freeze(evaluation);
    this.evaluations.set(evaluation.evaluationId, frozen);
    this.saveIfConfigured();
    return frozen;
  }

  public static getEvaluation(evaluationId: string): ChallengerEvaluation | undefined {
    return this.evaluations.get(evaluationId);
  }

  public static getPromotionJournal(evaluationId: string): PromotionJournal | undefined {
    return this.journals.get(evaluationId);
  }

  public static recoverPromotionJournal(
    evaluationId: string,
    strategyId = 'smc-quant-baseline',
    environment: 'paper' | 'live' = 'paper',
  ): PromotionJournal {
    const journal = this.journals.get(evaluationId);
    if (!journal) throw new Error(`PROMOTION_JOURNAL_NOT_FOUND: ${evaluationId}`);
    const active = ModelRegistry.getProductionState(strategyId, environment);
    if (active?.activeArtifactHash === journal.challengerArtifactHash) {
      const recovered = freeze({ ...journal, state: 'PROMOTION_COMMITTED' as const, updatedAt: Date.now() });
      this.journals.set(evaluationId, recovered);
      this.saveIfConfigured();
      return recovered;
    }
    if (active?.activeArtifactHash === journal.previousChampionArtifactHash) {
      const recovered = freeze({ ...journal, state: 'PROMOTION_ROLLED_BACK' as const, updatedAt: Date.now() });
      this.journals.set(evaluationId, recovered);
      this.saveIfConfigured();
      return recovered;
    }
    const failed = freeze({ ...journal, state: 'PROMOTION_FAILED' as const, error: 'UNKNOWN_CHAMPION_STATE', updatedAt: Date.now() });
    this.journals.set(evaluationId, failed);
    this.saveIfConfigured();
    throw new Error('UNKNOWN_CHAMPION_STATE');
  }

  public static transition(evaluationId: string, nextState: ChallengerLifecycleState): ChallengerEvaluation {
    const current = this.requireEvaluation(evaluationId);
    if (!VALID_TRANSITIONS[current.state].includes(nextState)) {
      throw new Error(`ILLEGAL_CHALLENGER_TRANSITION: ${current.state} -> ${nextState}`);
    }
    const requiredEvidence: Partial<Record<ChallengerLifecycleState, keyof ChallengerEvaluation>> = {
      VALIDATION_COMPLETE: 'validationEvidence',
      WFV_COMPLETE: 'wfvEvidence',
      OOS_COMPLETE: 'oosEvidence',
      ROBUSTNESS_COMPLETE: 'robustnessEvidence',
      SHADOW_COMPLETE: 'shadowEvidence',
    };
    const evidenceKey = requiredEvidence[nextState];
    if (evidenceKey && !current[evidenceKey]) throw new Error(`INCOMPLETE_LIFECYCLE_EVIDENCE: ${nextState} requires ${evidenceKey}`);
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
    evidence: Readonly<Record<string, number>> | ShadowEvidence,
    cutoffTimestamp: number,
  ): ChallengerEvaluation {
    const current = this.requireEvaluation(evaluationId);
    if (cutoffTimestamp !== current.marketDataCutoffTimestamp) throw new Error('MARKET_DATA_CUTOFF_MISMATCH');
    const requiredState: Record<typeof stage, ChallengerLifecycleState> = {
      validation: 'TRAINING_COMPLETE',
      wfv: 'VALIDATION_COMPLETE',
      oos: 'WFV_COMPLETE',
      robustness: 'OOS_COMPLETE',
      shadow: 'SHADOW_RUNNING',
    };
    if (current.state !== requiredState[stage]) throw new Error(`INVALID_EVIDENCE_STAGE: ${stage} requires ${requiredState[stage]}, got ${current.state}`);
    if (stage === 'shadow') {
      const shadow = evidence as ShadowEvidence;
      if (
        shadow.challengerArtifactHash !== current.challengerArtifactHash ||
        shadow.championArtifactHash !== current.championArtifactHash ||
        shadow.championSnapshotHash !== current.championSnapshotHash ||
        shadow.executionContextHash !== current.executionContextHash ||
        shadow.executionContextVersion !== current.executionContextVersion ||
        shadow.datasetHash !== current.datasetHash ||
        shadow.marketDataCutoffTimestamp !== current.marketDataCutoffTimestamp
      ) throw new Error('SHADOW_EVIDENCE_PROVENANCE_MISMATCH');
    }
    const next = freeze({
      ...current,
      [`${stage}Evidence`]: evidence,
      evidenceHash: this.computeEvidenceHash({ ...current, [`${stage}Evidence`]: evidence }),
    });
    this.evaluations.set(evaluationId, next);
    this.saveIfConfigured();
    return next;
  }

  public static completeValidation(evaluationId: string, evidence: Readonly<Record<string, number>>, cutoffTimestamp: number): ChallengerEvaluation {
    return this.completeStage(evaluationId, 'validation', evidence, cutoffTimestamp, 'VALIDATION_COMPLETE');
  }
  public static completeWFV(evaluationId: string, evidence: Readonly<Record<string, number>>, cutoffTimestamp: number): ChallengerEvaluation {
    return this.completeStage(evaluationId, 'wfv', evidence, cutoffTimestamp, 'WFV_COMPLETE');
  }
  public static completeOOS(evaluationId: string, evidence: Readonly<Record<string, number>>, cutoffTimestamp: number): ChallengerEvaluation {
    return this.completeStage(evaluationId, 'oos', evidence, cutoffTimestamp, 'OOS_COMPLETE');
  }
  public static completeRobustness(evaluationId: string, evidence: Readonly<Record<string, number>>, cutoffTimestamp: number): ChallengerEvaluation {
    return this.completeStage(evaluationId, 'robustness', evidence, cutoffTimestamp, 'ROBUSTNESS_COMPLETE');
  }
  public static completeShadow(evaluationId: string, evidence: ShadowEvidence, cutoffTimestamp: number): ChallengerEvaluation {
    return this.completeStage(evaluationId, 'shadow', evidence, cutoffTimestamp, 'SHADOW_COMPLETE');
  }

  private static completeStage(
    evaluationId: string,
    stage: 'validation' | 'wfv' | 'oos' | 'robustness' | 'shadow',
    evidence: Readonly<Record<string, number>> | ShadowEvidence,
    cutoffTimestamp: number,
    nextState: ChallengerLifecycleState,
  ): ChallengerEvaluation {
    const recorded = this.recordEvidence(evaluationId, stage, evidence, cutoffTimestamp);
    return this.transition(recorded.evaluationId, nextState);
  }

  public static evaluatePromotion(
    evaluationId: string,
    rules: PromotionGateRules,
    decidedBy: string,
    timestamp = Date.now(),
  ): Phase10PromotionDecision {
    const evaluation = this.requireEvaluation(evaluationId);
    if (evaluation.state !== 'SHADOW_COMPLETE') throw new Error('PROMOTION_REQUIRES_SHADOW_COMPLETE');
    if (!evaluation.validationEvidence || !evaluation.wfvEvidence || !evaluation.oosEvidence || !evaluation.robustnessEvidence || !evaluation.shadowEvidence) {
      throw new Error('PROMOTION_REQUIRES_COMPLETE_EVIDENCE');
    }
    if (this.computeEvidenceHash(evaluation) !== evaluation.evidenceHash) throw new Error('EVIDENCE_HASH_MISMATCH');
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
    const baseline = evaluation.championBaselineMetrics;
    if (rules.maximumDrawdownIncrease !== undefined && shadow && shadow.maxDrawdownR - Number(baseline.maxDrawdownR || 0) > rules.maximumDrawdownIncrease) reasons.push('RELATIVE_DRAWDOWN_INCREASE_ABOVE_THRESHOLD');
    if (rules.minimumProfitFactorImprovement !== undefined && shadow && shadow.profitFactor - Number(baseline.profitFactor || 0) < rules.minimumProfitFactorImprovement) reasons.push('RELATIVE_PROFIT_FACTOR_IMPROVEMENT_BELOW_THRESHOLD');
    if (rules.minimumTradeCount !== undefined && (!shadow || shadow.totalTrades < rules.minimumTradeCount)) reasons.push('TRADE_COUNT_BELOW_THRESHOLD');
    if (rules.minimumNetPnLImprovement !== undefined && shadow && shadow.netPnL - Number(baseline.netPnL || 0) < rules.minimumNetPnLImprovement) reasons.push('RELATIVE_NET_PNL_IMPROVEMENT_BELOW_THRESHOLD');
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
    this.verifyChallengerForPromotion(evaluation, options.candidateId);
    const existingJournal = this.journals.get(evaluationId);
    if (existingJournal?.state === 'PROMOTION_COMMITTED' || this.getEvaluation(evaluationId)?.state === 'PROMOTED') {
      const active = ModelRegistry.getProductionState(options.strategyId, options.environment);
      if (active?.activeArtifactHash === evaluation.challengerArtifactHash) return active as ReturnType<typeof ProductionModelActivator.activateCandidate>;
    }
    const current = ModelRegistry.getProductionState(options.strategyId, options.environment);
    const currentChampion = current?.activeCandidateId ? ModelRegistry.getCandidateArtifact(current.activeCandidateId) : undefined;
    this.assertChampionCurrent(evaluation, current, currentChampion);
    const registryState = ModelRegistry.captureStateSnapshot();
    this.writeJournal(evaluation, current, currentChampion, registryState, 'PROMOTION_PREPARED');
    let activationAttempted = false;
    try {
      this.assertChampionCurrent(evaluation, current, currentChampion);
      this.writeJournal(evaluation, current, currentChampion, registryState, 'PROMOTION_ACTIVATING');
      activationAttempted = true;
      const state = ProductionModelActivator.activateCandidate(options);
      this.writeJournal(evaluation, current, currentChampion, registryState, 'PROMOTION_ACTIVATED');
      const active = ModelRegistry.getProductionState(options.strategyId, options.environment);
      const challenger = ModelRegistry.getCandidateArtifact(options.candidateId);
      this.verifyActivatedChallenger(evaluation, options.candidateId, active, challenger);
      this.writeJournal(evaluation, current, currentChampion, registryState, 'PROMOTION_VERIFIED');
      this.writeJournal(evaluation, current, currentChampion, registryState, 'PROMOTION_COMMITTED');
      this.transition(evaluationId, 'PROMOTED');
      return state;
    } catch (error) {
      if (!activationAttempted) {
        this.writeJournal(evaluation, current, currentChampion, registryState, 'PROMOTION_FAILED', String(error));
        throw error;
      }
      this.writeJournal(evaluation, current, currentChampion, registryState, 'PROMOTION_ROLLING_BACK', String(error));
      try {
        ModelRegistry.restoreStateSnapshot(registryState as Readonly<Record<string, unknown>>);
        this.verifyRollback(current, currentChampion, options.strategyId, options.environment);
        this.writeJournal(evaluation, current, currentChampion, registryState, 'PROMOTION_ROLLED_BACK', String(error));
      } catch (rollbackError) {
        this.writeJournal(evaluation, current, currentChampion, registryState, 'PROMOTION_FAILED', String(rollbackError));
        throw new Error(`PROMOTION_ROLLBACK_FAILED: ${String(rollbackError)}`);
      }
      this.writeJournal(evaluation, current, currentChampion, registryState, 'PROMOTION_FAILED', String(error));
      throw error;
    }
  }

  public static assertChampionCurrent(
    evaluation: ChallengerEvaluation,
    current = ModelRegistry.getProductionState(),
    currentChampion = current?.activeCandidateId ? ModelRegistry.getCandidateArtifact(current.activeCandidateId) : undefined,
  ): void {
    if (!current || !currentChampion) throw new Error('CHAMPION_SNAPSHOT_STALE');
    if (current.activeArtifactHash !== evaluation.championArtifactHash) throw new Error('CHAMPION_SNAPSHOT_STALE');
    if (currentChampion.artifactId !== evaluation.championArtifactId) throw new Error('CHAMPION_SNAPSHOT_STALE');
    if (currentChampion.artifactHash !== evaluation.championArtifactHash) throw new Error('CHAMPION_SNAPSHOT_STALE');
    if (
      currentChampion.executionContextHash !== evaluation.executionContextHash ||
      currentChampion.executionContextVersion !== evaluation.executionContextVersion
    ) throw new Error('CHAMPION_SNAPSHOT_STALE');
  }

  private static verifyChallengerForPromotion(evaluation: ChallengerEvaluation, candidateId: string): void {
    const challenger = ModelRegistry.getCandidateArtifact(candidateId);
    if (!challenger) throw new Error('CHALLENGER_ARTIFACT_NOT_FOUND');
    if (challenger.artifactId !== evaluation.challengerArtifactId) throw new Error('CHALLENGER_ID_MISMATCH');
    if (challenger.artifactHash !== evaluation.challengerArtifactHash) throw new Error('CHALLENGER_ARTIFACT_MISMATCH');
    if (
      challenger.executionContextHash !== evaluation.executionContextHash ||
      challenger.executionContextVersion !== evaluation.executionContextVersion
    ) throw new Error('CHALLENGER_EXECUTION_CONTEXT_MISMATCH');
  }

  private static verifyActivatedChallenger(
    evaluation: ChallengerEvaluation,
    candidateId: string,
    active: ReturnType<typeof ModelRegistry.getProductionState>,
    challenger: CandidateArtifact | undefined,
  ): void {
    if (!active || !challenger) throw new Error('PROMOTION_VERIFICATION_FAILED');
    if (active.activeCandidateId !== candidateId) throw new Error('PROMOTION_ACTIVE_MODEL_MISMATCH');
    if (active.activeModelVersion !== challenger.modelVersion) throw new Error('PROMOTION_MODEL_VERSION_MISMATCH');
    if (challenger.modelHash !== ModelRegistry.getCandidateArtifact(candidateId)?.modelHash) throw new Error('PROMOTION_MODEL_HASH_MISMATCH');
    if (active.activeArtifactHash !== evaluation.challengerArtifactHash || challenger.artifactHash !== evaluation.challengerArtifactHash) throw new Error('PROMOTION_ARTIFACT_HASH_MISMATCH');
    if (
      challenger.executionContextHash !== evaluation.executionContextHash ||
      challenger.executionContextVersion !== evaluation.executionContextVersion
    ) throw new Error('PROMOTION_EXECUTION_CONTEXT_MISMATCH');
  }

  private static verifyRollback(
    previousState: ReturnType<typeof ModelRegistry.getProductionState>,
    previousChampion: CandidateArtifact | undefined,
    strategyId?: string,
    environment?: 'paper' | 'live',
  ): void {
    const restoredState = ModelRegistry.getProductionState(strategyId, environment);
    if (JSON.stringify(restoredState) !== JSON.stringify(previousState)) throw new Error('ROLLBACK_PRODUCTION_STATE_MISMATCH');
    if (!previousState || !previousChampion) throw new Error('ROLLBACK_CHAMPION_MISSING');
    const restoredChampion = ModelRegistry.getCandidateArtifact(previousState.activeCandidateId);
    if (!restoredChampion) throw new Error('ROLLBACK_CHAMPION_MISSING');
    if (
      restoredChampion.artifactHash !== previousChampion.artifactHash ||
      restoredChampion.modelHash !== previousChampion.modelHash ||
      restoredChampion.executionContextHash !== previousChampion.executionContextHash ||
      restoredChampion.executionContextVersion !== previousChampion.executionContextVersion
    ) throw new Error('ROLLBACK_CHAMPION_MISMATCH');
  }

  private static writeJournal(evaluation: ChallengerEvaluation, state: unknown, champion: CandidateArtifact | undefined, registryState: unknown, nextState: PromotionTransactionState, error?: string): PromotionJournal {
    const previous = this.journals.get(evaluation.evaluationId);
    const journal: PromotionJournal = freeze({
      journalId: previous?.journalId || `promotion-journal-${randomUUID()}`,
      evaluationId: evaluation.evaluationId,
      state: nextState,
      previousChampionArtifactId: champion?.artifactId,
      previousChampionArtifactHash: (state as any)?.activeArtifactHash || evaluation.championArtifactHash,
      previousModelHash: champion?.modelHash || '',
      previousExecutionContextHash: champion?.executionContextHash || evaluation.executionContextHash,
      previousExecutionContextVersion: champion?.executionContextVersion || evaluation.executionContextVersion,
      previousRegistryState: registryState,
      previousProductionState: state,
      challengerArtifactHash: evaluation.challengerArtifactHash,
      startedAt: previous?.startedAt || Date.now(),
      updatedAt: Date.now(),
      error,
    });
    this.journals.set(evaluation.evaluationId, journal);
    this.saveIfConfigured();
    return journal;
  }

  private static computeEvidenceHash(evaluation: Partial<ChallengerEvaluation>): string {
    return hash({ validationEvidence: evaluation.validationEvidence, wfvEvidence: evaluation.wfvEvidence, oosEvidence: evaluation.oosEvidence, robustnessEvidence: evaluation.robustnessEvidence, shadowEvidence: evaluation.shadowEvidence });
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
