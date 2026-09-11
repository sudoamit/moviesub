import {
  createMarketSnapshot,
  computeDecisionFingerprint,
  createDecisionPair,
  ShadowOutcomeEvaluator,
  DecisionContext,
  TradingDecision
} from '../shadow-execution/index';
import { deepFreeze } from '../champion-challenger/evaluation-identity';

describe('Phase 11 — Shadow Outcome Attribution & Future Isolation', () => {
  const snapshot = createMarketSnapshot({
    snapshotId: 'snap-avax-01',
    instrument: { symbol: 'AVAXUSDT', market: 'BINANCE_SPOT' },
    timestamp: 1700000000000,
    ohlcv: { open: 30, high: 32, low: 29, close: 31, volume: 1000 },
    bid: 30.9,
    ask: 31.1,
    volume: 1000,
    dataSource: 'binance',
    dataVersion: '1.0'
  });

  const baseShared = {
    snapshotId: snapshot.snapshotId,
    decisionTimestamp: 1700000000010,
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

  const champIdentity = { modelId: 'c1', modelVersion: '1.0', artifactHash: 'h1' };
  const challIdentity = { modelId: 'c2', modelVersion: '2.0', artifactHash: 'h2' };

  it('attributes post-decision outcome separately without mutating the original decision context or pair', () => {
    const champDecision: TradingDecision = deepFreeze({
      decisionId: 'dec-champ-avax',
      action: 'BUY',
      confidence: 0.88,
      signal: 'SMC_BUY',
      entryPrice: 31,
      stopLoss: 29,
      takeProfit: 35,
      positionSize: 100,
      riskAmount: 200,
      reason: 'Champion buy',
      decisionFingerprint: 'dp-champ-1',
      latencies: {
        marketTimestamp: snapshot.timestamp,
        featureStartTimestamp: 1700000000001,
        featureEndTimestamp: 1700000000005,
        modelStartTimestamp: 1700000000005,
        modelEndTimestamp: 1700000000009,
        decisionTimestamp: 1700000000010,
        dataToDecisionLatencyMs: 10,
        featureLatencyMs: 4,
        modelLatencyMs: 4,
        totalDecisionLatencyMs: 10
      },
      context: deepFreeze({
        decisionId: 'dec-champ-avax',
        ...baseShared,
        modelIdentity: champIdentity,
        evaluationFingerprint: 'efp-c1',
        mode: 'LIVE',
        modelRole: 'CHAMPION'
      })
    });

    const challDecision: TradingDecision = deepFreeze({
      decisionId: 'dec-chall-avax',
      action: 'BUY',
      confidence: 0.92,
      signal: 'SMC_BUY',
      entryPrice: 31,
      stopLoss: 29,
      takeProfit: 35,
      positionSize: 100,
      riskAmount: 200,
      reason: 'Challenger buy',
      decisionFingerprint: 'dp-chall-1',
      latencies: {
        marketTimestamp: snapshot.timestamp,
        featureStartTimestamp: 1700000000001,
        featureEndTimestamp: 1700000000005,
        modelStartTimestamp: 1700000000005,
        modelEndTimestamp: 1700000000008,
        decisionTimestamp: 1700000000010,
        dataToDecisionLatencyMs: 10,
        featureLatencyMs: 4,
        modelLatencyMs: 3,
        totalDecisionLatencyMs: 10
      },
      context: deepFreeze({
        decisionId: 'dec-chall-avax',
        ...baseShared,
        modelIdentity: challIdentity,
        evaluationFingerprint: 'efp-c2',
        mode: 'SHADOW',
        modelRole: 'CHALLENGER'
      })
    });

    const pair = createDecisionPair({
      championDecision: champDecision,
      challengerDecision: challDecision
    });

    const originalDecisionFingerprint = challDecision.decisionFingerprint;
    const originalPairFingerprint = pair.decisionPairFingerprint;

    // Simulate outcome window evaluation (e.g. 1 hour later)
    const outcome = ShadowOutcomeEvaluator.attributeOutcome({
      outcomeId: 'out-avax-01',
      decision: challDecision,
      pair,
      outcomeStartTimestamp: 1700000000010,
      outcomeEndTimestamp: 1700003600000,
      entryFill: {
        fillId: 'f-entry-1',
        shadowOrderId: 'so-1',
        fillPrice: 31.02,
        filledQuantity: 100,
        fillTimestamp: 1700000000010,
        fee: 1.55,
        slippage: 2.0
      },
      exitFill: {
        fillId: 'f-exit-1',
        shadowOrderId: 'so-exit-1',
        fillPrice: 35.0,
        filledQuantity: 100,
        fillTimestamp: 1700003600000,
        fee: 1.75,
        slippage: 0
      },
      grossPnL: 398.0,
      fees: 3.30,
      slippage: 2.0,
      netPnL: 394.70,
      maxFavorableExcursion: 420.0,
      maxAdverseExcursion: -50.0,
      holdingDurationMs: 3599990,
      exitReason: 'TARGET_HIT',
      outcomeStatus: 'EVALUATED'
    });

    expect(outcome.outcomeId).toBe('out-avax-01');
    expect(outcome.netPnL).toBe(394.70);
    expect(outcome.outcomeHash.length).toBe(64);
    expect(Object.isFrozen(outcome)).toBe(true);

    // Verify ZERO mutation of original decision or pair
    expect(challDecision.decisionFingerprint).toBe(originalDecisionFingerprint);
    expect(pair.decisionPairFingerprint).toBe(originalPairFingerprint);
  });
});
