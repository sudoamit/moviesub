"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const candle_validator_1 = require("../candle-validator");
const enums_1 = require("../../enums");
describe('CandleValidator', () => {
    it('should validate a correct candle', () => {
        const candle = {
            timestamp: new Date('2026-08-28T09:15:00Z'),
            open: 24800,
            high: 24850,
            low: 24780,
            close: 24830,
            volume: 50000,
        };
        const res = candle_validator_1.CandleValidator.validate(candle);
        expect(res.isValid).toBe(true);
        expect(res.errors).toHaveLength(0);
    });
    it('should reject candles with High < Open or High < Close', () => {
        const invalidHighCandle = {
            timestamp: new Date(),
            open: 24800,
            high: 24790, // lower than open
            low: 24750,
            close: 24780,
            volume: 1000,
        };
        const res = candle_validator_1.CandleValidator.validate(invalidHighCandle);
        expect(res.isValid).toBe(false);
        expect(res.errors.some((e) => e.includes('High'))).toBe(true);
    });
    it('should reject candles with Low > Open or Low > Close', () => {
        const invalidLowCandle = {
            timestamp: new Date(),
            open: 24800,
            high: 24850,
            low: 24820, // higher than open
            close: 24810,
            volume: 1000,
        };
        const res = candle_validator_1.CandleValidator.validate(invalidLowCandle);
        expect(res.isValid).toBe(false);
        expect(res.errors.some((e) => e.includes('Low'))).toBe(true);
    });
    it('should reject negative prices and negative volume', () => {
        const negativeCandle = {
            timestamp: new Date(),
            open: -100,
            high: 100,
            low: -200,
            close: 50,
            volume: -5,
        };
        const res = candle_validator_1.CandleValidator.validate(negativeCandle);
        expect(res.isValid).toBe(false);
        expect(res.errors.length).toBeGreaterThan(0);
    });
    it('should normalize, sort chronologically, and deduplicate a candle series', () => {
        const t1 = new Date('2026-08-28T09:15:00Z');
        const t2 = new Date('2026-08-28T09:30:00Z');
        const t3 = new Date('2026-08-28T09:45:00Z');
        const rawCandles = [
            { timestamp: t2, open: 24820, high: 24860, low: 24810, close: 24840, volume: 100 },
            { timestamp: t1, open: 24800, high: 24830, low: 24790, close: 24820, volume: 100 },
            { timestamp: t2, open: 24820, high: 24870, low: 24810, close: 24850, volume: 150 }, // duplicate t2 with update
            { timestamp: t3, open: 24850, high: 24800, low: 24820, close: 24840, volume: 100 }, // invalid high < low
        ];
        const result = candle_validator_1.CandleValidator.normalizeAndCleanSeries(rawCandles);
        expect(result.validCandles).toHaveLength(2);
        expect(result.invalidCount).toBe(1);
        expect(result.duplicateCount).toBe(1);
        expect(result.validCandles[0].timestamp.getTime()).toBe(t1.getTime());
        expect(result.validCandles[1].timestamp.getTime()).toBe(t2.getTime());
        expect(result.validCandles[1].close).toBe(24850); // latest duplicate preserved
    });
    it('should convert timeframes to milliseconds correctly', () => {
        expect(candle_validator_1.CandleValidator.timeframeToMs(enums_1.Timeframe.M1)).toBe(60000);
        expect(candle_validator_1.CandleValidator.timeframeToMs(enums_1.Timeframe.M5)).toBe(300000);
        expect(candle_validator_1.CandleValidator.timeframeToMs(enums_1.Timeframe.M15)).toBe(900000);
        expect(candle_validator_1.CandleValidator.timeframeToMs(enums_1.Timeframe.H1)).toBe(3600000);
        expect(candle_validator_1.CandleValidator.timeframeToMs(enums_1.Timeframe.H4)).toBe(14400000);
        expect(candle_validator_1.CandleValidator.timeframeToMs(enums_1.Timeframe.D1)).toBe(86400000);
    });
});
//# sourceMappingURL=candle-validator.test.js.map