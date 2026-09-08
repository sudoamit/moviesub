"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const shared_1 = require("@quant/shared");
const trade_outcome_analyzer_1 = require("../trade-outcome-analyzer");
describe('TradeOutcomeAnalyzer', () => {
    it('should classify a high-quality setup with positive outcome as GOOD_TRADE_WIN', () => {
        const res = trade_outcome_analyzer_1.TradeOutcomeAnalyzer.analyze({
            tradeId: 't1',
            symbol: 'NIFTY',
            direction: shared_1.Direction.BULLISH,
            entryPrice: 24000,
            entryTime: new Date('2026-09-01T09:30:00Z'),
            exitPrice: 24150,
            exitTime: new Date('2026-09-01T10:15:00Z'),
            stopLoss: 23950,
            pnl: 150,
            pnlR: 3.0,
            signalSetup: {
                symbol: 'NIFTY',
                direction: shared_1.Direction.BULLISH,
                score: 88,
                grade: shared_1.SignalGrade.A_PLUS,
                htfBias: shared_1.Direction.BULLISH,
            },
        });
        expect(res.outcomeClassification).toBe('GOOD_TRADE_WIN');
        expect(res.outcomeStatus).toBe('WIN');
        expect(res.maxFavorableExcursion).toBeGreaterThan(0);
        expect(res.failureReasons.length).toBe(0);
    });
    it('should classify a high-quality setup that hit stop as GOOD_TRADE_LOSS', () => {
        const res = trade_outcome_analyzer_1.TradeOutcomeAnalyzer.analyze({
            tradeId: 't2',
            symbol: 'NIFTY',
            direction: shared_1.Direction.BULLISH,
            entryPrice: 24000,
            entryTime: new Date('2026-09-01T09:30:00Z'),
            exitPrice: 23950,
            exitTime: new Date('2026-09-01T09:45:00Z'),
            stopLoss: 23950,
            pnl: -50,
            pnlR: -1.0,
            signalSetup: {
                symbol: 'NIFTY',
                direction: shared_1.Direction.BULLISH,
                score: 85,
                grade: shared_1.SignalGrade.A,
                htfBias: shared_1.Direction.BULLISH,
            },
        });
        expect(res.outcomeClassification).toBe('GOOD_TRADE_LOSS');
        expect(res.outcomeStatus).toBe('LOSS');
    });
    it('should classify a poor setup that won due to luck as BAD_TRADE_WIN', () => {
        const res = trade_outcome_analyzer_1.TradeOutcomeAnalyzer.analyze({
            tradeId: 't3',
            symbol: 'NIFTY',
            direction: shared_1.Direction.BULLISH,
            entryPrice: 24000,
            entryTime: new Date('2026-09-01T09:30:00Z'),
            exitPrice: 24100,
            exitTime: new Date('2026-09-01T10:00:00Z'),
            stopLoss: 23950,
            pnl: 100,
            pnlR: 2.0,
            signalSetup: {
                symbol: 'NIFTY',
                direction: shared_1.Direction.BULLISH,
                score: 45,
                grade: shared_1.SignalGrade.C,
                htfBias: shared_1.Direction.BEARISH, // Conflict
            },
        });
        expect(res.outcomeClassification).toBe('BAD_TRADE_WIN');
        expect(res.outcomeStatus).toBe('WIN');
        expect(res.failureReasons).toContain('HTF_CONFLICT');
    });
});
//# sourceMappingURL=trade-outcome-analyzer.test.js.map