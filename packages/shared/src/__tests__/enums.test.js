"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const enums_1 = require("../enums");
describe('Shared Enums', () => {
    it('should verify supported AssetTypes', () => {
        expect(enums_1.AssetType.INDEX).toBe('INDEX');
        expect(enums_1.AssetType.EQUITY).toBe('EQUITY');
        expect(enums_1.AssetType.CRYPTO).toBe('CRYPTO');
    });
    it('should verify supported Timeframes', () => {
        expect(enums_1.Timeframe.M1).toBe('1m');
        expect(enums_1.Timeframe.M5).toBe('5m');
        expect(enums_1.Timeframe.M15).toBe('15m');
        expect(enums_1.Timeframe.H1).toBe('1h');
        expect(enums_1.Timeframe.H4).toBe('4h');
        expect(enums_1.Timeframe.D1).toBe('1d');
    });
    it('should verify Signal States and Grades', () => {
        expect(enums_1.SignalState.PENDING).toBe('PENDING');
        expect(enums_1.SignalState.ACTIVE).toBe('ACTIVE');
        expect(enums_1.SignalState.TP1_HIT).toBe('TP1_HIT');
        expect(enums_1.SignalState.SL_HIT).toBe('SL_HIT');
        expect(enums_1.SignalGrade.A_PLUS).toBe('A+');
        expect(enums_1.SignalGrade.A).toBe('A');
    });
    it('should verify Market Regimes', () => {
        expect(enums_1.MarketRegimeType.BULLISH_TREND).toBe('BULLISH_TREND');
        expect(enums_1.MarketRegimeType.BEARISH_TREND).toBe('BEARISH_TREND');
        expect(enums_1.MarketRegimeType.RANGE).toBe('RANGE');
    });
});
//# sourceMappingURL=enums.test.js.map