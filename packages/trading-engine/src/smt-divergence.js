"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SMTDivergenceEngine = void 0;
const shared_1 = require("@quant/shared");
const swing_detector_1 = require("./swing-detector");
class SMTDivergenceEngine {
    /**
     * Detects Smart Money Technique (SMT) Correlation Divergence between two correlated assets
     */
    static analyze(assetASymbol, candlesA, assetBSymbol, candlesB, lookback = 35) {
        if (!candlesA || candlesA.length < 10 || !candlesB || candlesB.length < 10) {
            return {
                assetA: assetASymbol,
                assetB: assetBSymbol,
                divergenceType: 'NEUTRAL',
                convictionScore: 0,
                assetASwing: { type: 'HIGH', price1: 0, price2: 0, trend: 'HH' },
                assetBSwing: { type: 'HIGH', price1: 0, price2: 0, trend: 'HH' },
                narrative: 'Insufficient candle data for SMT correlation divergence analysis',
                actionableSignal: 'NO_DIVERGENCE',
                timestamp: new Date().toISOString(),
            };
        }
        const recentA = candlesA.slice(-lookback);
        const recentB = candlesB.slice(-lookback);
        const swingsA = swing_detector_1.SwingDetector.detectSwings(recentA, { leftBars: 3, rightBars: 3 });
        const swingsB = swing_detector_1.SwingDetector.detectSwings(recentB, { leftBars: 3, rightBars: 3 });
        const highsA = swingsA.filter((s) => s.type === shared_1.StructureType.SWING_HIGH ||
            s.type === shared_1.StructureType.HIGHER_HIGH ||
            s.type === shared_1.StructureType.LOWER_HIGH);
        const lowsA = swingsA.filter((s) => s.type === shared_1.StructureType.SWING_LOW ||
            s.type === shared_1.StructureType.HIGHER_LOW ||
            s.type === shared_1.StructureType.LOWER_LOW);
        const highsB = swingsB.filter((s) => s.type === shared_1.StructureType.SWING_HIGH ||
            s.type === shared_1.StructureType.HIGHER_HIGH ||
            s.type === shared_1.StructureType.LOWER_HIGH);
        const lowsB = swingsB.filter((s) => s.type === shared_1.StructureType.SWING_LOW ||
            s.type === shared_1.StructureType.HIGHER_LOW ||
            s.type === shared_1.StructureType.LOWER_LOW);
        // 1. Check for Bearish SMT (Distribution) on recent 2 swing highs
        if (highsA.length >= 2 && highsB.length >= 2) {
            const aPrev = highsA[highsA.length - 2].price;
            const aCurr = highsA[highsA.length - 1].price;
            const bPrev = highsB[highsB.length - 2].price;
            const bCurr = highsB[highsB.length - 1].price;
            const aIsHH = aCurr > aPrev;
            const bIsLH = bCurr < bPrev;
            const aIsLH = aCurr < aPrev;
            const bIsHH = bCurr > bPrev;
            if ((aIsHH && bIsLH) || (aIsLH && bIsHH)) {
                const leader = aIsHH ? assetASymbol : assetBSymbol;
                const laggard = aIsHH ? assetBSymbol : assetASymbol;
                return {
                    assetA: assetASymbol,
                    assetB: assetBSymbol,
                    divergenceType: 'BEARISH_SMT',
                    convictionScore: 92,
                    assetASwing: { type: 'HIGH', price1: aPrev, price2: aCurr, trend: aIsHH ? 'HH' : 'LH' },
                    assetBSwing: { type: 'HIGH', price1: bPrev, price2: bCurr, trend: bIsHH ? 'HH' : 'LH' },
                    narrative: `🔥 High-Conviction BEARISH SMT Distribution: ${leader} printed a Higher High but ${laggard} failed with a Lower High. Smart Money is aggressively distributing before a major downside expansion.`,
                    actionableSignal: 'STRONG_SELL',
                    timestamp: new Date().toISOString(),
                };
            }
        }
        // 2. Check for Bullish SMT (Accumulation) on recent 2 swing lows
        if (lowsA.length >= 2 && lowsB.length >= 2) {
            const aPrev = lowsA[lowsA.length - 2].price;
            const aCurr = lowsA[lowsA.length - 1].price;
            const bPrev = lowsB[lowsB.length - 2].price;
            const bCurr = lowsB[lowsB.length - 1].price;
            const aIsLL = aCurr < aPrev;
            const bIsHL = bCurr > bPrev;
            const aIsHL = aCurr > aPrev;
            const bIsLL = bCurr < bPrev;
            if ((aIsLL && bIsHL) || (aIsHL && bIsLL)) {
                const leader = aIsLL ? assetASymbol : assetBSymbol;
                const laggard = aIsLL ? assetBSymbol : assetASymbol;
                return {
                    assetA: assetASymbol,
                    assetB: assetBSymbol,
                    divergenceType: 'BULLISH_SMT',
                    convictionScore: 90,
                    assetASwing: { type: 'LOW', price1: aPrev, price2: aCurr, trend: aIsLL ? 'LL' : 'HL' },
                    assetBSwing: { type: 'LOW', price1: bPrev, price2: bCurr, trend: bIsHL ? 'HL' : 'LL' },
                    narrative: `⚡ High-Conviction BULLISH SMT Accumulation: ${leader} swept liquidity to a Lower Low while ${laggard} held strong with a Higher Low. Institutional absorption confirmed.`,
                    actionableSignal: 'STRONG_BUY',
                    timestamp: new Date().toISOString(),
                };
            }
        }
        // Neutral baseline
        return {
            assetA: assetASymbol,
            assetB: assetBSymbol,
            divergenceType: 'NEUTRAL',
            convictionScore: 50,
            assetASwing: { type: 'HIGH', price1: 0, price2: 0, trend: 'HH' },
            assetBSwing: { type: 'HIGH', price1: 0, price2: 0, trend: 'HH' },
            narrative: `Both ${assetASymbol} and ${assetBSymbol} are in synchronized correlation with no institutional lead-lag divergence.`,
            actionableSignal: 'NO_DIVERGENCE',
            timestamp: new Date().toISOString(),
        };
    }
}
exports.SMTDivergenceEngine = SMTDivergenceEngine;
//# sourceMappingURL=smt-divergence.js.map