"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const signal_generator_1 = require("../signal-generator");
const shared_1 = require("@quant/shared");
describe('SignalGenerator', () => {
    it('should generate an analytical signal setup from multi-timeframe candles', async () => {
        const provider = new shared_1.MockMarketDataProvider({ seed: 777 });
        const execCandles = await provider.getHistoricalCandles('NIFTY', '15m', 150);
        const htf1Candles = await provider.getHistoricalCandles('NIFTY', '1h', 100);
        const htf2Candles = await provider.getHistoricalCandles('NIFTY', '4h', 100);
        const signal = signal_generator_1.SignalGenerator.generateSignal({
            symbol: 'NIFTY',
            executionCandles: execCandles,
            executionTimeframe: shared_1.Timeframe.M15,
            htf1Candles,
            htf1Timeframe: shared_1.Timeframe.H1,
            htf2Candles,
            htf2Timeframe: shared_1.Timeframe.H4,
        });
        expect(signal).toBeDefined();
        expect(signal.symbol).toBe('NIFTY');
        expect(signal.score).toBeGreaterThanOrEqual(0);
        expect(signal.score).toBeLessThanOrEqual(100);
        expect(signal.grade).toBeDefined();
        expect(signal.scoreBreakdown).toBeDefined();
        expect(signal.reasoning).toBeDefined();
        expect(signal.reasoning.summary).toBeDefined();
    });
});
//# sourceMappingURL=signal-generator.test.js.map