"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const indicator_summary_1 = require("../indicator-summary");
const shared_1 = require("@quant/shared");
describe('calculateIndicatorSummary', () => {
    it('should return a full indicator snapshot for realistic candle series', async () => {
        const provider = new shared_1.MockMarketDataProvider({ seed: 50 });
        const candles = await provider.getHistoricalCandles('NIFTY', '15m', 250);
        const summary = (0, indicator_summary_1.calculateIndicatorSummary)(candles);
        expect(summary.ema9).not.toBeNull();
        expect(summary.ema20).not.toBeNull();
        expect(summary.ema50).not.toBeNull();
        expect(summary.ema200).not.toBeNull();
        expect(summary.sma20).not.toBeNull();
        expect(summary.sma50).not.toBeNull();
        expect(summary.rsi14).not.toBeNull();
        expect(summary.atr14).not.toBeNull();
        expect(summary.adx14).not.toBeNull();
        expect(summary.bollingerUpper).not.toBeNull();
        expect(summary.bollingerLower).not.toBeNull();
        expect(summary.vwap).not.toBeNull();
        // Verify mathematical sanity
        expect(summary.bollingerUpper).toBeGreaterThan(summary.bollingerMiddle);
        expect(summary.bollingerMiddle).toBeGreaterThan(summary.bollingerLower);
        expect(summary.rsi14).toBeGreaterThan(0);
        expect(summary.rsi14).toBeLessThan(100);
        expect(summary.atr14).toBeGreaterThan(0);
    });
});
//# sourceMappingURL=indicator-summary.test.js.map