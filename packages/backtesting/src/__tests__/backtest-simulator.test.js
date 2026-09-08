"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const backtest_simulator_1 = require("../backtest-simulator");
const shared_1 = require("@quant/shared");
describe('BacktestSimulator', () => {
    it('should run a deterministic candle-by-candle simulation on historical candles', async () => {
        const provider = new shared_1.MockMarketDataProvider({ seed: 42 });
        const candles = await provider.getHistoricalCandles('NIFTY', '15m', 250);
        const result = backtest_simulator_1.BacktestSimulator.runSimulation({
            symbol: 'NIFTY',
            timeframe: shared_1.Timeframe.M15,
            candles,
            initialCapital: 100000,
            riskPerTradePercent: 1.0,
            minScore: 60,
        });
        expect(result).toBeDefined();
        expect(result.symbol).toBe('NIFTY');
        expect(result.initialCapital).toBe(100000);
        expect(result.finalEquity).toBeGreaterThan(0);
        expect(result.equityCurve.length).toBeGreaterThanOrEqual(1);
    });
});
//# sourceMappingURL=backtest-simulator.test.js.map