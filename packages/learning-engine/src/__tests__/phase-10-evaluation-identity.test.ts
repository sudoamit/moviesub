import {
  createEvaluationIdentity,
  computeEvaluationFingerprint,
  createEvaluationBundle,
  computeResultHash,
  computeBundleHash,
  EvaluationMetrics,
  TradeStatistics,
  RiskStatistics,
  CostStatistics
} from '../champion-challenger/index';

describe('Phase 10 — Evaluation Identity, Deterministic Fingerprint & Bundle Integrity', () => {
  const baseMetrics: EvaluationMetrics = {
    netPnL: 15000,
    totalReturn: 0.15,
    maxDrawdownPercent: 6.5,
    profitFactor: 1.8,
    winRate: 0.58,
    tradeCount: 120,
    averageTrade: 125,
    averageWin: 350,
    averageLoss: -185,
    expectancy: 1.25,
    fees: 450,
    slippage: 300,
    sharpeRatio: 1.85,
    sortinoRatio: 2.40,
    cagr: 0.22
  };

  const baseTradeStats: TradeStatistics = {
    grossProfit: 24500,
    grossLoss: 8750,
    winningTrades: 70,
    losingTrades: 50,
    maxConsecutiveWins: 6,
    maxConsecutiveLosses: 3,
    averageHoldingPeriodMs: 3600000
  };

  const baseRiskStats: RiskStatistics = {
    maxDrawdownAmount: 6500,
    maxDrawdownPercent: 6.5,
    valueAtRisk95: 1200,
    conditionalVaR95: 1800
  };

  const baseCostStats: CostStatistics = {
    totalFees: 450,
    totalSlippage: 300,
    feeDragPercent: 0.03,
    slippageDragPercent: 0.02
  };

  const baseEnvParams = {
    modelId: 'model-v1',
    modelVersion: '1.0.0',
    artifactHash: 'hash-weights-123',
    trainingRunId: 'run-001',
    datasetVersion: 'ds-1',
    datasetHash: 'dshash1',
    featureVersion: 'feat-1',
    featureSchemaHash: 'fshash1',
    labelVersion: 'lbl-1',
    codeCommit: 'commit-abc',
    walkForwardConfigVersion: 'wf-1',
    walkForwardConfigHash: 'wfhash1',
    executionConfigVersion: 'exec-1',
    executionConfigHash: 'exechash1',
    riskConfigVersion: 'risk-1',
    riskConfigHash: 'riskhash1',
    costConfigVersion: 'cost-1',
    costConfigHash: 'costhash1',
    partialExitPolicyVersion: 'pep-1',
    partialExitPolicyHash: 'pephash1',
    strategyConfigVersion: 'strat-1',
    strategyConfigHash: 'strathash1',
    evaluationWindowStart: 1700000000000,
    evaluationWindowEnd: 1705000000000,
    randomSeed: 42
  };

  it('generates identical fingerprints regardless of execution time or evaluationId', () => {
    const id1 = createEvaluationIdentity({
      ...baseEnvParams,
      evaluationId: 'eval-time-1',
      createdAt: 1000000000
    });

    const id2 = createEvaluationIdentity({
      ...baseEnvParams,
      evaluationId: 'eval-time-2',
      createdAt: 9999999999
    });

    const fp1 = computeEvaluationFingerprint(id1);
    const fp2 = computeEvaluationFingerprint(id2);

    expect(fp1).toBe(fp2);
  });

  it('changes fingerprint when artifactHash changes (model artifact sensitivity)', () => {
    const idA = createEvaluationIdentity({
      ...baseEnvParams,
      artifactHash: 'HASH_MODEL_A'
    });

    const idB = createEvaluationIdentity({
      ...baseEnvParams,
      artifactHash: 'HASH_MODEL_B'
    });

    const fpA = computeEvaluationFingerprint(idA);
    const fpB = computeEvaluationFingerprint(idB);

    expect(fpA).not.toBe(fpB);
  });

  it('changes fingerprint when any evaluation parameter changes', () => {
    const baseFp = computeEvaluationFingerprint(createEvaluationIdentity(baseEnvParams));

    // Code commit change
    const fpCommit = computeEvaluationFingerprint(createEvaluationIdentity({
      ...baseEnvParams,
      codeCommit: 'commit-different'
    }));
    expect(fpCommit).not.toBe(baseFp);

    // Strategy config hash change
    const fpStrat = computeEvaluationFingerprint(createEvaluationIdentity({
      ...baseEnvParams,
      strategyConfigHash: 'strathash-diff'
    }));
    expect(fpStrat).not.toBe(baseFp);

    // Random seed change
    const fpSeed = computeEvaluationFingerprint(createEvaluationIdentity({
      ...baseEnvParams,
      randomSeed: 999
    }));
    expect(fpSeed).not.toBe(baseFp);
  });

  it('alters resultHash and bundleHash whenever any evaluation metric changes (mutation sensitivity)', () => {
    const identity = createEvaluationIdentity(baseEnvParams);

    const originalBundle = createEvaluationBundle({
      evaluationIdentity: identity,
      metrics: baseMetrics,
      tradeStatistics: baseTradeStats,
      riskStatistics: baseRiskStats,
      costStatistics: baseCostStats
    });

    // Mutate netPnL by 1 unit: 15000 -> 15001
    const modifiedMetrics: EvaluationMetrics = {
      ...baseMetrics,
      netPnL: 15001
    };

    const modifiedBundle = createEvaluationBundle({
      evaluationIdentity: identity,
      metrics: modifiedMetrics,
      tradeStatistics: baseTradeStats,
      riskStatistics: baseRiskStats,
      costStatistics: baseCostStats
    });

    // Fingerprint should be identical (same identity)
    expect(originalBundle.evaluationFingerprint).toBe(modifiedBundle.evaluationFingerprint);

    // Result hash must differ
    expect(originalBundle.resultHash).not.toBe(modifiedBundle.resultHash);

    // Bundle hash must differ
    expect(originalBundle.bundleHash).not.toBe(modifiedBundle.bundleHash);
  });

  it('computes resultHash and bundleHash for complete auditability', () => {
    const identity = createEvaluationIdentity(baseEnvParams);
    const bundle = createEvaluationBundle({
      evaluationIdentity: identity,
      metrics: baseMetrics,
      tradeStatistics: baseTradeStats,
      riskStatistics: baseRiskStats,
      costStatistics: baseCostStats
    });

    expect(bundle.evaluationFingerprint.length).toBe(64);
    expect(bundle.resultHash.length).toBe(64);
    expect(bundle.bundleHash.length).toBe(64);

    const expectedResultHash = computeResultHash({
      metrics: baseMetrics,
      tradeStatistics: baseTradeStats,
      riskStatistics: baseRiskStats,
      costStatistics: baseCostStats
    });
    expect(bundle.resultHash).toBe(expectedResultHash);

    const expectedBundleHash = computeBundleHash(bundle.evaluationFingerprint, bundle.resultHash);
    expect(bundle.bundleHash).toBe(expectedBundleHash);
  });

  it('fails closed when required evaluation identity fields are missing or invalid', () => {
    expect(() => {
      createEvaluationIdentity({
        ...baseEnvParams,
        codeCommit: ''
      });
    }).toThrow(/INVALID_EVALUATION_IDENTITY: Missing or invalid required field 'codeCommit'/);

    expect(() => {
      createEvaluationIdentity({
        ...baseEnvParams,
        evaluationWindowStart: 2000,
        evaluationWindowEnd: 1000 // Inverted window
      });
    }).toThrow(/INVALID_EVALUATION_IDENTITY: evaluationWindowStart must be strictly less than evaluationWindowEnd/);
  });

  it('deep-freezes evaluation identity and bundle against runtime mutation', () => {
    const identity = createEvaluationIdentity(baseEnvParams);
    const bundle = createEvaluationBundle({
      evaluationIdentity: identity,
      metrics: baseMetrics,
      tradeStatistics: baseTradeStats,
      riskStatistics: baseRiskStats,
      costStatistics: baseCostStats
    });

    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.metrics)).toBe(true);

    expect(() => {
      (bundle as any).metrics.netPnL = 999999;
    }).toThrow();
  });
});
