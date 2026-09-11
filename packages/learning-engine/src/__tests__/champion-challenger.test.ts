import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CandidateArtifactBuilder } from '../candidate-artifact-builder';
import { ChallengerEvaluation, ChampionChallengerCoordinator, ChampionSnapshot, Phase10PromotionDecision, ShadowEvidence } from '../champion-challenger';
import { ModelRegistry } from '../model-registry';
import { ProductionModelActivator } from '../production-model-activator';
import { ProductionModelState, PromotionDecision, PromotionEvidence, PromotionPolicy, StrategyCandidate } from '../types';

const riskConfig = {
  initialCapital: 100000,
  maxRiskPerTrade: 0.01,
  lotSize: 1,
  contractSize: 1,
  partialExitPolicy: {
    tp1Ratio: 0.33,
    tp2Ratio: 0.33,
    tp3Ratio: 0.34,
    moveStopToBreakevenOnTp1: true,
    trailStopOnTp2: true,
    trailStopOffsetR: 1,
  },
};

function makeArtifact(id: string) {
  const candidate: StrategyCandidate = {
    id,
    baseStrategyVersion: 'strategy-v1',
    candidateVersion: id,
    type: 'THRESHOLD',
    description: id,
    symbol: 'TEST',
    riskConfig,
    change: {
      fillModel: 'OHLC_PATH',
      ambiguityMode: 'CONSERVATIVE',
      latencyMs: 5,
      minMtfScore: 50,
      stopLossAtrMultiplier: 1.5,
      sizingMultiplier: 1,
      symbol: 'TEST',
    },
    evidence: { sampleSize: 20, expectancyBefore: 0, expectancyAfterHistorical: 1 },
    status: 'TRAINED',
    createdAt: new Date(0),
  };
  return CandidateArtifactBuilder.build(candidate, {
    datasetHash: 'phase10-dataset',
    timeframe: '1h',
  });
}

const metrics = {
  totalTrades: 10,
  wins: 7,
  losses: 3,
  winRate: 70,
  grossPnL: 200,
  netPnL: 180,
  pnlR: 3,
  profitFactor: 2,
  maxDrawdown: 1,
  maxDrawdownR: 1,
  expectancy: 0.3,
  averageR: 0.3,
  medianR: 0.3,
  largestLoss: -20,
  largestWin: 50,
  fees: 10,
  slippage: 2,
  observationsCount: 30,
};

