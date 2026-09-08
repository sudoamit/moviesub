"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrailingEngine = void 0;
class TrailingEngine {
    /**
     * Evaluates real-time position price action against TP milestones and updates Stop Loss dynamically
     */
    static evaluate(entryPrice, initialStopLoss, tp1Price, tp2Price, currentPrice, direction = 'BULLISH', atr = 25) {
        const isBull = direction === 'BULLISH';
        const buffer = entryPrice * 0.0005; // 0.05% safety cushion for fees/slippage
        // Check if TP2 is reached -> Stage 3 (Trailing Runner)
        const hasReachedTP2 = isBull ? currentPrice >= tp2Price : currentPrice <= tp2Price;
        if (hasReachedTP2) {
            // Trail SL at 1.5x ATR behind current peak price
            const trailingSL = isBull
                ? Number(Math.max(tp1Price, currentPrice - atr * 1.5).toFixed(2))
                : Number(Math.min(tp1Price, currentPrice + atr * 1.5).toFixed(2));
            return {
                stage: 'STAGE_3_TRAILING',
                stageBadge: '🚀 STAGE 3: ATR TRAILING RUNNER',
                currentStopLoss: trailingSL,
                isRiskFree: true,
                partialBookedPercent: 50,
                profitLockedAmount: Math.abs(tp1Price - entryPrice),
                recommendedAction: `Lock in massive 1:2.5+ gains. Trailing 50% runner at ₹${trailingSL}.`,
                trailingStepPrice: trailingSL,
            };
        }
        // Check if TP1 is reached -> Stage 2 (Risk-Free Breakeven)
        const hasReachedTP1 = isBull ? currentPrice >= tp1Price : currentPrice <= tp1Price;
        if (hasReachedTP1) {
            const beStopLoss = isBull
                ? Number((entryPrice + buffer).toFixed(2))
                : Number((entryPrice - buffer).toFixed(2));
            return {
                stage: 'STAGE_2_BREAKEVEN',
                stageBadge: '🛡️ STAGE 2: RISK-FREE BREAKEVEN',
                currentStopLoss: beStopLoss,
                isRiskFree: true,
                partialBookedPercent: 50,
                profitLockedAmount: Math.abs(tp1Price - entryPrice) * 0.5,
                recommendedAction: `50% Partial Profits booked at TP1. Stop Loss moved to Breakeven (₹${beStopLoss}). Risk is 0.00.`,
                trailingStepPrice: beStopLoss,
            };
        }
        // Stage 1: Initial Risk Active
        return {
            stage: 'STAGE_1_INITIAL',
            stageBadge: '🎯 STAGE 1: ACTIVE SETUP',
            currentStopLoss: initialStopLoss,
            isRiskFree: false,
            partialBookedPercent: 0,
            profitLockedAmount: 0,
            recommendedAction: `Initial trade active. SL anchored at structural floor (₹${initialStopLoss.toFixed(2)}).`,
            trailingStepPrice: initialStopLoss,
        };
    }
}
exports.TrailingEngine = TrailingEngine;
//# sourceMappingURL=trailing-engine.js.map