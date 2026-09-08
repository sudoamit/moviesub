"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SlippageModel = exports.DEFAULT_SLIPPAGE_CONFIG = void 0;
exports.DEFAULT_SLIPPAGE_CONFIG = {
    baseSlippageBps: 2.0, // 0.02% base slippage
    volatilityMultiplier: 1.5,
    impactMultiplier: 0.8,
    maxSlippageBps: 25.0, // Cap at 0.25%
};
class SlippageModel {
    /**
     * Calculates realistic market order execution slippage taking into account volatility and order size
     */
    static calculateSlippage(price, quantity, side, orderType, candle, config = exports.DEFAULT_SLIPPAGE_CONFIG) {
        if (orderType === 'LIMIT') {
            // Passive limit fills experience 0 adverse slippage
            return { executedPrice: price, slippageAmount: 0, slippageBps: 0 };
        }
        let dynamicBps = config.baseSlippageBps;
        if (candle && candle.close > 0) {
            const candleRangeBps = ((candle.high - candle.low) / candle.close) * 10000;
            if (candleRangeBps > 50) {
                dynamicBps += (candleRangeBps / 100) * config.volatilityMultiplier;
            }
        }
        const effectiveBps = Math.min(config.maxSlippageBps, Math.max(0, dynamicBps));
        const slippageAmount = Number(((price * effectiveBps) / 10000).toFixed(4));
        const executedPrice = side === 'BUY'
            ? Number((price + slippageAmount).toFixed(4))
            : Number((price - slippageAmount).toFixed(4));
        return {
            executedPrice,
            slippageAmount,
            slippageBps: effectiveBps,
        };
    }
}
exports.SlippageModel = SlippageModel;
//# sourceMappingURL=slippage-model.js.map