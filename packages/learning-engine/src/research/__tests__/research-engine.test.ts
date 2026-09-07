import { ExperimentRegistry } from '../experiment-registry';
import { HypothesisEngine } from '../hypothesis-engine';
import { ExperimentManager } from '../experiment-manager';
import { ResearchMemory } from '../research-memory';
import { KnowledgeGraphEngine } from '../knowledge-graph';
import { ScorecardEngine } from '../scorecard';
import { LLMResearchAssistant } from '../llm-research-assistant';
import { ResearchEngine } from '../research-engine';
import { TradingExperience } from '../../types';
import { ICandle } from '@quant/shared';

describe('SMC PRO Self-Improving Research Engine Suite', () => {
  beforeEach(() => {
    ExperimentRegistry.clear();
    ResearchMemory.clear();
    KnowledgeGraphEngine.clear();
  });

  const mockCandles: ICandle[] = Array.from({ length: 100 }, (_, i) => ({
    timestamp: new Date(Date.now() - (100 - i) * 15 * 60000),
    open: 24000 + i * 5,
    high: 24010 + i * 5,
    low: 23990 + i * 5,
    close: 24005 + i * 5,
    volume: 15000 + (i % 10) * 1000,
  }));

  const mockExperiences: TradingExperience[] = [
    {
      id: 'exp-1',
      tradeId: 't-1',
      timestamp: new Date(Date.now() - 3600000),
      instrument: { symbol: 'NIFTY', assetType: 'INDEX' },
      marketState: { candles: mockCandles },
      decision: { action: 'BUY', score: 85 },
      execution: {
        entryPrice: 24100,
        entryTime: new Date(Date.now() - 3600000),
        exitPrice: 24200,
        exitTime: new Date(),
      },
      risk: { stopLoss: 24050, target1: 24175, target2: 24225 },
      prediction: { probabilityWin: 0.82 },
      outcome: {
        status: 'WIN',
        pnl: 6500,
        pnlR: 2.0,
        maxFavorableExcursion: 2.5,
        maxAdverseExcursion: 0.2,
        holdingTimeSeconds: 1800,
      },
      marketContext: {
        regime: 'BULLISH_TREND',
        volatilityRegime: 'NORMAL',
        session: 'REGULAR',
        dayOfWeek: 2,
      },
      outcomeClassification: 'GOOD_TRADE_WIN',
      reasons: ['BOS Breakout'],
      failureReasons: [],
      strategyVersion: 'v2.0-smc-quant',
      featureSchemaVersion: '2.0',
      createdAt: new Date(),
    },
    {
      id: 'exp-2',
      tradeId: 't-2',
      timestamp: new Date(Date.now() - 7200000),
      instrument: { symbol: 'NIFTY', assetType: 'INDEX' },
      marketState: { candles: mockCandles },
      decision: { action: 'BUY', score: 78 },
      execution: {
        entryPrice: 24150,
        entryTime: new Date(Date.now() - 7200000),
        exitPrice: 24100,
        exitTime: new Date(Date.now() - 5400000),
      },
      risk: { stopLoss: 24100, target1: 24225, target2: 24275 },
      prediction: { probabilityWin: 0.79 },
      outcome: {
        status: 'LOSS',
        pnl: -3250,
        pnlR: -1.0,
        maxFavorableExcursion: 0.3,
        maxAdverseExcursion: 1.0,
        holdingTimeSeconds: 1200,
      },
      marketContext: {
        regime: 'BEARISH_TREND',
        volatilityRegime: 'HIGH_VOLATILITY',
        session: 'REGULAR',
        dayOfWeek: 2,
      },
      outcomeClassification: 'BAD_TRADE_LOSS',
      reasons: ['Countertrend FVG'],
      failureReasons: ['HTF_CONFLICT', 'VOLATILITY_MISREAD'],
      strategyVersion: 'v2.0-smc-quant',
      featureSchemaVersion: '2.0',
      createdAt: new Date(),
    },
    {
      id: 'exp-3',
      tradeId: 't-3',
      timestamp: new Date(Date.now() - 10800000),
      instrument: { symbol: 'NIFTY', assetType: 'INDEX' },
      marketState: { candles: mockCandles },
      decision: { action: 'BUY', score: 81 },
      execution: {
        entryPrice: 24200,
        entryTime: new Date(Date.now() - 10800000),
        exitPrice: 24150,
        exitTime: new Date(Date.now() - 9000000),
      },
      risk: { stopLoss: 24150 },
      prediction: { probabilityWin: 0.81 },
      outcome: {
        status: 'LOSS',
        pnl: -3250,
        pnlR: -1.0,
        maxFavorableExcursion: 0.2,
        maxAdverseExcursion: 1.0,
        holdingTimeSeconds: 900,
      },
      marketContext: {
        regime: 'BEARISH_TREND',
        volatilityRegime: 'HIGH_VOLATILITY',
        session: 'REGULAR',
        dayOfWeek: 2,
      },
      outcomeClassification: 'BAD_TRADE_LOSS',
      reasons: ['Liquidity Sweep'],
      failureReasons: ['HTF_CONFLICT', 'WEAK_DISPLACEMENT'],
      strategyVersion: 'v2.0-smc-quant',
      featureSchemaVersion: '2.0',
      createdAt: new Date(),
    },
  ];

  it('should compute deterministic experiment hash accurately', () => {
    const hash1 = ExperimentRegistry.computeExperimentHash({
      datasetVersion: 'ds_nifty_15m_v1',
      strategyVersion: 'v2.1-canary',
      featureSchemaVersion: '2.0',
      instrument: 'NIFTY',
      timeframe: '15m',
      parameters: { displacementRatio: 1.25 },
      trainingPeriod: { start: new Date('2026-01-01'), end: new Date('2026-06-01') },
      validationPeriod: { start: new Date('2026-06-01'), end: new Date('2026-08-01') },
      testPeriod: { start: new Date('2026-08-01'), end: new Date('2026-09-01') },
    });

    const hash2 = ExperimentRegistry.computeExperimentHash({
      datasetVersion: 'ds_nifty_15m_v1',
      strategyVersion: 'v2.1-canary',
      featureSchemaVersion: '2.0',
      instrument: 'NIFTY',
      timeframe: '15m',
      parameters: { displacementRatio: 1.25 },
      trainingPeriod: { start: new Date('2026-01-01'), end: new Date('2026-06-01') },
      validationPeriod: { start: new Date('2026-06-01'), end: new Date('2026-08-01') },
      testPeriod: { start: new Date('2026-08-01'), end: new Date('2026-09-01') },
    });

    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(16);
  });

  it('should build and query multidimensional Knowledge Graph relationships', () => {
    const graph = KnowledgeGraphEngine.buildFromExperiences(mockExperiences);
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);

    const regimeNode = graph.nodes.find((n) => n.type === 'REGIME' && n.name === 'BEARISH_TREND');
    expect(regimeNode).toBeDefined();
    expect(regimeNode?.frequency).toBe(2);
  });

  it('should run Monte Carlo simulation and stress testing in ExperimentManager', () => {
    const trades = [
      { pnlR: 2.0, pnl: 6500, isWin: true },
      { pnlR: -1.0, pnl: -3250, isWin: false },
      { pnlR: 1.5, pnl: 4800, isWin: true },
      { pnlR: -1.0, pnl: -3250, isWin: false },
      { pnlR: 3.0, pnl: 9750, isWin: true },
    ];

    const mc = ExperimentManager.runMonteCarloSimulation(trades, 200);
    expect(mc.iterations).toBe(200);
    expect(mc.probabilityOfRuin).toBeLessThanOrEqual(0.05);

    const slippageStress = ExperimentManager.runSlippageStress(trades);
    expect(slippageStress.length).toBe(3);
    expect(slippageStress[0].multiplier).toBe(1.0);
    expect(slippageStress[2].multiplier).toBe(3.0);
  });

  it('should generate Self-Improvement Scorecard and Learning Scorecard', () => {
    const selfScorecard = ScorecardEngine.generateSelfImprovementScorecard({
      experiencesCount: 150,
      newPatternsCount: 5,
      currentProductionVersion: 'v2.0-smc-quant',
      shadowCount: 2,
    });

    expect(selfScorecard.experiencesCount).toBe(150);
    expect(selfScorecard.currentProductionVersion).toBe('v2.0-smc-quant');
    expect(selfScorecard.systemState).toBeDefined();

    const learningScorecard = ScorecardEngine.generateLearningScorecard();
    expect(learningScorecard.versions.length).toBeGreaterThan(1);
    expect(learningScorecard.expectancyTrend.deltaR).toBeGreaterThan(0);
  });

  it('should execute end-to-end research cycle via ResearchEngine', async () => {
    // Feed 15 experiences to meet sample size requirements
    const expandedExperiences: TradingExperience[] = [];
    for (let i = 0; i < 15; i++) {
      expandedExperiences.push({
        ...mockExperiences[i % 3],
        id: `exp-${i}`,
        tradeId: `t-${i}`,
      });
    }

    const result = await ResearchEngine.runResearchCycle(expandedExperiences, mockCandles, {
      instrument: 'NIFTY',
      timeframe: '15m',
    });

    expect(result.scorecard).toBeDefined();
    expect(result.knowledgeGraph.nodes.length).toBeGreaterThan(0);
  });
});
