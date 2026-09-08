"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const liquidity_engine_1 = require("../liquidity-engine");
const shared_1 = require("@quant/shared");
describe('LiquidityEngine', () => {
    it('should detect Equal Highs and sweeps of buy-side liquidity', () => {
        const swings = [
            {
                index: 2,
                type: shared_1.StructureType.SWING_HIGH,
                price: 100.0,
                timestamp: new Date(2000),
                confirmedAtIndex: 4,
                confirmedAtTimestamp: new Date(4000),
            },
            {
                index: 6,
                type: shared_1.StructureType.SWING_HIGH,
                price: 100.1,
                timestamp: new Date(6000),
                confirmedAtIndex: 8,
                confirmedAtTimestamp: new Date(8000),
            }, // Near equal high
        ];
        const candles = [
            { timestamp: new Date(1000), open: 90, high: 95, low: 88, close: 92, volume: 100 },
            { timestamp: new Date(2000), open: 92, high: 100.0, low: 90, close: 95, volume: 100 },
            { timestamp: new Date(3000), open: 95, high: 97, low: 90, close: 92, volume: 100 },
            { timestamp: new Date(4000), open: 92, high: 94, low: 89, close: 91, volume: 100 },
            { timestamp: new Date(5000), open: 91, high: 96, low: 90, close: 95, volume: 100 },
            { timestamp: new Date(6000), open: 95, high: 100.1, low: 92, close: 96, volume: 100 },
            { timestamp: new Date(7000), open: 96, high: 98, low: 93, close: 94, volume: 100 },
            { timestamp: new Date(8000), open: 94, high: 96, low: 91, close: 93, volume: 100 },
            { timestamp: new Date(9000), open: 93, high: 102.5, low: 92, close: 98.0, volume: 500 }, // Sweep: pierces 100.05 but closes at 98.0
        ];
        const { pools, sweeps } = liquidity_engine_1.LiquidityEngine.detectLiquidity(candles, swings, {
            equalHighLowToleranceAtr: 0.2,
        });
        expect(pools.length).toBeGreaterThanOrEqual(1);
        expect(sweeps).toHaveLength(1);
        expect(sweeps[0].sweptPrice).toBe(102.5);
        expect(sweeps[0].isSwept).toBe(true);
    });
    it('Test A: rejects single swing sweep before confirmation and accepts after confirmation', () => {
        const swing = {
            index: 10,
            type: shared_1.StructureType.SWING_HIGH,
            price: 100.0,
            timestamp: new Date(10000),
            confirmedAtIndex: 13,
            confirmedAtTimestamp: new Date(13000),
        };
        const candles = [];
        for (let c = 0; c <= 14; c++) {
            candles.push({
                timestamp: new Date(c * 1000),
                open: 90,
                high: c === 10 ? 100.0 : c === 11 ? 102.0 : c === 14 ? 103.0 : 95,
                low: 85,
                close: c === 11 ? 95 : c === 14 ? 96 : 90,
                volume: 100,
            });
        }
        // Evaluate up to index 11 (candle 11 pierces 100.0, but confirmedAtIndex is 13)
        const resAt11 = liquidity_engine_1.LiquidityEngine.detectLiquidity(candles.slice(0, 12), [swing]);
        expect(resAt11.sweeps).toHaveLength(0);
        // Evaluate up to index 14 (candle 14 pierces 100.0, after confirmation at 13)
        const resAt14 = liquidity_engine_1.LiquidityEngine.detectLiquidity(candles.slice(0, 15), [swing]);
        expect(resAt14.sweeps).toHaveLength(1);
        expect(resAt14.sweeps[0].sweptAtIndex).toBe(14);
    });
    it('Test B: rejects EQH sweep before second swing confirmation and accepts after confirmation', () => {
        const swing1 = {
            index: 10,
            type: shared_1.StructureType.SWING_HIGH,
            price: 100.0,
            timestamp: new Date(10000),
            confirmedAtIndex: 13,
            confirmedAtTimestamp: new Date(13000),
        };
        const swing2 = {
            index: 15,
            type: shared_1.StructureType.SWING_HIGH,
            price: 100.1,
            timestamp: new Date(15000),
            confirmedAtIndex: 18,
            confirmedAtTimestamp: new Date(18000),
        };
        const candles = [];
        for (let c = 0; c <= 20; c++) {
            candles.push({
                timestamp: new Date(c * 1000),
                open: 90,
                high: c === 10 ? 100.0 : c === 15 ? 100.1 : c === 16 ? 102.5 : c === 19 ? 103.0 : 95,
                low: 85,
                close: c === 16 ? 94 : c === 19 ? 95 : 90,
                volume: 100,
            });
        }
        // Evaluate up to index 16 (candle 16 pierces level after swing2 occurred at 15, but BEFORE swing2 is confirmed at 18)
        const resAt16 = liquidity_engine_1.LiquidityEngine.detectLiquidity(candles.slice(0, 17), [swing1, swing2], {
            equalHighLowToleranceAtr: 0.2,
        });
        expect(resAt16.sweeps).toHaveLength(0);
        // Evaluate up to index 19 (candle 19 pierces level AFTER swing2 confirmed at 18)
        const resAt19 = liquidity_engine_1.LiquidityEngine.detectLiquidity(candles.slice(0, 20), [swing1, swing2], {
            equalHighLowToleranceAtr: 0.2,
        });
        expect(resAt19.sweeps).toHaveLength(1);
        expect(resAt19.sweeps[0].sweptAtIndex).toBe(19);
    });
});
//# sourceMappingURL=liquidity-engine.test.js.map