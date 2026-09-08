"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mtf_analyzer_1 = require("../mtf-analyzer");
const shared_1 = require("@quant/shared");
describe('MultiTimeframeAnalyzer', () => {
    function createCandle(index, open, high, low, close, intervalMs = 3600000) {
        return { timestamp: new Date(1700000000000 + index * intervalMs), open, high, low, close, volume: 1000 };
    }
    it('should establish strong bullish alignment when both HTF1 and HTF2 are bullish', () => {
        const htf1Candles = [
            createCandle(0, 100, 105, 95, 100, 3600000),
            createCandle(1, 100, 108, 99, 106, 3600000),
            createCandle(2, 106, 112, 105, 110, 3600000),
            createCandle(3, 110, 120, 108, 115, 3600000),
            createCandle(4, 115, 116, 106, 108, 3600000),
            createCandle(5, 108, 112, 105, 110, 3600000),
            createCandle(6, 110, 114, 108, 112, 3600000),
            createCandle(7, 112, 135, 112, 135, 3600000),
            createCandle(8, 135, 138, 134, 136, 3600000),
        ];
        const htf2Candles = [
            createCandle(0, 100, 105, 95, 100, 4 * 3600000),
            createCandle(1, 100, 108, 99, 106, 4 * 3600000),
            createCandle(2, 106, 112, 105, 110, 4 * 3600000),
            createCandle(3, 110, 120, 108, 115, 4 * 3600000),
            createCandle(4, 115, 116, 106, 108, 4 * 3600000),
            createCandle(5, 108, 112, 105, 110, 4 * 3600000),
            createCandle(6, 110, 114, 108, 112, 4 * 3600000),
            createCandle(7, 112, 135, 112, 135, 4 * 3600000),
            createCandle(8, 135, 138, 134, 136, 4 * 3600000),
        ];
        const asOfTimestamp = new Date(1700000000000 + 36 * 3600000);
        const execTf = { timeframe: shared_1.Timeframe.M15, candles: [createCandle(143, 135, 136, 134, 135, 15 * 60 * 1000)] };
        const htf1 = { timeframe: shared_1.Timeframe.H1, candles: htf1Candles };
        const htf2 = { timeframe: shared_1.Timeframe.H4, candles: htf2Candles };
        const res = mtf_analyzer_1.MultiTimeframeAnalyzer.analyzeMTF(execTf, htf1, htf2, shared_1.MTFMode.BALANCED, asOfTimestamp);
        expect(res.htfBias).toBe(shared_1.Direction.BULLISH);
        expect(res.isAligned).toBe(true);
        expect(res.alignmentScore).toBe(20);
    });
});
//# sourceMappingURL=mtf-analyzer.test.js.map