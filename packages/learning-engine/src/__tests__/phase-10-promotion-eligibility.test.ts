import {
  createEvaluationIdentity,
  createEvaluationBundle,
  FairComparisonEngine,
  PromotionEligibilityEvaluator,
  FairPromotionCriteria,
  EvaluationMetrics,
  TradeStatistics,
  RiskStatistics,
  CostStatistics
} from '../champion-challenger/index';

describe('Phase 10 — Promotion Eligibility Evaluator (Pure Function)', () => {
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

  it('evaluates promotion eligibility purely with zero side effects', () => {
    const champBundle = createEvaluationBundle({
      evaluationIdentity: createEvaluationIdentity({
        evaluationId: 'e-champ',
        modelId: 'm-champ',
        modelVersion: '1.0.0',
        artifactHash: 'hash-champ',
        trainingRunId: 'r-champ',
        ...sharedEnv
      }),
      metrics: baseMetricsChampion,
      tradeStatistics: baseTradeStats,
      riskStatistics: baseRiskStats,
      costStatistics: baseCostStats
    });

    const challBundle = createEvaluationBundle({
      evaluationIdentity: createEvaluationIdentity({
        evaluationId: 'e-chall',
        modelId: 'm-chall',
        modelVersion: '2.0.0',
        artifactHash: 'hash-chall',
        trainingRunId: 'r-chall',
        ...sharedEnv
      }),
      metrics: {
        ...baseMetricsChampion,
        expectancy: 1.55, // +0.30
        maxDrawdownPercent: 7.0, // +0.5% deterioration
        tradeCount: 150,
        winRate: 0.60,
        sharpeRatio: 2.10,
        profitFactor: 2.0
      },
      tradeStatistics: baseTradeStats,
      riskStatistics: baseRiskStats,
      costStatistics: baseCostStats
    });

    const comparison = FairComparisonEngine.compareEvaluations(champBundle, challBundle);
    expect(comparison.isComparable).toBe(true);

    const criteria: FairPromotionCriteria = {
      minTradeCount: 100,
      minExpectancyDelta: 0.10,
      maxDrawdownDeteriorationPercent: 1.0,
      minWinRateDelta: 0.01,
      minSharpeDelta: 0.15,
      minProfitFactor: 1.9
    };

    const eligibility = PromotionEligibilityEvaluator.calculatePromotionEligibility(comparison, criteria);

    expect(eligibility.eligible).toBe(true);
    expect(eligibility.criteriaMet.minTradeCount).toBe(true);
    expect(eligibility.criteriaMet.minExpectancyDelta).toBe(true);
    expect(eligibility.criteriaMet.maxDrawdownDeterioration).toBe(true);
    expect(eligibility.criteriaMet.minSharpeDelta).toBe(true);
    expect(eligibility.criteriaMet.minProfitFactor).toBe(true);
  });

  it('fails closed and reports ineligibility when hurdles are not met', () => {
    const champBundle = createEvaluationBundle({
      evaluationIdentity: createEvaluationIdentity({
        evaluationId: 'e-champ',
        modelId: 'm-champ',
        modelVersion: '1.0.0',
        artifactHash: 'hash-champ',
        trainingRunId: 'r-champ',
        ...sharedEnv
      }),
      metrics: baseMetricsChampion,
      tradeStatistics: baseTradeStats,
      riskStatistics: baseRiskStats,
      costStatistics: baseCostStats
    });

    const challBundleUnderperforming = createEvaluationBundle({
      evaluationIdentity: createEvaluationIdentity({
        evaluationId: 'e-chall-bad',
        modelId: 'm-chall-bad',
        modelVersion: '2.0.0',
        artifactHash: 'hash-chall-bad',
        trainingRunId: 'r-chall-bad',
        ...sharedEnv
      }),
      metrics: {
        ...baseMetricsChampion,
        expectancy: 1.10, // Worse expectancy (-0.15)
        maxDrawdownPercent: 10.0, // Drawdown deterioration +3.5%
        tradeCount: 80 // Less than min 100
      },
      tradeStatistics: baseTradeStats,
      riskStatistics: baseRiskStats,
      costStatistics: baseCostStats
    });

    const comparison = FairComparisonEngine.compareEvaluations(champBundle, challBundleUnderperforming);
    const eligibility = PromotionEligibilityEvaluator.calculatePromotionEligibility(comparison, {
      minTradeCount: 100,
      minExpectancyDelta: 0.05,
      maxDrawdownDeteriorationPercent: 1.0
    });

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.criteriaMet.minTradeCount).toBe(false);
    expect(eligibility.criteriaMet.minExpectancyDelta).toBe(false);
    expect(eligibility.criteriaMet.maxDrawdownDeterioration).toBe(false);
    expect(eligibility.reasons.length).toBeGreaterThan(0);
  });
});
