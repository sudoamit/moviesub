"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegimePerformanceAnalyzer = void 0;
class RegimePerformanceAnalyzer {
    /**
     * Evaluates strategy performance isolated across individual market regimes.
     */
    static analyze(experiences) {
        const buckets = new Map();
        for (const exp of experiences) {
            const r = exp.marketContext.regime || 'UNKNOWN';
            if (!buckets.has(r))
                buckets.set(r, []);
            buckets.get(r).push(exp);
        }
        const results = [];
        for (const [regime, exps] of buckets.entries()) {
            const count = exps.length;
            if (count === 0)
                continue;
            const rList = exps.map((e) => e.outcome.pnlR);
            const sumR = rList.reduce((a, b) => a + b, 0);
            const meanR = sumR / count;
            const wins = exps.filter((e) => e.outcome.status === 'WIN').length;
            const winRate = Number(((wins / count) * 100).toFixed(1));
            const grossProfit = exps
                .filter((e) => e.outcome.pnl > 0)
                .reduce((sum, e) => sum + e.outcome.pnl, 0);
            const grossLoss = exps
                .filter((e) => e.outcome.pnl < 0)
                .reduce((sum, e) => sum + Math.abs(e.outcome.pnl), 0);
            const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 5.0 : 0.0;
            // Variance & Sharpe
            const variance = count > 1 ? rList.reduce((sum, r) => sum + Math.pow(r - meanR, 2), 0) / (count - 1) : 1.0;
            const stdDev = Math.sqrt(variance);
            const sharpeRatio = stdDev > 0 ? Number(((meanR / stdDev) * Math.sqrt(252)).toFixed(2)) : 0;
            // Downside variance & Sortino
            const downside = rList.filter((r) => r < 0);
            const downsideVar = downside.length > 0
                ? downside.reduce((sum, r) => sum + Math.pow(r, 2), 0) / downside.length
                : 1.0;
            const downsideStd = Math.sqrt(downsideVar);
            const sortinoRatio = downsideStd > 0 ? Number(((meanR / downsideStd) * Math.sqrt(252)).toFixed(2)) : 0;
            // Max DD in R
            let peakR = 0;
            let runningR = 0;
            let maxDDR = 0;
            for (const r of rList) {
                runningR += r;
                if (runningR > peakR)
                    peakR = runningR;
                const dd = peakR - runningR;
                if (dd > maxDDR)
                    maxDDR = dd;
            }
            results.push({
                regime,
                tradeCount: count,
                winRate,
                expectancy: Number(meanR.toFixed(2)),
                averageR: Number(meanR.toFixed(2)),
                profitFactor,
                maxDrawdownR: Number(maxDDR.toFixed(2)),
                sharpeRatio,
                sortinoRatio,
            });
        }
        results.sort((a, b) => b.expectancy - a.expectancy);
        return results;
    }
}
exports.RegimePerformanceAnalyzer = RegimePerformanceAnalyzer;
//# sourceMappingURL=regime-performance-analyzer.js.map