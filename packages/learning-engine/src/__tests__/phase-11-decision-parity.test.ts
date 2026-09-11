import {
  createMarketSnapshot,
  computeDecisionFingerprint,
  createDecisionPair,
  validateDecisionParity,
  classifyDecisionDivergence,
  DecisionContext,
  TradingDecision
} from '../shadow-execution/index';
import { deepFreeze } from '../champion-challenger/evaluation-identity';

describe('Phase 11 — Decision Parity & Divergence Classification', () => {
  const snapshot = createMarketSnapshot({
    snapshotId: 'snap-sol-01',
    instrument: { symbol: 'SOLUSDT', market: 'BINANCE_SPOT' },
    timestamp: 1700000000000,
    ohlcv: { open: 150, high: 155, low: 148, close: 153, volume: 500 },
    bid: 152.9,
    ask: 153.1,
    volume: 500,
    dataSource: 'binance',
    dataVersion: '1.0'
  });

  const baseSharedContext = {
    snapshotId: snapshot.snapshotId,
    decisionTimestamp: 1700000000020,
    instrument: snapshot.instrument,
    marketSnapshot: snapshot,
    featureVersion: 'feat-v2',
    featureSchemaHash: 'fhash-schema-01',
    featureDataCutoff: snapshot.timestamp,
    strategyVersion: 'strat-v2',
    strategyConfigHash: 'strat-hash-v2',
    executionConfigVersion: 'exec-v2',
    executionConfigHash: 'exec-hash-v2',
    riskConfigVersion: 'risk-v2',
    riskConfigHash: 'risk-hash-v2',
    costConfigVersion: 'cost-v2',
    costConfigHash: 'cost-hash-v2',
    portfolioStateVersion: 'port-v2'
  };

  const champIdentity = {
    modelId: 'champ-sol-01',
    modelVersion: '1.0.0',
    artifactHash: 'hash-champ-sol'
  };

  const challIdentity = {
    modelId: 'chall-sol-02',
    modelVersion: '2.0.0',
    artifactHash: 'hash-chall-sol'
  };

  it('creates an immutable DecisionPair and correctly classifies decision agreement / divergence', () => {
    const champContext: DecisionContext = deepFreeze({
      decisionId: 'dec-champ-01',
      ...baseSharedContext,
      modelIdentity: champIdentity,
      evaluationFingerprint: 'fp-champ',
      mode: 'LIVE',
      modelRole: 'CHAMPION'
    });

    const challContext: DecisionContext = deepFreeze({
      decisionId: 'dec-chall-01',
      ...baseSharedContext,
      modelIdentity: challIdentity,
      evaluationFingerprint: 'fp-chall',
      mode: 'SHADOW',
      modelRole: 'CHALLENGER'
    });

    const champDecision: TradingDecision = deepFreeze({
      decisionId: 'dec-champ-01',
      action: 'BUY',
      confidence: 0.85,
      signal: 'OB_SWEEP_BUY',
      entryPrice: 153,
      stopLoss: 148,
      takeProfit: 163,
      positionSize: 10,
      riskAmount: 50,
      reason: 'Champion confirmed OB sweep',
      decisionFingerprint: computeDecisionFingerprint({
        modelIdentity: champIdentity,
        snapshotId: snapshot.snapshotId,
        featureVersion: 'feat-v2',
        featureSchemaHash: 'fhash-schema-01',
        featureDataCutoff: snapshot.timestamp,
        action: 'BUY',
        signal: 'OB_SWEEP_BUY',
        entryPrice: 153,
        stopLoss: 148,
        takeProfit: 163,
        positionSize: 10
      }),
      latencies: {
        marketTimestamp: snapshot.timestamp,
        featureStartTimestamp: 1700000000005,
        featureEndTimestamp: 1700000000010,
        modelStartTimestamp: 1700000000010,
        modelEndTimestamp: 1700000000018,
        decisionTimestamp: 1700000000020,
        dataToDecisionLatencyMs: 20,
        featureLatencyMs: 5,
        modelLatencyMs: 8,
        totalDecisionLatencyMs: 20
      },
      context: champContext
    });

    // Case 1: Challenger agrees with exact same action and size
    const challDecisionAgree: TradingDecision = deepFreeze({
      decisionId: 'dec-chall-01',
      action: 'BUY',
      confidence: 0.90,
      signal: 'OB_SWEEP_BUY',
      entryPrice: 153,
      stopLoss: 148,
      takeProfit: 163,
      positionSize: 10,
      riskAmount: 50,
      reason: 'Challenger confirmed high confidence BUY',
      decisionFingerprint: computeDecisionFingerprint({
        modelIdentity: challIdentity,
        snapshotId: snapshot.snapshotId,
        featureVersion: 'feat-v2',
        featureSchemaHash: 'fhash-schema-01',
        featureDataCutoff: snapshot.timestamp,
        action: 'BUY',
        signal: 'OB_SWEEP_BUY',
        entryPrice: 153,
        stopLoss: 148,
        takeProfit: 163,
        positionSize: 10
      }),
      latencies: {
        marketTimestamp: snapshot.timestamp,
        featureStartTimestamp: 1700000000005,
        featureEndTimestamp: 1700000000010,
        modelStartTimestamp: 1700000000010,
        modelEndTimestamp: 1700000000017,
        decisionTimestamp: 1700000000020,
        dataToDecisionLatencyMs: 20,
        featureLatencyMs: 5,
        modelLatencyMs: 7,
        totalDecisionLatencyMs: 20
      },
      context: challContext
    });

    const pairAgree = createDecisionPair({
      championDecision: champDecision,
      challengerDecision: challDecisionAgree
    });

    expect(pairAgree.divergence).toBe('AGREE');
    expect(pairAgree.divergenceType).toBe('BOTH_ACTION_SAME_DIRECTION_SAME_SIZE');
    expect(pairAgree.decisionPairFingerprint.length).toBe(64);

    // Case 2: Challenger chooses HOLD (CHAMPION_ONLY_ACTION)
    const challDecisionHold: TradingDecision = deepFreeze({
      ...challDecisionAgree,
      action: 'HOLD',
      signal: 'NO_ACTION',
      decisionFingerprint: 'fp-chall-hold'
    });

    const pairHold = createDecisionPair({
      championDecision: champDecision,
      challengerDecision: challDecisionHold
    });

    expect(pairHold.divergence).toBe('DISAGREE');
    expect(pairHold.divergenceType).toBe('CHAMPION_ONLY_ACTION');
  });

  it('fails closed when snapshot or feature context diverges between Champion and Challenger', () => {
    const champContext: DecisionContext = deepFreeze({
      decisionId: 'dec-champ-01',
      ...baseSharedContext,
      snapshotId: 'snap-1',
      modelIdentity: champIdentity,
      evaluationFingerprint: 'fp-champ',
      mode: 'LIVE',
      modelRole: 'CHAMPION'
    });

    const challContextDiffSnap: DecisionContext = deepFreeze({
      decisionId: 'dec-chall-01',
      ...baseSharedContext,
      snapshotId: 'snap-DIVERGENT-2',
      modelIdentity: challIdentity,
      evaluationFingerprint: 'fp-chall',
      mode: 'SHADOW',
      modelRole: 'CHALLENGER'
    });

    const parity = validateDecisionParity(champContext, challContextDiffSnap);
    expect(parity.isParityValid).toBe(false);
    expect(parity.violations.some(v => v.includes('Snapshot ID mismatch'))).toBe(true);

    expect(() => {
      createDecisionPair({
        championDecision: { decisionId: 'c1', action: 'BUY', context: champContext } as any,
        challengerDecision: { decisionId: 'c2', action: 'BUY', context: challContextDiffSnap } as any
      });
    }).toThrow(/INVALID_DECISION_PAIR/);
  });
});
