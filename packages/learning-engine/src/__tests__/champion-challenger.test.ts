import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CandidateArtifactBuilder } from '../candidate-artifact-builder';
import { ChampionChallengerCoordinator, ChampionSnapshot } from '../champion-challenger';
import { ModelRegistry } from '../model-registry';
import { StrategyCandidate } from '../types';

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
    current = ChampionChallengerCoordinator.transition(current.evaluationId, 'VALIDATION_COMPLETE');
    current = ChampionChallengerCoordinator.transition(current.evaluationId, 'WFV_COMPLETE');
    current = ChampionChallengerCoordinator.transition(current.evaluationId, 'OOS_COMPLETE');
    current = ChampionChallengerCoordinator.transition(current.evaluationId, 'ROBUSTNESS_COMPLETE');
    current = ChampionChallengerCoordinator.transition(current.evaluationId, 'SHADOW_RUNNING');
    expect(current.state).toBe('SHADOW_RUNNING');
  });

  it('requires the same market cutoff for shadow evidence', () => {
    const { evaluation } = setup();
    const running = ChampionChallengerCoordinator.transition(evaluation.evaluationId, 'TRAINING_COMPLETE');
    expect(() => ChampionChallengerCoordinator.recordEvidence(running.evaluationId, 'validation', { expectancy: 0.2 }, 1)).toThrow('MARKET_DATA_CUTOFF_MISMATCH');
  });

  it('produces deterministic promotion decisions from complete evidence', () => {
    const { evaluation } = setup();
    let current = evaluation;
    for (const state of ['TRAINING_COMPLETE', 'VALIDATION_COMPLETE', 'WFV_COMPLETE', 'OOS_COMPLETE', 'ROBUSTNESS_COMPLETE', 'SHADOW_RUNNING'] as const) {
      current = ChampionChallengerCoordinator.transition(current.evaluationId, state);
    }
    const cutoff = evaluation.marketDataCutoffTimestamp;
    for (const [stage, evidence] of [
      ['validation', { expectancy: 0.3 }],
      ['wfv', { expectancy: 0.25 }],
      ['oos', { expectancy: 0.2 }],
      ['robustness', { survived: 1 }],
    ] as const) {
      current = ChampionChallengerCoordinator.recordEvidence(current.evaluationId, stage, evidence, cutoff);
    }
    current = ChampionChallengerCoordinator.recordEvidence(current.evaluationId, 'shadow', metrics, cutoff);
    current = ChampionChallengerCoordinator.transition(current.evaluationId, 'SHADOW_COMPLETE');
    const rules = { gateVersion: 'gate-1', minimumValidationExpectancy: 0.1, minimumWFVExpectancy: 0.1, minimumOOSExpectancy: 0.1, minimumShadowExpectancy: 0.1, minimumShadowTrades: 5, maximumShadowDrawdownR: 2, requirePositiveNetPnL: true };
    const first = ChampionChallengerCoordinator.evaluatePromotion(current.evaluationId, rules, 'test', 100);
    const second = ChampionChallengerCoordinator.getDecision(current.evaluationId);
    expect(first.decision).toBe('PROMOTE');
    expect(second).toEqual(first);
    expect(ChampionChallengerCoordinator.getEvaluation(current.evaluationId)?.state).toBe('PROMOTION_ELIGIBLE');
  });

  it('cannot promote a rejected challenger or bypass shadow completion', () => {
    const { evaluation } = setup();
    let current = evaluation;
    for (const state of ['TRAINING_COMPLETE', 'VALIDATION_COMPLETE', 'WFV_COMPLETE', 'OOS_COMPLETE', 'ROBUSTNESS_COMPLETE', 'SHADOW_RUNNING'] as const) {
      current = ChampionChallengerCoordinator.transition(current.evaluationId, state);
    }
    current = ChampionChallengerCoordinator.transition(current.evaluationId, 'SHADOW_COMPLETE');
    const decision = ChampionChallengerCoordinator.evaluatePromotion(current.evaluationId, { gateVersion: 'gate-1', minimumShadowTrades: 100 }, 'test');
    expect(decision.decision).toBe('INSUFFICIENT_EVIDENCE');
    expect(() => ChampionChallengerCoordinator.transition(current.evaluationId, 'PROMOTED')).toThrow('ILLEGAL_CHALLENGER_TRANSITION');
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