describe('Phase 10 Champion vs Challenger foundation', () => {
  const storePath = path.join(os.tmpdir(), `phase10-${process.pid}.json`);

  beforeEach(() => {
    ChampionChallengerCoordinator.reset();
    ModelRegistry.reset();
    ModelRegistry.setPersistencePath(storePath);
    if (fs.existsSync(storePath)) fs.rmSync(storePath);
  });

  afterEach(() => {
    ChampionChallengerCoordinator.reset();
    ModelRegistry.setPersistencePath(null);
    if (fs.existsSync(storePath)) fs.rmSync(storePath);
  });

  function setup() {
    const champion = makeArtifact('champion');
    const challenger = makeArtifact('challenger');
    ModelRegistry.registerCandidateArtifact(champion);
    ModelRegistry.registerCandidateArtifact(challenger);
    ModelRegistry.setProductionState(productionStateFor(champion, 'initial-champion'));
    const snapshot = ChampionChallengerCoordinator.captureChampionSnapshot(
      champion,
      'phase10-dataset',
      { expectancy: 0.1, maxDrawdownR: 2 },
    );
    const evaluation = ChampionChallengerCoordinator.createEvaluation(
      snapshot,
      challenger,
      'phase10-dataset',
      1700000000000,
    );
    return { champion, challenger, snapshot, evaluation };
  }

  function productionStateFor(artifact: ReturnType<typeof makeArtifact>, activationId: string): ProductionModelState {
    return {
      strategyId: 'smc-quant-baseline',
      environment: 'paper',
      activeCandidateId: artifact.candidateId,
      activeModelVersion: artifact.modelVersion,
      activeStrategyVersion: artifact.strategyVersion,
      activeArtifactHash: artifact.artifactHash,
      activatedAt: 1700000000000,
      activationId,
    };
  }

  function shadowEvidenceFor(evaluation: ChallengerEvaluation): ShadowEvidence {
    return {
      ...metrics,
      challengerArtifactHash: evaluation.challengerArtifactHash,
      championArtifactHash: evaluation.championArtifactHash,
      championSnapshotHash: evaluation.championSnapshotHash,
      executionContextHash: evaluation.executionContextHash,
      executionContextVersion: evaluation.executionContextVersion,
      datasetHash: evaluation.datasetHash,
      marketDataCutoffTimestamp: evaluation.marketDataCutoffTimestamp,
      shadowEvaluationVersion: 'phase10-evaluation-v1',
    };
  }

  function completeShadowEvaluation(evaluation: ReturnType<typeof setup>['evaluation']) {
    const cutoff = evaluation.marketDataCutoffTimestamp;
    let current = ChampionChallengerCoordinator.transition(evaluation.evaluationId, 'TRAINING_COMPLETE');
    current = ChampionChallengerCoordinator.completeValidation(current.evaluationId, { expectancy: 0.3 }, cutoff);
    current = ChampionChallengerCoordinator.completeWFV(current.evaluationId, { expectancy: 0.25 }, cutoff);
    current = ChampionChallengerCoordinator.completeOOS(current.evaluationId, { expectancy: 0.2 }, cutoff);
    current = ChampionChallengerCoordinator.completeRobustness(current.evaluationId, { survived: 1 }, cutoff);
    current = ChampionChallengerCoordinator.transition(current.evaluationId, 'SHADOW_RUNNING');
    return ChampionChallengerCoordinator.completeShadow(current.evaluationId, shadowEvidenceFor(current), cutoff);
  }

  function makePromoteDecision(evaluation: ReturnType<typeof setup>['evaluation']): Phase10PromotionDecision {
    const complete = completeShadowEvaluation(evaluation);
    return ChampionChallengerCoordinator.evaluatePromotion(
      complete.evaluationId,
      { gateVersion: 'gate-1', minimumValidationExpectancy: 0.1, minimumWFVExpectancy: 0.1, minimumOOSExpectancy: 0.1, minimumShadowExpectancy: 0.1, minimumShadowTrades: 5, maximumShadowDrawdownR: 2, requirePositiveNetPnL: true },
      'test',
      100,
    );
  }

  function makeActivationReady(challenger: ReturnType<typeof makeArtifact>, decision: Phase10PromotionDecision) {
    ModelRegistry.savePromotionEvidence(promotionEvidenceFor(challenger, decision));
    ModelRegistry.updateCandidateStatus(challenger.candidateId, 'OOS_VALIDATED', 'test oos');
    ModelRegistry.updateCandidateStatus(challenger.candidateId, 'SHADOW', 'test shadow');
    ModelRegistry.updateCandidateStatus(challenger.candidateId, 'PROMOTION_ELIGIBLE', 'test promotion');
  }

  function promotionDecisionFor(challenger: ReturnType<typeof makeArtifact>, decision: Phase10PromotionDecision): PromotionDecision {
    return {
      decision: 'PROMOTE',
      candidateId: challenger.candidateId,
      evidenceId: `evidence-${challenger.candidateId}`,
      evaluatedAt: decision.decisionTimestamp,
      reasons: [],
      metrics,
      policyVersion: decision.promotionGateVersion,
    };
  }

  function promotionEvidenceFor(challenger: ReturnType<typeof makeArtifact>, decision: Phase10PromotionDecision): PromotionEvidence {
    return {
      evidenceId: `evidence-${challenger.candidateId}`,
      candidateId: challenger.candidateId,
      artifactHash: challenger.artifactHash,
      trainingDatasetHash: challenger.trainingDatasetHash,
      validationDatasetHash: challenger.validationDatasetHash,
      oosDatasetHash: challenger.oosDatasetHash,
      shadowDatasetHash: challenger.datasetHash,
      shadowWindowStart: 1,
      shadowWindowEnd: 2,
      shadowMetrics: metrics,
      promotionPolicyVersion: decision.promotionGateVersion,
      promotionDecision: 'PROMOTE',
      decisionReasons: [],
      evaluatedAt: decision.decisionTimestamp,
      executionContextHash: challenger.executionContextHash,
      executionContextVersion: challenger.executionContextVersion,
    };
  }

  const promotionPolicy: PromotionPolicy = {
    minimumShadowTrades: 5,
    minimumShadowObservations: 10,
    minimumProfitFactor: 1,
    minimumExpectancyR: 0,
    maximumDrawdownR: 2,
    requirePositiveNetPnl: true,
    requireIndependentShadowWindow: true,
    allowAutoPromotion: false,
  };

  it('captures an immutable champion snapshot and prevents challenger mutation', () => {
    const { snapshot } = setup();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => ((snapshot as unknown as { artifactHash: string }).artifactHash = 'tampered')).toThrow();
    expect(snapshot.artifactHash).toBeDefined();
  });

  it('rejects incompatible context or context version before comparison', () => {
    const { snapshot, challenger } = setup();
    const incompatible = { ...snapshot, executionContextHash: 'different' } as ChampionSnapshot;
    expect(() => ChampionChallengerCoordinator.createEvaluation(incompatible, challenger, 'phase10-dataset', 1700000000000)).toThrow(/INCOMPATIBLE_EXECUTION_CONTEXT/);
    const versioned = { ...snapshot, executionContextVersion: '2.0' } as ChampionSnapshot;
    expect(() => ChampionChallengerCoordinator.createEvaluation(versioned, challenger, 'phase10-dataset', 1700000000000)).toThrow(/INCOMPATIBLE_EXECUTION_CONTEXT/);
  });

  it('enforces lifecycle transitions and promotion ordering', () => {
    const { evaluation } = setup();
    expect(() => ChampionChallengerCoordinator.transition(evaluation.evaluationId, 'PROMOTED')).toThrow('ILLEGAL_CHALLENGER_TRANSITION');
    expect(() => ChampionChallengerCoordinator.evaluatePromotion(evaluation.evaluationId, { gateVersion: 'gate-1' }, 'test')).toThrow('PROMOTION_REQUIRES_SHADOW_COMPLETE');
    let current = ChampionChallengerCoordinator.transition(evaluation.evaluationId, 'TRAINING_COMPLETE');
    expect(() => ChampionChallengerCoordinator.transition(current.evaluationId, 'VALIDATION_COMPLETE')).toThrow('INCOMPLETE_LIFECYCLE_EVIDENCE');
    current = ChampionChallengerCoordinator.completeValidation(current.evaluationId, { expectancy: 0.3 }, current.marketDataCutoffTimestamp);
    current = ChampionChallengerCoordinator.completeWFV(current.evaluationId, { expectancy: 0.25 }, current.marketDataCutoffTimestamp);
    current = ChampionChallengerCoordinator.completeOOS(current.evaluationId, { expectancy: 0.2 }, current.marketDataCutoffTimestamp);
    current = ChampionChallengerCoordinator.completeRobustness(current.evaluationId, { survived: 1 }, current.marketDataCutoffTimestamp);
    current = ChampionChallengerCoordinator.transition(current.evaluationId, 'SHADOW_RUNNING');
    expect(current.state).toBe('SHADOW_RUNNING');
  });

  it('requires the same market cutoff for shadow evidence', () => {
    const { evaluation } = setup();
    const running = ChampionChallengerCoordinator.transition(evaluation.evaluationId, 'TRAINING_COMPLETE');
    expect(() => ChampionChallengerCoordinator.recordEvidence(running.evaluationId, 'validation', { expectancy: 0.2 }, 1)).toThrow('MARKET_DATA_CUTOFF_MISMATCH');
  });

  it('rejects evidence submitted outside its lifecycle stage', () => {
    const { evaluation } = setup();
    expect(() => ChampionChallengerCoordinator.recordEvidence(evaluation.evaluationId, 'validation', { expectancy: 0.2 }, evaluation.marketDataCutoffTimestamp)).toThrow('INVALID_EVIDENCE_STAGE');
  });

  it('rejects dataset provenance mismatches and stale champions', () => {
    const { champion, challenger, snapshot, evaluation } = setup();
    expect(() => ChampionChallengerCoordinator.createEvaluation(snapshot, challenger, 'different-dataset', evaluation.marketDataCutoffTimestamp)).toThrow('DATASET_PROVENANCE_MISMATCH');
    ModelRegistry.setProductionState({
      strategyId: 'smc-quant-baseline',
      environment: 'paper',
      activeCandidateId: champion.candidateId,
      activeModelVersion: champion.modelVersion,
      activeStrategyVersion: champion.strategyVersion,
      activeArtifactHash: 'changed-champion',
      activatedAt: Date.now(),
      activationId: 'changed',
    });
    expect(() => ChampionChallengerCoordinator.assertChampionCurrent(evaluation)).toThrow('CHAMPION_SNAPSHOT_STALE');
  });

  it('produces deterministic promotion decisions from complete evidence', () => {
    const { evaluation } = setup();
    const current = completeShadowEvaluation(evaluation);
    const rules = { gateVersion: 'gate-1', minimumValidationExpectancy: 0.1, minimumWFVExpectancy: 0.1, minimumOOSExpectancy: 0.1, minimumShadowExpectancy: 0.1, minimumShadowTrades: 5, maximumShadowDrawdownR: 2, requirePositiveNetPnL: true };
    const first = ChampionChallengerCoordinator.evaluatePromotion(current.evaluationId, rules, 'test', 100);
    const second = ChampionChallengerCoordinator.getDecision(current.evaluationId);
    expect(first.decision).toBe('PROMOTE');
    expect(second).toEqual(first);
    expect(ChampionChallengerCoordinator.getEvaluation(current.evaluationId)?.state).toBe('PROMOTION_ELIGIBLE');
  });

  it('cannot promote a rejected challenger or bypass shadow completion', () => {
    const { evaluation } = setup();
    let current = ChampionChallengerCoordinator.transition(evaluation.evaluationId, 'TRAINING_COMPLETE');
    current = ChampionChallengerCoordinator.completeValidation(current.evaluationId, { expectancy: 0.3 }, current.marketDataCutoffTimestamp);
    current = ChampionChallengerCoordinator.completeWFV(current.evaluationId, { expectancy: 0.25 }, current.marketDataCutoffTimestamp);
    current = ChampionChallengerCoordinator.completeOOS(current.evaluationId, { expectancy: 0.2 }, current.marketDataCutoffTimestamp);
    current = ChampionChallengerCoordinator.completeRobustness(current.evaluationId, { survived: 1 }, current.marketDataCutoffTimestamp);
    current = ChampionChallengerCoordinator.transition(current.evaluationId, 'SHADOW_RUNNING');
    expect(() => ChampionChallengerCoordinator.evaluatePromotion(current.evaluationId, { gateVersion: 'gate-1', minimumShadowTrades: 100 }, 'test')).toThrow('PROMOTION_REQUIRES_SHADOW_COMPLETE');
    expect(() => ChampionChallengerCoordinator.transition(current.evaluationId, 'PROMOTED')).toThrow('ILLEGAL_CHALLENGER_TRANSITION');
  });

  it('fails closed when the production champion changed after challenger evaluation', () => {
    const { challenger, evaluation } = setup();
    const decision = makePromoteDecision(evaluation);
    makeActivationReady(challenger, decision);
    const replacementChampion = makeArtifact('replacement-champion');
    ModelRegistry.registerCandidateArtifact(replacementChampion);
    ModelRegistry.setProductionState(productionStateFor(replacementChampion, 'replacement-champion'));
    expect(() => ChampionChallengerCoordinator.promote(evaluation.evaluationId, {
      candidateId: challenger.candidateId,
      promotionDecision: promotionDecisionFor(challenger, decision),
      policy: promotionPolicy,
    })).toThrow('CHAMPION_SNAPSHOT_STALE');
    expect(ModelRegistry.getProductionState()?.activeArtifactHash).toBe(replacementChampion.artifactHash);
  });

  it('commits a journaled promotion only after production verification passes', () => {
    const { challenger, evaluation } = setup();
    const decision = makePromoteDecision(evaluation);
    makeActivationReady(challenger, decision);
    const state = ChampionChallengerCoordinator.promote(evaluation.evaluationId, {
      candidateId: challenger.candidateId,
      promotionDecision: promotionDecisionFor(challenger, decision),
      policy: promotionPolicy,
    });
    expect(state.activeArtifactHash).toBe(challenger.artifactHash);
    expect(ChampionChallengerCoordinator.getPromotionJournal(evaluation.evaluationId)?.state).toBe('PROMOTION_COMMITTED');
    expect(ChampionChallengerCoordinator.getEvaluation(evaluation.evaluationId)?.state).toBe('PROMOTED');
  });

  it('restores the exact previous production state when promotion activation fails after mutation', () => {
    const { champion, challenger, evaluation } = setup();
    const previousState = ModelRegistry.getProductionState();
    const decision = makePromoteDecision(evaluation);
    const activateSpy = jest.spyOn(ProductionModelActivator, 'activateCandidate')
      .mockImplementation(() => {
        ModelRegistry.setProductionState(productionStateFor(challenger, 'partial-activation'));
        throw new Error('SIMULATED_ACTIVATION_FAILURE');
      });

    expect(() => ChampionChallengerCoordinator.promote(evaluation.evaluationId, {
      candidateId: challenger.candidateId,
      promotionDecision: promotionDecisionFor(challenger, decision),
      policy: promotionPolicy,
    })).toThrow('SIMULATED_ACTIVATION_FAILURE');
    expect(ModelRegistry.getProductionState()).toEqual(previousState);
    expect(ModelRegistry.getCandidateArtifact(champion.candidateId)?.status).toBe(champion.status);
    expect(ChampionChallengerCoordinator.getPromotionJournal(evaluation.evaluationId)?.state).toBe('PROMOTION_FAILED');
    activateSpy.mockRestore();
  });

  it('persists evaluation and decision evidence atomically', () => {
    const { evaluation } = setup();
    ChampionChallengerCoordinator.saveToFile(storePath);
    expect(fs.existsSync(storePath)).toBe(true);
    ChampionChallengerCoordinator.reset();
    ChampionChallengerCoordinator.loadFromFile(storePath);
    expect(ChampionChallengerCoordinator.getEvaluation(evaluation.evaluationId)?.challengerArtifactId).toBe(evaluation.challengerArtifactId);
  });
});
