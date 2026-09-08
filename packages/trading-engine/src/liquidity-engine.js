"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LiquidityEngine = void 0;
const shared_1 = require("@quant/shared");
const indicators_1 = require("@quant/indicators");
class LiquidityEngine {
    /**
     * Detects Liquidity Pools (Equal Highs/Lows, BSL, SSL) and Liquidity Sweeps with zero look-ahead bias.
     * A pool is only eligible to be swept AFTER all of its constituent swing points have been fully confirmed.
     */
    static detectLiquidity(candles, swings, options = {}) {
        if (!candles || candles.length === 0 || !swings || swings.length === 0) {
            return { pools: [], sweeps: [] };
        }
        const toleranceMult = options.equalHighLowToleranceAtr ?? 0.15;
        const atr = (0, indicators_1.calculateATR)(candles, 14);
        const pools = [];
        const sweeps = [];
        const swingHighs = swings.filter((s) => s.type === shared_1.StructureType.SWING_HIGH ||
            s.type === shared_1.StructureType.HIGHER_HIGH ||
            s.type === shared_1.StructureType.LOWER_HIGH);
        const swingLows = swings.filter((s) => s.type === shared_1.StructureType.SWING_LOW ||
            s.type === shared_1.StructureType.HIGHER_LOW ||
            s.type === shared_1.StructureType.LOWER_LOW);
        const consumedHighIndices = new Set();
        const consumedLowIndices = new Set();
        const lastIndex = candles.length - 1;
        // 1. Group and detect Equal Highs (EQH) and Buy-Side Liquidity (BSL)
        for (let i = 0; i < swingHighs.length; i++) {
            const h1 = swingHighs[i];
            if (consumedHighIndices.has(h1.index))
                continue;
            const candleAtr = atr[h1.index] || Math.max(1, candles[h1.index].high * 0.005);
            const tolerance = candleAtr * toleranceMult;
            let matchedEQH = false;
            for (let j = i + 1; j < swingHighs.length; j++) {
                const h2 = swingHighs[j];
                if (consumedHighIndices.has(h2.index))
                    continue;
                if (Math.abs(h1.price - h2.price) <= tolerance) {
                    const avgLevel = (h1.price + h2.price) / 2;
                    const availableAtIndex = Math.max(h1.confirmedAtIndex, h2.confirmedAtIndex);
                    const availableAtTimestamp = h1.confirmedAtIndex >= h2.confirmedAtIndex
                        ? h1.confirmedAtTimestamp || candles[h1.confirmedAtIndex]?.timestamp || h1.timestamp
                        : h2.confirmedAtTimestamp || candles[h2.confirmedAtIndex]?.timestamp || h2.timestamp;
                    if (availableAtIndex <= lastIndex) {
                        pools.push({
                            id: `eqh-${h1.index}-${h2.index}`,
                            type: shared_1.LiquidityType.EQUAL_HIGHS,
                            priceLevel: avgLevel,
                            firstTimestamp: h1.timestamp,
                            lastTimestamp: h2.timestamp,
                            touchCount: 2,
                            isSwept: false,
                            availableAtIndex,
                            availableAtTimestamp,
                        });
                    }
                    consumedHighIndices.add(h1.index);
                    consumedHighIndices.add(h2.index);
                    matchedEQH = true;
                    break;
                }
            }
            if (!matchedEQH) {
                const availableAtIndex = h1.confirmedAtIndex;
                const availableAtTimestamp = h1.confirmedAtTimestamp || candles[h1.confirmedAtIndex]?.timestamp || h1.timestamp;
                if (availableAtIndex <= lastIndex) {
                    pools.push({
                        id: `bsl-${h1.index}`,
                        type: shared_1.LiquidityType.BUY_SIDE,
                        priceLevel: h1.price,
                        firstTimestamp: h1.timestamp,
                        lastTimestamp: h1.timestamp,
                        touchCount: 1,
                        isSwept: false,
                        availableAtIndex,
                        availableAtTimestamp,
                    });
                }
                consumedHighIndices.add(h1.index);
            }
        }
        // 2. Group and detect Equal Lows (EQL) and Sell-Side Liquidity (SSL)
        for (let i = 0; i < swingLows.length; i++) {
            const l1 = swingLows[i];
            if (consumedLowIndices.has(l1.index))
                continue;
            const candleAtr = atr[l1.index] || Math.max(1, candles[l1.index].low * 0.005);
            const tolerance = candleAtr * toleranceMult;
            let matchedEQL = false;
            for (let j = i + 1; j < swingLows.length; j++) {
                const l2 = swingLows[j];
                if (consumedLowIndices.has(l2.index))
                    continue;
                if (Math.abs(l1.price - l2.price) <= tolerance) {
                    const avgLevel = (l1.price + l2.price) / 2;
                    const availableAtIndex = Math.max(l1.confirmedAtIndex, l2.confirmedAtIndex);
                    const availableAtTimestamp = l1.confirmedAtIndex >= l2.confirmedAtIndex
                        ? l1.confirmedAtTimestamp || candles[l1.confirmedAtIndex]?.timestamp || l1.timestamp
                        : l2.confirmedAtTimestamp || candles[l2.confirmedAtIndex]?.timestamp || l2.timestamp;
                    if (availableAtIndex <= lastIndex) {
                        pools.push({
                            id: `eql-${l1.index}-${l2.index}`,
                            type: shared_1.LiquidityType.EQUAL_LOWS,
                            priceLevel: avgLevel,
                            firstTimestamp: l1.timestamp,
                            lastTimestamp: l2.timestamp,
                            touchCount: 2,
                            isSwept: false,
                            availableAtIndex,
                            availableAtTimestamp,
                        });
                    }
                    consumedLowIndices.add(l1.index);
                    consumedLowIndices.add(l2.index);
                    matchedEQL = true;
                    break;
                }
            }
            if (!matchedEQL) {
                const availableAtIndex = l1.confirmedAtIndex;
                const availableAtTimestamp = l1.confirmedAtTimestamp || candles[l1.confirmedAtIndex]?.timestamp || l1.timestamp;
                if (availableAtIndex <= lastIndex) {
                    pools.push({
                        id: `ssl-${l1.index}`,
                        type: shared_1.LiquidityType.SELL_SIDE,
                        priceLevel: l1.price,
                        firstTimestamp: l1.timestamp,
                        lastTimestamp: l1.timestamp,
                        touchCount: 1,
                        isSwept: false,
                        availableAtIndex,
                        availableAtTimestamp,
                    });
                }
                consumedLowIndices.add(l1.index);
            }
        }
        // 3. Detect Liquidity Sweeps (strictly chronologically)
        for (let c = 0; c < candles.length; c++) {
            const candle = candles[c];
            for (const pool of pools) {
                if (pool.isSwept)
                    continue;
                // Enforce availability boundary: candle can only sweep AFTER pool confirmation
                if (pool.availableAtIndex !== undefined) {
                    if (c < pool.availableAtIndex)
                        continue;
                }
                else if (pool.availableAtTimestamp) {
                    if (candle.timestamp < pool.availableAtTimestamp)
                        continue;
                }
                else if (candle.timestamp <= pool.lastTimestamp) {
                    continue;
                }
                // BSL / EQH Sweep: High trades above level, but Close finishes BELOW or AT level (rejection/reclaim wick)
                if ((pool.type === shared_1.LiquidityType.BUY_SIDE || pool.type === shared_1.LiquidityType.EQUAL_HIGHS) &&
                    candle.high > pool.priceLevel &&
                    candle.close <= pool.priceLevel) {
                    pool.isSwept = true;
                    pool.sweptAtIndex = c;
                    pool.sweptTimestamp = candle.timestamp;
                    pool.sweptPrice = candle.high;
                    pool.displacement = candle.high - pool.priceLevel;
                    sweeps.push({ ...pool });
                }
                // SSL / EQL Sweep: Low trades below level, but Close finishes ABOVE or AT level (rejection/reclaim wick)
                if ((pool.type === shared_1.LiquidityType.SELL_SIDE || pool.type === shared_1.LiquidityType.EQUAL_LOWS) &&
                    candle.low < pool.priceLevel &&
                    candle.close >= pool.priceLevel) {
                    pool.isSwept = true;
                    pool.sweptAtIndex = c;
                    pool.sweptTimestamp = candle.timestamp;
                    pool.sweptPrice = candle.low;
                    pool.displacement = pool.priceLevel - candle.low;
                    sweeps.push({ ...pool });
                }
            }
        }
        return { pools, sweeps };
    }
}
exports.LiquidityEngine = LiquidityEngine;
//# sourceMappingURL=liquidity-engine.js.map