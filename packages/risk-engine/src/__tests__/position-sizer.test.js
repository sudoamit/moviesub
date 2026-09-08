"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const position_sizer_1 = require("../position-sizer");
describe('PositionSizer', () => {
    it('should calculate accurate lot-based position size for 1% risk on $100,000 account', () => {
        // Account: $100,000. Risk 1% = $1,000.
        // Entry: $25,000, Stop Loss: $24,500. Risk per unit = $500.
        // Raw units = 1000 / 500 = 2 units.
        const result = position_sizer_1.PositionSizer.calculatePosition({
            accountBalance: 100000,
            riskPercentage: 1.0,
            entryPrice: 25000,
            stopLoss: 24500,
            lotSize: 1,
        });
        expect(result.isValid).toBe(true);
        expect(result.riskAmount).toBe(1000);
        expect(result.riskPerUnit).toBe(500);
        expect(result.roundedUnits).toBe(2);
        expect(result.maximumLoss).toBe(1000);
    });
    it('should reject position sizing if risk percentage exceeds max limit', () => {
        const result = position_sizer_1.PositionSizer.calculatePosition({
            accountBalance: 50000,
            riskPercentage: 5.0, // Exceeds default 2.5%
            entryPrice: 100,
            stopLoss: 95,
            maxRiskPercentage: 2.5,
        });
        expect(result.isValid).toBe(false);
        expect(result.rejectionReason).toContain('exceeds maximum allowable risk limit');
    });
    it('should reject when entry price equals stop loss', () => {
        const result = position_sizer_1.PositionSizer.calculatePosition({
            accountBalance: 50000,
            riskPercentage: 1.0,
            entryPrice: 100,
            stopLoss: 100,
        });
        expect(result.isValid).toBe(false);
    });
});
//# sourceMappingURL=position-sizer.test.js.map