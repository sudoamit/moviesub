"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VolumeProfileAnalyzer = void 0;
class VolumeProfileAnalyzer {
    /**
     * Computes Volume Profile and Cumulative Volume Delta (CVD) across given candlestick history
     * @param candles Array of clean candlesticks
     * @param binCount Number of price distribution bins (default 30)
     * @param valueAreaPercentage Percentage of volume for value area (default 70%)
     */
    static compute(candles, binCount = 30, valueAreaPercentage = 0.7) {
        if (!candles || candles.length < 5)
            return null;
        let minPrice = Infinity;
        let maxPrice = -Infinity;
        let totalVolume = 0;
        for (const c of candles) {
            const high = Number(c.high);
            const low = Number(c.low);
            const vol = Number(c.volume || 1);
            if (low < minPrice)
                minPrice = low;
            if (high > maxPrice)
                maxPrice = high;
            totalVolume += vol;
        }
        if (minPrice >= maxPrice || totalVolume <= 0)
            return null;
        const priceRange = maxPrice - minPrice;
        const binSize = priceRange / binCount;
        // Initialize bins
        const bins = Array.from({ length: binCount }, (_, i) => ({
            priceLevel: Number((minPrice + (i + 0.5) * binSize).toFixed(2)),
            totalVolume: 0,
            buyVolume: 0,
            sellVolume: 0,
            delta: 0,
        }));
        // Distribute candle volumes into bins and calculate CVD
        let runningCVD = 0;
        const cvdList = [];
        for (const c of candles) {
            const open = Number(c.open);
            const close = Number(c.close);
            const high = Number(c.high);
            const low = Number(c.low);
            const vol = Number(c.volume || 1);
            // Estimate Buy/Sell ratio using candle close vs open position within candle range
            const candleRange = Math.max(0.01, high - low);
            const buyRatio = Math.max(0.1, Math.min(0.9, (close - low) / candleRange));
            const buyVol = vol * buyRatio;
            const sellVol = vol * (1 - buyRatio);
            const barDelta = buyVol - sellVol;
            runningCVD += barDelta;
            cvdList.push({
                timestamp: typeof c.timestamp === 'string' ? c.timestamp : c.timestamp.toISOString(),
                delta: Number(barDelta.toFixed(2)),
                cumulativeDelta: Number(runningCVD.toFixed(2)),
            });
            // Distribute volume into overlapping price bins
            const startBin = Math.max(0, Math.min(binCount - 1, Math.floor((low - minPrice) / binSize)));
            const endBin = Math.max(0, Math.min(binCount - 1, Math.floor((high - minPrice) / binSize)));
            const touchedBins = endBin - startBin + 1;
            const volPerBin = vol / touchedBins;
            const buyPerBin = buyVol / touchedBins;
            const sellPerBin = sellVol / touchedBins;
            for (let i = startBin; i <= endBin; i++) {
                bins[i].totalVolume += volPerBin;
                bins[i].buyVolume += buyPerBin;
                bins[i].sellVolume += sellPerBin;
                bins[i].delta += buyPerBin - sellPerBin;
            }
        }
        // Find Point of Control (POC)
        let maxBinVol = -1;
        let pocIndex = Math.floor(binCount / 2);
        bins.forEach((b, idx) => {
            if (b.totalVolume > maxBinVol) {
                maxBinVol = b.totalVolume;
                pocIndex = idx;
            }
        });
        const poc = bins[pocIndex].priceLevel;
        // Calculate Value Area (VAH & VAL) containing 70% of total volume expanding outward from POC
        const targetVolume = totalVolume * valueAreaPercentage;
        let currentVolume = bins[pocIndex].totalVolume;
        let upIdx = pocIndex;
        let downIdx = pocIndex;
        while (currentVolume < targetVolume && (upIdx < binCount - 1 || downIdx > 0)) {
            const nextUpVol = upIdx < binCount - 1 ? bins[upIdx + 1].totalVolume : 0;
            const nextDownVol = downIdx > 0 ? bins[downIdx - 1].totalVolume : 0;
            if (nextUpVol >= nextDownVol && upIdx < binCount - 1) {
                upIdx++;
                currentVolume += bins[upIdx].totalVolume;
            }
            else if (downIdx > 0) {
                downIdx--;
                currentVolume += bins[downIdx].totalVolume;
            }
            else if (upIdx < binCount - 1) {
                upIdx++;
                currentVolume += bins[upIdx].totalVolume;
            }
            else {
                break;
            }
        }
        const vah = bins[upIdx].priceLevel;
        const val = bins[downIdx].priceLevel;
        return {
            poc,
            vah,
            val,
            totalVolume,
            bins,
            cvd: cvdList,
        };
    }
}
exports.VolumeProfileAnalyzer = VolumeProfileAnalyzer;
//# sourceMappingURL=volume-profile.js.map