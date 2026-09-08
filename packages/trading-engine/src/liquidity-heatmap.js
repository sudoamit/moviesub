"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LiquidityHeatmapEngine = void 0;
class LiquidityHeatmapEngine {
    /**
     * Generates institutional resting liquidity heatmap density bands
     */
    static compute(candles, tolerancePct = 0.0015) {
        if (!candles || candles.length < 10) {
            return {
                symbol: 'NIFTY',
                currentPrice: 0,
                totalRestingLiquidityScore: 0,
                topBSLClusters: [],
                topSSLClusters: [],
                heatBands: [],
            };
        }
        const currentPrice = candles[candles.length - 1].close;
        const highs = candles.map((c) => c.high);
        const lows = candles.map((c) => c.low);
        const minP = Math.min(...lows);
        const maxP = Math.max(...highs);
        const span = maxP - minP;
        if (span <= 0) {
            return {
                symbol: 'NIFTY',
                currentPrice,
                totalRestingLiquidityScore: 0,
                topBSLClusters: [],
                topSSLClusters: [],
                heatBands: [],
            };
        }
        const numBuckets = 30;
        const bucketSize = span / numBuckets;
        const heatBands = [];
        for (let i = 0; i < numBuckets; i++) {
            const bucketLow = minP + i * bucketSize;
            const bucketHigh = bucketLow + bucketSize;
            const mid = (bucketLow + bucketHigh) / 2;
            // Count touches near this level
            let highTouches = 0;
            let lowTouches = 0;
            candles.forEach((c) => {
                if (Math.abs(c.high - mid) / mid <= tolerancePct)
                    highTouches++;
                if (Math.abs(c.low - mid) / mid <= tolerancePct)
                    lowTouches++;
            });
            const totalTouches = highTouches + lowTouches;
            if (totalTouches >= 2) {
                const isBSL = mid >= currentPrice;
                const densityScore = Math.min(100, totalTouches * 18);
                const alpha = (densityScore / 100) * 0.45;
                // Color coding: BSL is Amber/Gold/Magenta, SSL is Cyan/Teal
                const color = isBSL
                    ? `rgba(245, 158, 11, ${alpha.toFixed(2)})`
                    : `rgba(6, 182, 212, ${alpha.toFixed(2)})`;
                heatBands.push({
                    priceLevel: Number(mid.toFixed(2)),
                    type: isBSL ? 'BSL_HEAT' : 'SSL_HEAT',
                    densityScore,
                    intensityColor: color,
                    touchCount: totalTouches,
                    label: isBSL
                        ? `🔥 BSL Cluster (${totalTouches} touches)`
                        : `💧 SSL Cluster (${totalTouches} touches)`,
                    minPrice: Number(bucketLow.toFixed(2)),
                    maxPrice: Number(bucketHigh.toFixed(2)),
                });
            }
        }
        const topBSLClusters = heatBands
            .filter((b) => b.type === 'BSL_HEAT')
            .sort((a, b) => b.densityScore - a.densityScore)
            .slice(0, 4);
        const topSSLClusters = heatBands
            .filter((b) => b.type === 'SSL_HEAT')
            .sort((a, b) => b.densityScore - a.densityScore)
            .slice(0, 4);
        return {
            symbol: 'NIFTY',
            currentPrice,
            totalRestingLiquidityScore: Math.min(100, heatBands.reduce((acc, h) => acc + h.densityScore, 0) / 4),
            topBSLClusters,
            topSSLClusters,
            heatBands,
        };
    }
}
exports.LiquidityHeatmapEngine = LiquidityHeatmapEngine;
//# sourceMappingURL=liquidity-heatmap.js.map