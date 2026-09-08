"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const experiment_registry_1 = require("../experiment-registry");
const experiment_manager_1 = require("../experiment-manager");
const research_memory_1 = require("../research-memory");
const knowledge_graph_1 = require("../knowledge-graph");
const scorecard_1 = require("../scorecard");
const research_engine_1 = require("../research-engine");
describe('SMC PRO Self-Improving Research Engine Suite', () => {
    beforeEach(() => {
        experiment_registry_1.ExperimentRegistry.clear();
        research_memory_1.ResearchMemory.clear();
        knowledge_graph_1.KnowledgeGraphEngine.clear();
    });
    const mockCandles = Array.from({ length: 100 }, (_, i) => ({
        timestamp: new Date(Date.now() - (100 - i) * 15 * 60000),
        open: 24000 + i * 5,
        high: 24010 + i * 5,
        low: 23990 + i * 5,
        close: 24005 + i * 5,
        volume: 15000 + (i % 10) * 1000,
    }));
    const mockExperiences = [
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
        const hash1 = experiment_registry_1.ExperimentRegistry.computeExperimentHash({
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
        const hash2 = experiment_registry_1.ExperimentRegistry.computeExperimentHash({
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
        const graph = knowledge_graph_1.KnowledgeGraphEngine.buildFromExperiences(mockExperiences);
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
        const mc = experiment_manager_1.ExperimentManager.runMonteCarloSimulation(trades, 200);
        expect(mc.iterations).toBe(200);
        expect(mc.probabilityOfRuin).toBeLessThanOrEqual(0.05);
        const slippageStress = experiment_manager_1.ExperimentManager.runSlippageStress(trades);
        expect(slippageStress.length).toBe(3);
        expect(slippageStress[0].multiplier).toBe(1.0);
        expect(slippageStress[2].multiplier).toBe(3.0);
    });
    it('should generate Self-Improvement Scorecard and Learning Scorecard', () => {
        const selfScorecard = scorecard_1.ScorecardEngine.generateSelfImprovementScorecard({
            experiencesCount: 150,
            newPatternsCount: 5,
            currentProductionVersion: 'v2.0-smc-quant',
            shadowCount: 2,
        });
        expect(selfScorecard.experiencesCount).toBe(150);
        expect(selfScorecard.currentProductionVersion).toBe('v2.0-smc-quant');
        expect(selfScorecard.systemState).toBeDefined();
        const learningScorecard = scorecard_1.ScorecardEngine.generateLearningScorecard();
        expect(learningScorecard.versions.length).toBeGreaterThan(1);
        expect(learningScorecard.expectancyTrend.deltaR).toBeGreaterThan(0);
    });
    it('should execute end-to-end research cycle via ResearchEngine', async () => {
        // Feed 15 experiences to meet sample size requirements
        const expandedExperiences = [];
        for (let i = 0; i < 15; i++) {
            expandedExperiences.push({
                ...mockExperiences[i % 3],
                id: `exp-${i}`,
                tradeId: `t-${i}`,
            });
        }
        const result = await research_engine_1.ResearchEngine.runResearchCycle(expandedExperiences, mockCandles, {
            instrument: 'NIFTY',
            timeframe: '15m',
        });
        expect(result.scorecard).toBeDefined();
        expect(result.knowledgeGraph.nodes.length).toBeGreaterThan(0);
    });
});
//# sourceMappingURL=research-engine.test.js.map