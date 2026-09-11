import {
  createMarketSnapshot,
  createPortfolioSnapshot,
  computeDecisionFingerprint,
  DecisionContext,
  TradingDecision
} from '../shadow-execution/index';
import { deepFreeze } from '../champion-challenger/evaluation-identity';

describe('Phase 11 — Decision Context & Deterministic Fingerprinting', () => {
  const snapshot = createMarketSnapshot({
    snapshotId: 'snap-eth-01',
    instrument: { symbol: 'ETHUSDT', market: 'BINANCE_SPOT' },
    timestamp: 1700000000000,
    ohlcv: { open: 3000, high: 3050, low: 2980, close: 3020, volume: 100 },
    bid: 3019.5,
    ask: 3020.5,
    volume: 100,
    dataSource: 'binance',
    dataVersion: '1.0'
  });

  const portfolioSnapshot = createPortfolioSnapshot({
    portfolioId: 'port-eth-01',
    timestamp: 1700000000000,
    cash: 50000,
    equity: 50000,
    openPositionsCount: 0
  });

  const baseModelIdentity = {
    modelId: 'champ-model-01',
    modelVersion: '1.0.0',
    artifactHash: 'hash-champ-art-123'
  };

  it('computes deterministic decision fingerprints from point-in-time decision inputs and context hashes', () => {
    const baseParams = {
      modelIdentity: baseModelIdentity,
      snapshotId: snapshot.snapshotId,
      snapshotHash: snapshot.snapshotHash,
      portfolioStateHash: portfolioSnapshot.portfolioStateHash,
      featureVersion: 'feat-v2',
      featureSchemaHash: 'fhash-99',
      featureInputHash: 'feat-input-hash-01',
      featureDataCutoff: snapshot.timestamp,
      strategyConfigHash: 'strat-hash-1',
      executionConfigHash: 'exec-hash-1',
      riskConfigHash: 'risk-hash-1',
      costConfigHash: 'cost-hash-1',
      action: 'BUY' as const,
      signal: 'SMC_BOS_LONG',
      entryPrice: 3020,
      stopLoss: 2950,
      takeProfit: 3150,
      positionSize: 1.5,
      riskAmount: 105
    };

    const fp1 = computeDecisionFingerprint(baseParams);
    const fp2 = computeDecisionFingerprint({ ...baseParams });

    expect(fp1).toBe(fp2);
    expect(fp1.length).toBe(64);

    // Position size difference changes fingerprint
    const fpDiffSize = computeDecisionFingerprint({
      ...baseParams,
      positionSize: 2.0
    });
    expect(fpDiffSize).not.toBe(fp1);

    // Strategy config hash change changes fingerprint
    const fpDiffStrat = computeDecisionFingerprint({
      ...baseParams,
      strategyConfigHash: 'strat-hash-MODIFIED'
    });
    expect(fpDiffStrat).not.toBe(fp1);

    // Action change changes fingerprint
    const fpDiffAction = computeDecisionFingerprint({
      ...baseParams,
      action: 'HOLD',
      signal: 'NO_SETUP'
    });
    expect(fpDiffAction).not.toBe(fp1);
  });

  it('creates frozen immutable DecisionContext', () => {
    const context: DecisionContext = deepFreeze({
      decisionId: 'dec-101',
      snapshotId: snapshot.snapshotId,
      snapshotHash: snapshot.snapshotHash,
      decisionTimestamp: 1700000000050,
      instrument: snapshot.instrument,
      marketSnapshot: snapshot,
      portfolioSnapshot,
      featureVersion: 'feat-v2',
      featureSchemaHash: 'fhash-99',
      featureInputHash: 'feat-input-hash-01',
      featureDataCutoff: snapshot.timestamp,
      strategyVersion: 'strat-smc-v1',
      strategyConfigHash: 'strat-hash-1',
      executionConfigVersion: 'exec-v1',
      executionConfigHash: 'exec-hash-1',
      riskConfigVersion: 'risk-v1',
      riskConfigHash: 'risk-hash-1',
      costConfigVersion: 'cost-v1',
      costConfigHash: 'cost-hash-1',
      portfolioStateVersion: 'port-v1',
      portfolioStateHash: portfolioSnapshot.portfolioStateHash,
      modelIdentity: baseModelIdentity,
      evaluationFingerprint: 'eval-fp-101',
      mode: 'LIVE',
      modelRole: 'CHAMPION'
    });

    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.marketSnapshot)).toBe(true);
    expect(Object.isFrozen(context.portfolioSnapshot)).toBe(true);
    expect(() => {
      (context as any).mode = 'SHADOW';
    }).toThrow();
  });
});
