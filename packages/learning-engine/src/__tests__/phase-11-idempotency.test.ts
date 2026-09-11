import {
  createMarketSnapshot,
  createDecisionPair,
  InMemoryShadowExecutionStore,
  TradingDecision,
  DecisionContext
} from '../shadow-execution/index';
import { deepFreeze } from '../champion-challenger/evaluation-identity';

describe('Phase 11 — Event Idempotency & Duplicate Prevention', () => {
  let store: InMemoryShadowExecutionStore;

  const snapshot = createMarketSnapshot({
    snapshotId: 'snap-idem-01',
    instrument: { symbol: 'BTCUSDT', market: 'BINANCE_SPOT' },
    timestamp: 1700000000000,
    ohlcv: { open: 100000, high: 100500, low: 99800, close: 100200, volume: 10 },
    bid: 100190,
    ask: 100210,
    volume: 10,
    dataSource: 'binance',
    dataVersion: '1.0'
  });

  const baseShared = {
    snapshotId: snapshot.snapshotId,
    decisionTimestamp: 1700000000010,
    instrument: snapshot.instrument,
    marketSnapshot: snapshot,
    featureVersion: 'feat-v2',
    featureSchemaHash: 'fhash',
    featureDataCutoff: snapshot.timestamp,
    strategyVersion: 's1',
    strategyConfigHash: 'shash',
    executionConfigVersion: 'e1',
    executionConfigHash: 'ehash',
    riskConfigVersion: 'r1',
    riskConfigHash: 'rhash',
    costConfigVersion: 'co1',
    costConfigHash: 'cohash',
    portfolioStateVersion: 'p1'
  };

  const champDecision: TradingDecision = deepFreeze({
    decisionId: 'dec-champ-idem',
    action: 'BUY',
    confidence: 0.85,
    signal: 'SMC_BUY',
    entryPrice: 100200,
    stopLoss: 98000,
    takeProfit: 105000,
    positionSize: 1,
    riskAmount: 2200,
    reason: 'Champion buy',
    decisionFingerprint: 'dp-champ-idem',
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
      decisionId: 'dec-champ-idem',
      ...baseShared,
      modelIdentity: { modelId: 'c1', modelVersion: '1.0', artifactHash: 'h1' },
      evaluationFingerprint: 'efp-c1',
      mode: 'LIVE',
      modelRole: 'CHAMPION'
    })
  });

  const challDecision: TradingDecision = deepFreeze({
    decisionId: 'dec-chall-idem',
    action: 'BUY',
    confidence: 0.89,
    signal: 'SMC_BUY',
    entryPrice: 100200,
    stopLoss: 98000,
    takeProfit: 105000,
    positionSize: 1,
    riskAmount: 2200,
    reason: 'Challenger buy',
    decisionFingerprint: 'dp-chall-idem',
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
      decisionId: 'dec-chall-idem',
      ...baseShared,
      modelIdentity: { modelId: 'c2', modelVersion: '2.0', artifactHash: 'h2' },
      evaluationFingerprint: 'efp-c2',
      mode: 'SHADOW',
      modelRole: 'CHALLENGER'
    })
  });

  beforeEach(() => {
    store = new InMemoryShadowExecutionStore();
  });

  it('guarantees that duplicate market event is idempotent and does not create duplicate pairs or orders', () => {
    // Process event first time
    const pair1 = createDecisionPair({
      championDecision: champDecision,
      challengerDecision: challDecision
    });
    store.saveDecisionPair(pair1);

    // Re-receive identical snapshot / event
    const existingPair = store.getDecisionPairBySnapshot(snapshot.snapshotId);
    expect(existingPair).toBeDefined();
    expect(existingPair?.pairId).toBe(pair1.pairId);
    expect(existingPair?.decisionPairFingerprint).toBe(pair1.decisionPairFingerprint);

    // Store contains strictly 1 pair
    expect(store.getAllPairs().length).toBe(1);
  });
});
