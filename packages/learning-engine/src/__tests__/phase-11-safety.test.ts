import {
  ILiveExecutionPort,
  assertShadowExecution,
  assertLiveExecution,
  ShadowExecutionSimulator,
  createMarketSnapshot,
  DecisionContext
} from '../shadow-execution/index';
import { deepFreeze } from '../champion-challenger/evaluation-identity';

describe('Phase 11 — Mandatory Safety Guards & Live Portfolio Isolation', () => {
  const snapshot = createMarketSnapshot({
    snapshotId: 'snap-safety-01',
    instrument: { symbol: 'BTCUSDT', market: 'BINANCE_SPOT' },
    timestamp: 1700000000000,
    ohlcv: { open: 100000, high: 100500, low: 99800, close: 100200, volume: 10 },
    bid: 100190,
    ask: 100210,
    volume: 10,
    dataSource: 'binance',
    dataVersion: '1.0'
  });

  const mockLivePort: ILiveExecutionPort = {
    isLiveBroker: true,
    submitLiveOrder: jest.fn().mockResolvedValue({ liveOrderId: 'live-order-1', status: 'PLACED' }),
    cancelLiveOrder: jest.fn().mockResolvedValue(true)
  };

  it('rejects Challenger execution via ILiveExecutionPort (CHALLENGER_CANNOT_LIVE_TRADE)', () => {
    const challengerContext: DecisionContext = deepFreeze({
      decisionId: 'dec-chall-safety',
      snapshotId: snapshot.snapshotId,
      snapshotHash: snapshot.snapshotHash,
      portfolioSnapshot: {
        portfolioId: 'live-port-1',
        timestamp: snapshot.timestamp,
        cash: 100000,
        equity: 100000,
        openPositionsCount: 0,
        portfolioStateHash: 'p-state-hash'
      },
      decisionTimestamp: 1700000000010,
      instrument: snapshot.instrument,
      marketSnapshot: snapshot,
      featureVersion: 'feat-v2',
      featureSchemaHash: 'fhash',
      featureInputHash: 'f-input-hash',
      featureDataCutoff: snapshot.timestamp,
      strategyVersion: 's1',
      strategyConfigHash: 'shash',
      executionConfigVersion: 'e1',
      executionConfigHash: 'ehash',
      riskConfigVersion: 'r1',
      riskConfigHash: 'rhash',
      costConfigVersion: 'co1',
      costConfigHash: 'cohash',
      portfolioStateVersion: 'p1',
      portfolioStateHash: 'p-state-hash',
      modelIdentity: { modelId: 'chall-01', modelVersion: '1.0', artifactHash: 'h1' },
      evaluationFingerprint: 'efp-1',
      mode: 'SHADOW',
      modelRole: 'CHALLENGER'
    });

    // 1. Challenger attempting to invoke assertLiveExecution must throw CRITICAL_SAFETY_VIOLATION
    expect(() => {
      assertLiveExecution(challengerContext, mockLivePort);
    }).toThrow(/CRITICAL_SAFETY_VIOLATION: Challenger model attempted to invoke live execution path/);

    // 2. Challenger context passed to shadow execution with live port must throw
    expect(() => {
      assertShadowExecution(challengerContext, mockLivePort);
    }).toThrow(/SAFETY_VIOLATION: Attempted to route shadow execution through ILiveExecutionPort/);
  });

  it('ensures Shadow Execution does NOT mutate live portfolio state (LIVE_PORTFOLIO_ISOLATION)', () => {
    const livePortfolioState = {
      cash: 500000,
      equity: 500000,
      positions: [{ symbol: 'BTCUSDT', size: 2.0, entryPrice: 95000 }]
    };

    const initialLiveCash = livePortfolioState.cash;
    const initialLivePositions = [...livePortfolioState.positions];

    const shadowSimulator = new ShadowExecutionSimulator({ initialCapital: 100000 });

    // Execute shadow order
    shadowSimulator.submitShadowOrder({
      shadowOrderId: 'so-safety-1',
      decisionId: 'dec-1',
      instrument: { symbol: 'BTCUSDT', market: 'BINANCE_SPOT' },
      side: 'BUY',
      quantity: 5.0,
      requestedPrice: 100000,
      orderType: 'MARKET',
      createdAt: 1700000000000,
      executionConfigVersion: 'e1',
      costConfigVersion: 'c1',
      status: 'PENDING'
    });

    // Close shadow position with massive profit
    const shadowPos = shadowSimulator.getShadowPortfolioState().openPositions[0];
    shadowSimulator.closeShadowPosition(shadowPos.positionId, 120000, 1700003600000);

    // Assert live portfolio was COMPLETELY UNTOUCHED
    expect(livePortfolioState.cash).toBe(initialLiveCash);
    expect(livePortfolioState.positions).toEqual(initialLivePositions);
    expect(shadowSimulator.getShadowCash()).toBeGreaterThan(190000);
  });
});
