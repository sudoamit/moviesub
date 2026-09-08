"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const ai_learning_service_1 = require("../ai-learning.service");
const prisma_service_1 = require("../../common/prisma/prisma.service");
const signals_service_1 = require("../../signals/signals.service");
const smc_service_1 = require("../../smc/smc.service");
const accuracy_service_1 = require("../../accuracy/accuracy.service");
const library_1 = require("@prisma/client/runtime/library");
describe('AILearningService Snapshot-Driven Learning & Prediction Safety', () => {
    let service;
    let mockPrisma;
    let mockSignalsService;
    let mockSmcService;
    let mockAccuracyService;
    beforeEach(async () => {
        mockPrisma = {
            candle: {
                findMany: jest.fn().mockResolvedValue([]),
                findFirst: jest.fn().mockResolvedValue(null),
            },
            paperTrade: {
                findUnique: jest.fn().mockImplementation((args) => {
                    if (args.where.id === 'trade-1') {
                        return Promise.resolve({
                            id: 'trade-1',
                            symbol: 'NIFTY',
                            direction: 'BULLISH',
                            entryPrice: new library_1.Decimal(24100.0),
                            exitPrice: new library_1.Decimal(24200.0),
                            realizedPnL: new library_1.Decimal(5000.0),
                            realizedR: new library_1.Decimal(2.0),
                            holdingDurationSeconds: 1800,
                            entryTime: new Date(Date.now() - 1800000),
                            exitTime: new Date(),
                            exitReason: 'TP1_HIT',
                            featureSnapshotJson: {
                                smcScore: 0.85,
                                obStrength: 0.75,
                                fvgSize: 0.6,
                                mtfAlignment: 0.9,
                                killZoneSession: 1.0,
                                smtDivergence: 0.5,
                                volatilityAtr: 0.4,
                                riskRewardRatio: 0.7,
                                trendRegime: 0.8,
                                liquiditySweep: 0.75,
                                bosStrength: 0.7,
                                chochStrength: 0.6,
                                relativeVolume: 0.65,
                                distanceToHTFLevel: 0.3,
                                distanceToLiquidity: 0.4,
                                marketSession: 0.5,
                                dayOfWeek: 0.3,
                            },
                            outcomeSnapshotJson: {
                                exitReason: 'TP1_HIT',
                                realizedPnL: 5000.0,
                                realizedR: 2.0,
                                holdingDurationSeconds: 1800,
                                outcomeClassification: 'WIN_TP1',
                                exitPrice: 24200.0,
                                exitTime: new Date().toISOString(),
                            },
                        });
                    }
                    return Promise.resolve(null);
                }),
                findMany: jest.fn().mockResolvedValue([]),
            },
            aIRetrainJob: {
                findMany: jest.fn().mockResolvedValue([]),
                findFirst: jest.fn().mockResolvedValue(null),
            },
            instrument: {
                findUnique: jest.fn().mockResolvedValue({ id: 'inst-1', symbol: 'NIFTY' }),
            },
        };
        mockSignalsService = {
            getSignals: jest.fn().mockResolvedValue([]),
            generateSignalForSymbol: jest.fn().mockImplementation(() => Promise.resolve({
                symbol: 'NIFTY',
                timeframe: '15m',
                score: 75,
                grade: 'A',
                direction: 'BULLISH',
                entryZone: { min: 24090, max: 24110, optimal: 24100 },
                stopLoss: 24050,
                takeProfits: { tp1: 24150, tp2: 24200, tp3: 24250 },
                riskRewardRatios: { rr1: 1.0, rr2: 2.0, rr3: 3.0 },
                timestamp: new Date().toISOString(),
            })),
        };
        mockSmcService = {
            analyze: jest.fn().mockResolvedValue({}),
            getSMCAnalysis: jest.fn().mockResolvedValue({}),
        };
        mockAccuracyService = {
            getAccuracySummary: jest.fn().mockResolvedValue({}),
        };
        const module = await testing_1.Test.createTestingModule({
            providers: [
                ai_learning_service_1.AILearningService,
                { provide: prisma_service_1.PrismaService, useValue: mockPrisma },
                { provide: signals_service_1.SignalsService, useValue: mockSignalsService },
                { provide: smc_service_1.SMCService, useValue: mockSmcService },
                { provide: accuracy_service_1.AccuracyService, useValue: mockAccuracyService },
            ],
        }).compile();
        service = module.get(ai_learning_service_1.AILearningService);
    });
    it('8 & 9. should perform online learning directly from persisted PaperTrade snapshots without querying candles or calling SignalGenerator', async () => {
        // Reset any previous calls on mockPrisma.candle and mockSignalsService
        mockPrisma.candle.findMany.mockClear();
        mockPrisma.candle.findFirst.mockClear();
        mockSignalsService.generateSignalForSymbol.mockClear();
        const result = await service.learnFromPersistedTrade('trade-1');
        expect(result.updateResult).toBeDefined();
        expect(result.updateResult.weightDeltaNorm).toBeGreaterThan(0);
        expect(result.postMortem).toBeDefined();
        expect(result.postMortem.outcome).toBe('WIN_TP');
        expect(result.postMortem.realizedR).toBe(2.0);
        // CRITICAL PROOF 8: Online learning must NEVER query candles table after trade closure
        expect(mockPrisma.candle.findMany).not.toHaveBeenCalled();
        expect(mockPrisma.candle.findFirst).not.toHaveBeenCalled();
        // CRITICAL PROOF 9: Online learning must NEVER call SignalGenerator after trade closure
        expect(mockSignalsService.generateSignalForSymbol).not.toHaveBeenCalled();
    });
    it('10. missing featureSnapshot causes learning update to be skipped', async () => {
        const tradeWithoutSnapshot = {
            symbol: 'NIFTY',
            direction: 'BULLISH',
            entryPrice: 24100.0,
            exitPrice: 24200.0,
            entryTimestamp: new Date(Date.now() - 1800000),
            exitTimestamp: new Date(),
            exitReason: 'TP1_HIT',
            realizedR: 2.0,
            featureSnapshotJson: null, // missing snapshot
            outcomeSnapshotJson: { realizedPnL: 5000.0, realizedR: 2.0 },
        };
        const result = await service.recordTradeOutcomeAndOnlineUpdate(tradeWithoutSnapshot);
        expect(result.updateResult).toBeNull();
        expect(result.skippedReason).toBe('ONLINE_LEARNING_SKIPPED_MISSING_FEATURE_SNAPSHOT');
        expect(result.postMortem).toBeDefined();
        expect(mockPrisma.candle.findMany).not.toHaveBeenCalled();
    });
    it('11. AI prediction with no trained metrics reports sampleSize=0', async () => {
        const mockSignal = {
            symbol: 'NIFTY',
            timeframe: '15m',
            score: 75,
            grade: 'A',
            direction: 'BULLISH',
            entryZone: { min: 24090, max: 24110, optimal: 24100 },
            stopLoss: 24050,
            takeProfits: { tp1: 24150, tp2: 24200, tp3: 24250 },
            riskRewardRatios: { rr1: 1.0, rr2: 2.0, rr3: 3.0 },
            timestamp: new Date().toISOString(),
        };
        mockSignalsService.getSignals.mockResolvedValue([mockSignal]);
        const prediction = await service.predictTrade({
            symbol: 'NIFTY',
            timeframe: '15m',
        });
        expect(prediction).toBeDefined();
        expect(prediction.aiPrediction).toBeDefined();
        expect(prediction.aiPrediction.supportingSampleSize).toBe(0);
    });
    it('12. AI prediction with no calibration report does not report GOOD calibration', async () => {
        const prediction = await service.predictTrade({
            symbol: 'NIFTY',
            timeframe: '15m',
        });
        expect(prediction.aiPrediction.calibrationStatus).not.toBe('GOOD');
        expect(prediction.aiPrediction.calibrationStatus).toBe('INSUFFICIENT_DATA');
        expect(prediction.aiPrediction.confidenceStatus).toBe('INSUFFICIENT_DATA');
        expect(prediction.aiPrediction.recommendation).toBe('WAIT');
    });
});
//# sourceMappingURL=ai-learning.service.spec.js.map