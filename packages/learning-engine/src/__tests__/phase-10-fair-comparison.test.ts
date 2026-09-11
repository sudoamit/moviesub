import {
  createEvaluationIdentity,
  createEvaluationBundle,
  FairComparisonEngine,
  EvaluationMetrics,
  TradeStatistics,
  RiskStatistics,
  CostStatistics
} from '../champion-challenger/index';

describe('Phase 10 — Fair Comparison Engine & Environmental Parity', () => {
  const baseMetricsChampion: EvaluationMetrics = {
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

  const sharedEnv = {
    datasetVersion: 'ds-canonical-2024',
    datasetHash: 'hash-data-canon',
    featureVersion: 'feat-v2',
    featureSchemaHash: 'hash-feat-schema',
    labelVersion: 'lbl-triple-barrier-v1',
    codeCommit: 'commit-prod-01',
    walkForwardConfigVersion: 'wf-anchored-6m',
    walkForwardConfigHash: 'wf-anchored-6m-hash',
    executionConfigVersion: 'exec-sim-v2',
    executionConfigHash: 'hash-exec-sim',
    riskConfigVersion: 'risk-std-v1',
    riskConfigHash: 'hash-risk-std',
    costConfigVersion: 'cost-binance-vip0',
    costConfigHash: 'hash-cost-model',
    partialExitPolicyVersion: 'pep-2tp-v1',
    partialExitPolicyHash: 'pep-2tp-v1-hash',
    strategyConfigVersion: 'strat-smc-v2',
    strategyConfigHash: 'strat-smc-v2-hash',
    evaluationWindowStart: 1700000000000,
    evaluationWindowEnd: 1705000000000,
    randomSeed: 42
  };

  it('validates 100% comparable environments and calculates metric deltas', () => {
    const championIdentity = createEvaluationIdentity({
      evaluationId: 'eval-champ',
      modelId: 'champ-model',
      modelVersion: '1.0.0',
      artifactHash: 'hash-champ-art',
      trainingRunId: 'run-champ-01',
      ...sharedEnv
    });

    const challengerIdentity = createEvaluationIdentity({
      evaluationId: 'eval-chall',
      modelId: 'chall-model',
      modelVersion: '2.0.0',
      artifactHash: 'hash-chall-art',
      trainingRunId: 'run-chall-02',
      ...sharedEnv
    });

    const challengerMetrics: EvaluationMetrics = {
      netPnL: 18500,
      totalReturn: 0.185,
      maxDrawdownPercent: 5.2,
      profitFactor: 2.1,
      winRate: 0.62,
      tradeCount: 135,
      averageTrade: 137,
      averageWin: 370,
      averageLoss: -175,
      expectancy: 1.45,
      fees: 480,
      slippage: 310,
      sharpeRatio: 2.15,
      sortinoRatio: 2.85,
      cagr: 0.28
    };

    const champBundle = createEvaluationBundle({
      evaluationIdentity: championIdentity,
      metrics: baseMetricsChampion,
      tradeStatistics: baseTradeStats,
      riskStatistics: baseRiskStats,
      costStatistics: baseCostStats
    });

    const challBundle = createEvaluationBundle({
      evaluationIdentity: challengerIdentity,
      metrics: challengerMetrics,
      tradeStatistics: { ...baseTradeStats, winningTrades: 84, losingTrades: 51 },
      riskStatistics: { ...baseRiskStats, maxDrawdownPercent: 5.2 },
      costStatistics: { ...baseCostStats, totalFees: 480, totalSlippage: 310 }
    });

    const comparison = FairComparisonEngine.compareEvaluations(champBundle, challBundle);

    expect(comparison.isComparable).toBe(true);
    expect(comparison.violationReasons.length).toBe(0);
    expect(comparison.deltas).toBeDefined();

    if (comparison.deltas) {
      expect(comparison.deltas.netPnlDelta).toBe(3500);
      expect(comparison.deltas.expectancyDelta).toBeCloseTo(0.20, 5);
      expect(comparison.deltas.drawdownDelta).toBeCloseTo(-1.3, 5);
    }
  });

  it('fails closed when codeCommit diverges between champion and challenger', () => {
    const champBundle = createEvaluationBundle({
      evaluationIdentity: createEvaluationIdentity({
        evaluationId: 'eval-champ',
        modelId: 'champ-model',
        modelVersion: '1.0.0',
        artifactHash: 'hash-champ-art',
        trainingRunId: 'run-champ-01',
        ...sharedEnv,
        codeCommit: 'commit-ABC'
      }),
      metrics: baseMetricsChampion,
      tradeStatistics: baseTradeStats,
      riskStatistics: baseRiskStats,
      costStatistics: baseCostStats
    });

    const challBundle = createEvaluationBundle({
      evaluationIdentity: createEvaluationIdentity({
        evaluationId: 'eval-chall',
        modelId: 'chall-model',
        modelVersion: '2.0.0',
        artifactHash: 'hash-chall-art',
        trainingRunId: 'run-chall-02',
        ...sharedEnv,
        codeCommit: 'commit-XYZ'
      }),
      metrics: baseMetricsChampion,
      tradeStatistics: baseTradeStats,
      riskStatistics: baseRiskStats,
      costStatistics: baseCostStats
    });

    const comparison = FairComparisonEngine.compareEvaluations(champBundle, challBundle);
    expect(comparison.isComparable).toBe(false);
    expect(comparison.violationReasons.some((r: string) => r.includes('Code commit mismatch'))).toBe(true);
    expect(comparison.deltas).toBeUndefined();
  });

  it('fails closed when strategyConfigHash diverges even if version string matches', () => {
    const champBundle = createEvaluationBundle({
      evaluationIdentity: createEvaluationIdentity({
        evaluationId: 'eval-champ',
        modelId: 'champ-model',
        modelVersion: '1.0.0',
        artifactHash: 'hash-champ-art',
        trainingRunId: 'run-champ-01',
        ...sharedEnv,
        strategyConfigVersion: 'v1.0',
        strategyConfigHash: 'strat-hash-original'
      }),
      metrics: baseMetricsChampion,
      tradeStatistics: baseTradeStats,
      riskStatistics: baseRiskStats,
      costStatistics: baseCostStats
    });

    const challBundle = createEvaluationBundle({
      evaluationIdentity: createEvaluationIdentity({
        evaluationId: 'eval-chall',
        modelId: 'chall-model',
        modelVersion: '2.0.0',
        artifactHash: 'hash-chall-art',
        trainingRunId: 'run-chall-02',
        ...sharedEnv,
        strategyConfigVersion: 'v1.0',
        strategyConfigHash: 'strat-hash-TAMPERED'
      }),
      metrics: baseMetricsChampion,
      tradeStatistics: baseTradeStats,
      riskStatistics: baseRiskStats,
      costStatistics: baseCostStats
    });

    const comparison = FairComparisonEngine.compareEvaluations(champBundle, challBundle);
    expect(comparison.isComparable).toBe(false);
    expect(comparison.violationReasons.some((r: string) => r.includes('Strategy config hash mismatch'))).toBe(true);
    expect(comparison.deltas).toBeUndefined();
  });

  it('fails closed when walkForwardConfigHash or partialExitPolicyHash diverges', () => {
    const champBundle = createEvaluationBundle({
      evaluationIdentity: createEvaluationIdentity({
        evaluationId: 'eval-champ',
        modelId: 'champ-model',
        modelVersion: '1.0.0',
        artifactHash: 'hash-champ-art',
        trainingRunId: 'run-champ-01',
        ...sharedEnv
      }),
      metrics: baseMetricsChampion,
      tradeStatistics: baseTradeStats,
      riskStatistics: baseRiskStats,
      costStatistics: baseCostStats
    });

    const challBundleWf = createEvaluationBundle({
      evaluationIdentity: createEvaluationIdentity({
        evaluationId: 'eval-chall',
        modelId: 'chall-model',
        modelVersion: '2.0.0',
        artifactHash: 'hash-chall-art',
        trainingRunId: 'run-chall-02',
        ...sharedEnv,
        walkForwardConfigHash: 'wf-diff-hash'
      }),
      metrics: baseMetricsChampion,
      tradeStatistics: baseTradeStats,
      riskStatistics: baseRiskStats,
      costStatistics: baseCostStats
    });

    const comparisonWf = FairComparisonEngine.compareEvaluations(champBundle, challBundleWf);
    expect(comparisonWf.isComparable).toBe(false);
    expect(comparisonWf.violationReasons.some((r: string) => r.includes('Walk-forward config hash mismatch'))).toBe(true);

    const challBundlePep = createEvaluationBundle({
      evaluationIdentity: createEvaluationIdentity({
        evaluationId: 'eval-chall',
        modelId: 'chall-model',
        modelVersion: '2.0.0',
        artifactHash: 'hash-chall-art',
        trainingRunId: 'run-chall-02',
        ...sharedEnv,
        partialExitPolicyHash: 'pep-diff-hash'
      }),
      metrics: baseMetricsChampion,
      tradeStatistics: baseTradeStats,
      riskStatistics: baseRiskStats,
      costStatistics: baseCostStats
    });

    const comparisonPep = FairComparisonEngine.compareEvaluations(champBundle, challBundlePep);
    expect(comparisonPep.isComparable).toBe(false);
    expect(comparisonPep.violationReasons.some((r: string) => r.includes('Partial exit policy hash mismatch'))).toBe(true);
  });
});
