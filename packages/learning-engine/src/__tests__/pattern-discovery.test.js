"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pattern_discovery_1 = require("../pattern-discovery");
describe('PatternDiscoveryEngine', () => {
    const createMockExperiences = (count = 30) => {
        return Array.from({ length: count }, (_, i) => {
            const isGoodCondition = i % 2 === 0;
            return {
                id: `exp-${i}`,
                tradeId: `tr-${i}`,
                timestamp: new Date(1700000000000 + i * 3600000),
                instrument: { symbol: 'NIFTY', assetType: 'INDEX' },
                marketState: {
                    multiHorizon: { alignment: isGoodCondition ? 'ALIGNED' : 'CONFLICTED' },
                    smc: { liquiditySweeps: isGoodCondition ? [{ id: 'sw-1' }] : [] },
                    quant: { momentum: { relativeVolume: isGoodCondition ? 1.5 : 0.8 } },
                },
                decision: { action: 'BUY', score: isGoodCondition ? 85 : 55 },
                execution: { entryPrice: 24000, entryTime: new Date() },
                risk: { stopLoss: 23950 },
                prediction: { probabilityWin: isGoodCondition ? 0.8 : 0.4 },
                outcome: {
                    status: isGoodCondition ? 'WIN' : 'LOSS',
                    pnl: isGoodCondition ? 150 : -50,
                    pnlR: isGoodCondition ? 3.0 : -1.0,
                    maxFavorableExcursion: isGoodCondition ? 3.2 : 0.1,
                    maxAdverseExcursion: isGoodCondition ? 0.2 : 1.0,
                    holdingTimeSeconds: 1500,
                },
                marketContext: {
                    regime: isGoodCondition ? 'BULLISH_TREND' : 'HIGH_VOLATILITY',
                    volatilityRegime: 'P40',
                    session: 'NSE_MORNING',
                    dayOfWeek: 2,
                },
                outcomeClassification: isGoodCondition ? 'GOOD_TRADE_WIN' : 'BAD_TRADE_LOSS',
                reasons: ['BOS'],
                failureReasons: isGoodCondition ? [] : ['HTF_CONFLICT', 'VOLATILITY_MISREAD'],
                strategyVersion: 'v2.0',
                featureSchemaVersion: '2.0',
                createdAt: new Date(),
            };
        });
    };
    it('should discover high-confidence positive patterns and negative filter candidates', () => {
        const exps = createMockExperiences(40);
        const patterns = pattern_discovery_1.PatternDiscoveryEngine.discover(exps, {
            minSampleSize: 10,
            minEffectSizeR: 0.25,
        });
        expect(patterns.length).toBeGreaterThan(0);
        const positive = patterns.find((p) => p.type === 'POSITIVE_CONFLUENCE');
        const negative = patterns.find((p) => p.type === 'NEGATIVE_FILTER');
        if (positive) {
            expect(positive.expectancy).toBeGreaterThan(0);
            expect(positive.confidenceInterval[0]).toBeGreaterThan(0);
        }
        if (negative) {
            expect(negative.expectancy).toBeLessThan(0);
            expect(negative.confidenceInterval[1]).toBeLessThan(0);
        }
    });
});
//# sourceMappingURL=pattern-discovery.test.js.map