"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpreadModel = exports.DEFAULT_SPREAD_CONFIG = void 0;
exports.DEFAULT_SPREAD_CONFIG = {
    baseSpreadBps: 1.5, // 0.015%
    illiquidMultiplier: 2.5,
};
class SpreadModel {
    /**
     * Calculates realistic market bid-ask half-spread
     */
    static getHalfSpread(price, symbol, config = exports.DEFAULT_SPREAD_CONFIG) {
        const sym = (symbol || '').toUpperCase();
        let spreadBps = config.baseSpreadBps;
        if (sym === 'NIFTY' || sym === 'BANKNIFTY') {
            spreadBps = 0.5; // Very tight liquid index spread (0.005%)
        }
        else if (sym === 'BTCUSDT' || sym === 'XAUUSD') {
            spreadBps = 1.0; // Tight crypto/gold spread
        }
        return Number(((price * spreadBps) / (2 * 10000)).toFixed(4));
    }
}
exports.SpreadModel = SpreadModel;
//# sourceMappingURL=spread-model.js.map