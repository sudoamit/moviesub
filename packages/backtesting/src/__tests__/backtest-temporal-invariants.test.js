"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const backtest_simulator_1 = require("../backtest-simulator");
const shared_1 = require("@quant/shared");
function createSyntheticCandles(count, startPrice = 100) {
    const candles = [];
    const baseTime = 1756972800000; // e.g. 10:00 UTC
    let price = startPrice;
    for (let i = 0; i < count; i++) {
        const time = new Date(baseTime + i * 15 * 60 * 1000);
        // Create recognizable price movement with trend and swings
        const noise = (i % 5 === 0 ? 1 : -0.5) * (1 + (i % 3));
        const open = price;
        const high = open + Math.abs(noise) + 1.5;
        const low = Math.max(1, open - Math.abs(noise) - 1.5);
        const close = open + noise;
        price = close;
        candles.push({
            timestamp: time,
            open: Number(open.toFixed(2)),
            high: Number(high.toFixed(2)),
            low: Number(low.toFixed(2)),
            close: Number(close.toFixed(2)),
            volume: 1000 + i * 10,
        });
    }
    return candles;
}
describe('Backtesting Temporal Invariants', () => {
    it('Future-Data Invariance: Backtest(D, asOf=T) === Backtest(D + FutureData, asOf=T)', () => {
        const datasetD = createSyntheticCandles(100);
        // T is the close time of candle 70
        const cutoffBarIndex = 70;
        const cutoffCandle = datasetD[cutoffBarIndex];
        const asOfTimestamp = new Date(new Date(cutoffCandle.timestamp).getTime() + 15 * 60 * 1000);
        // Dataset D + Future (30 extra candles added chronologically)
        const datasetDFuture = createSyntheticCandles(130);
        const resultD = backtest_simulator_1.BacktestSimulator.runSimulation({
            symbol: 'NIFTY',
            timeframe: shared_1.Timeframe.M15,
            candles: datasetD,
            asOfTimestamp,
            initialCapital: 100000,
            riskPerTradePercent: 1.0,
            minScore: 50,
        });
        const resultDFuture = backtest_simulator_1.BacktestSimulator.runSimulation({
            symbol: 'NIFTY',
            timeframe: shared_1.Timeframe.M15,
            candles: datasetDFuture,
            asOfTimestamp,
            initialCapital: 100000,
            riskPerTradePercent: 1.0,
            minScore: 50,
        });
        expect(resultD.totalTrades).toBe(resultDFuture.totalTrades);
        expect(resultD.trades.length).toBe(resultDFuture.trades.length);
        expect(resultD.finalEquity).toBe(resultDFuture.finalEquity);
        expect(resultD.netPnL).toBe(resultDFuture.netPnL);
        // Verify individual trade parity
        for (let i = 0; i < resultD.trades.length; i++) {
            const tD = resultD.trades[i];
            const tF = resultDFuture.trades[i];
            expect(tD.direction).toBe(tF.direction);
            expect(tD.entryPrice).toBe(tF.entryPrice);
            expect(tD.exitPrice).toBe(tF.exitPrice);
            expect(tD.entryTime.getTime()).toBe(tF.entryTime.getTime());
            expect(tD.exitTime.getTime()).toBe(tF.exitTime.getTime());
            expect(tD.pnl).toBe(tF.pnl);
        }
    });
    it('Incremental Replay: Step-by-step replay matches batch backtest at every timestamp T', () => {
        const candles = createSyntheticCandles(90);
        // Evaluate at cutoff step 60
        const cutoffIndex = 60;
        const cutoffTime = new Date(new Date(candles[cutoffIndex].timestamp).getTime() + 15 * 60 * 1000);
        // Batch evaluation with explicit asOfTimestamp
        const batchResult = backtest_simulator_1.BacktestSimulator.runSimulation({
            symbol: 'BTCUSDT',
            timeframe: shared_1.Timeframe.M15,
            candles,
            asOfTimestamp: cutoffTime,
            initialCapital: 50000,
            minScore: 50,
        });
        // Incremental evaluation using sliced input data up to cutoffIndex
        const slicedCandles = candles.slice(0, cutoffIndex + 1);
        const incrementalResult = backtest_simulator_1.BacktestSimulator.runSimulation({
            symbol: 'BTCUSDT',
            timeframe: shared_1.Timeframe.M15,
            candles: slicedCandles,
            initialCapital: 50000,
            minScore: 50,
        });
        expect(batchResult.totalTrades).toBe(incrementalResult.totalTrades);
        expect(batchResult.finalEquity).toBe(incrementalResult.finalEquity);
        expect(batchResult.netPnL).toBe(incrementalResult.netPnL);
        expect(batchResult.equityCurve.length).toBe(incrementalResult.equityCurve.length);
    });
});
//# sourceMappingURL=backtest-temporal-invariants.test.js.map