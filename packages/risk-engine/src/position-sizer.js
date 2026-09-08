"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PositionSizer = void 0;
class PositionSizer {
    /**
     * Deterministically calculates institutional position size based on strict fixed percentage risk.
     * STRICT FAIL-CLOSED: If position sizing is invalid or below 1 lot, fails closed with isValid: false.
     */
    static calculatePosition(options) {
        let { accountBalance, riskPercentage = 1.0, entryPrice, stopLoss, lotSize = 1, contractSize = 1, maxRiskPercentage = 2.5, maxLeverage = 10, regime, volatilityPercentile, expectedR, mlProbability, } = options;
        if (accountBalance <= 0) {
            return this.createInvalid(options, 'Account balance must be positive');
        }
        if (riskPercentage <= 0) {
            return this.createInvalid(options, 'Risk percentage must be positive');
        }
        if (riskPercentage > maxRiskPercentage) {
            return this.createInvalid(options, `Risk percentage (${riskPercentage}%) exceeds maximum allowable risk limit (${maxRiskPercentage}%)`);
        }
        // Dynamic Regime and Volatility adjustment
        if (regime === 'HIGH_VOLATILITY' ||
            (volatilityPercentile !== undefined && volatilityPercentile > 80)) {
            riskPercentage *= 0.6; // Scale down risk during high volatility shocks
        }
        else if (expectedR &&
            expectedR >= 1.8 &&
            mlProbability &&
            mlProbability >= 0.7 &&
            regime === 'BULLISH_TREND') {
            riskPercentage = Math.min(maxRiskPercentage, riskPercentage * 1.25);
        }
        // Strict cap at max allowable risk percentage
        riskPercentage = Math.min(maxRiskPercentage, Math.max(0.1, riskPercentage));
        if (entryPrice <= 0 || stopLoss <= 0) {
            return this.createInvalid(options, 'Entry price and stop loss must be greater than zero');
        }
        const riskPerUnit = Math.abs(entryPrice - stopLoss);
        if (riskPerUnit <= 0) {
            return this.createInvalid(options, 'Entry price cannot equal stop loss (risk per unit is 0)');
        }
        const riskAmount = accountBalance * (riskPercentage / 100);
        const calculatedUnits = (riskAmount / riskPerUnit) * contractSize;
        // Floor to instrument lot size (Strict fail-closed rounding)
        const effectiveLotSize = Math.max(1, lotSize);
        const roundedUnits = Math.floor(calculatedUnits / effectiveLotSize) * effectiveLotSize;
        if (roundedUnits <= 0) {
            return {
                accountBalance,
                riskPercentage,
                riskAmount: Number(riskAmount.toFixed(2)),
                entryPrice,
                stopLoss,
                riskPerUnit: Number(riskPerUnit.toFixed(4)),
                calculatedUnits: Number(calculatedUnits.toFixed(4)),
                lotSize: effectiveLotSize,
                roundedUnits: 0,
                totalPositionValue: 0,
                maximumLoss: 0,
                isValid: false,
                rejectionReason: `Calculated units (${calculatedUnits.toFixed(2)}) smaller than minimum lot size (${effectiveLotSize}) without exceeding risk budget`,
            };
        }
        const totalPositionValue = roundedUnits * entryPrice;
        const maximumLoss = roundedUnits * riskPerUnit;
        // Leverage safety limit
        if (totalPositionValue > accountBalance * maxLeverage) {
            return {
                accountBalance,
                riskPercentage,
                riskAmount: Number(riskAmount.toFixed(2)),
                entryPrice,
                stopLoss,
                riskPerUnit: Number(riskPerUnit.toFixed(4)),
                calculatedUnits: Number(calculatedUnits.toFixed(4)),
                lotSize: effectiveLotSize,
                roundedUnits,
                totalPositionValue: Number(totalPositionValue.toFixed(2)),
                maximumLoss: Number(maximumLoss.toFixed(2)),
                isValid: false,
                rejectionReason: `Position value (${totalPositionValue.toFixed(2)}) exceeds maximum allowable account leverage (${maxLeverage}x)`,
            };
        }
        return {
            accountBalance,
            riskPercentage,
            riskAmount: Number(riskAmount.toFixed(2)),
            entryPrice,
            stopLoss,
            riskPerUnit: Number(riskPerUnit.toFixed(4)),
            calculatedUnits: Number(calculatedUnits.toFixed(4)),
            lotSize: effectiveLotSize,
            roundedUnits,
            totalPositionValue: Number(totalPositionValue.toFixed(2)),
            maximumLoss: Number(maximumLoss.toFixed(2)),
            isValid: true,
        };
    }
    static createInvalid(options, rejectionReason) {
        return {
            accountBalance: options.accountBalance || 0,
            riskPercentage: options.riskPercentage || 0,
            riskAmount: 0,
            entryPrice: options.entryPrice || 0,
            stopLoss: options.stopLoss || 0,
            riskPerUnit: 0,
            calculatedUnits: 0,
            lotSize: options.lotSize || 1,
            roundedUnits: 0,
            totalPositionValue: 0,
            maximumLoss: 0,
            isValid: false,
            rejectionReason,
        };
    }
}
exports.PositionSizer = PositionSizer;
//# sourceMappingURL=position-sizer.js.map