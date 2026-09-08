"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorAnalyzer = void 0;
class ErrorAnalyzer {
    /**
     * Analyzes an array of completed trading experiences to compile a detailed Error Report.
     */
    static analyze(experiences) {
        const totalTrades = experiences.length;
        if (totalTrades === 0) {
            return {
                periodStart: new Date(),
                periodEnd: new Date(),
                totalTrades: 0,
                overallWinRate: 0,
                overallExpectancy: 0,
                failureStats: [],
                topLossDrivers: [],
                recommendations: ['Insufficient trade data to generate error analytics.'],
            };
        }
        const periodStart = new Date(experiences[0].timestamp);
        const periodEnd = new Date(experiences[experiences.length - 1].timestamp);
        const winCount = experiences.filter((e) => e.outcome.status === 'WIN').length;
        const overallWinRate = Number(((winCount / totalTrades) * 100).toFixed(1));
        const totalR = experiences.reduce((sum, e) => sum + e.outcome.pnlR, 0);
        const overallExpectancy = Number((totalR / totalTrades).toFixed(2));
        // Map failure modes
        const modeBuckets = new Map();
        for (const exp of experiences) {
            for (const mode of exp.failureReasons) {
                if (!modeBuckets.has(mode)) {
                    modeBuckets.set(mode, { experiences: [], totalLoss: 0 });
                }
                const b = modeBuckets.get(mode);
                b.experiences.push(exp);
                if (exp.outcome.pnl < 0) {
                    b.totalLoss += Math.abs(exp.outcome.pnl);
                }
            }
        }
        const totalPortfolioLoss = experiences
            .filter((e) => e.outcome.pnl < 0)
            .reduce((sum, e) => sum + Math.abs(e.outcome.pnl), 0);
        const failureStats = [];
        for (const [mode, bucket] of modeBuckets.entries()) {
            const exps = bucket.experiences;
            const count = exps.length;
            const frequency = Number(((count / totalTrades) * 100).toFixed(1));
            const totalLossAmount = Number(bucket.totalLoss.toFixed(2));
            const lossContributionPct = totalPortfolioLoss > 0
                ? Number(((totalLossAmount / totalPortfolioLoss) * 100).toFixed(1))
                : 0;
            const modeWins = exps.filter((e) => e.outcome.status === 'WIN').length;
            const modeWinRate = Number(((modeWins / count) * 100).toFixed(1));
            const modeR = exps.reduce((sum, e) => sum + e.outcome.pnlR, 0);
            const averageR = Number((modeR / count).toFixed(2));
            // Distributions
            const regimeDist = {};
            const timeframeDist = {};
            const instDist = {};
            for (const e of exps) {
                const r = e.marketContext.regime || 'UNKNOWN';
                regimeDist[r] = (regimeDist[r] || 0) + 1;
                const tf = e.marketState?.candles?.[0]?.timeframe || '15m';
                timeframeDist[tf] = (timeframeDist[tf] || 0) + 1;
                const sym = e.instrument.symbol;
                instDist[sym] = (instDist[sym] || 0) + 1;
            }
            failureStats.push({
                failureMode: mode,
                count,
                frequency,
                totalLossAmount,
                lossContributionPct,
                averageR,
                winRate: modeWinRate,
                expectancy: averageR,
                regimeDistribution: regimeDist,
                timeframeDistribution: timeframeDist,
                instrumentDistribution: instDist,
            });
        }
        // Sort by total loss contribution descending
        failureStats.sort((a, b) => b.totalLossAmount - a.totalLossAmount);
        const topLossDrivers = failureStats.slice(0, 5);
        // Build automated actionable recommendations
        const recommendations = [];
        for (const driver of topLossDrivers) {
            if (driver.failureMode === 'HTF_CONFLICT' && driver.count >= 5) {
                recommendations.push(`Eliminate trades conflicting with Higher Timeframe trend. ${driver.count} trades generated ${driver.averageR}R expectancy.`);
            }
            else if (driver.failureMode === 'VOLATILITY_MISREAD' && driver.count >= 5) {
                recommendations.push(`Restrict entries during HIGH_VOLATILITY shocks or scale position sizing down by 50%.`);
            }
            else if (driver.failureMode === 'STOP_TOO_TIGHT' && driver.count >= 5) {
                recommendations.push(`Widen minimum structural stop buffer. Tight stops caused ${driver.count} early premature invalidations.`);
            }
            else if (driver.failureMode === 'TARGET_TOO_FAR' && driver.count >= 5) {
                recommendations.push(`Introduce partial scaling at TP1 (1.5R) before trailing to breakeven to lock in accrued favorable excursion.`);
            }
            else if (driver.lossContributionPct > 20) {
                recommendations.push(`Failure mode ${driver.failureMode} is responsible for ${driver.lossContributionPct}% of total losses. Prioritize generating a candidate filter.`);
            }
        }
        if (recommendations.length === 0) {
            recommendations.push('Failure distribution is well-dispersed without concentrated systematic errors.');
        }
        return {
            periodStart,
            periodEnd,
            totalTrades,
            overallWinRate,
            overallExpectancy,
            failureStats,
            topLossDrivers,
            recommendations,
        };
    }
    /**
     * Dissects high-confidence losing predictions (P(win) >= 0.75 that resulted in loss) to isolate overconfidence patterns.
     */
    static analyzeHighConfidenceLosses(experiences) {
        const highConf = experiences.filter((e) => (e.prediction?.probabilityWin || 0) >= 0.75);
        const highConfLosses = highConf.filter((e) => e.outcome?.status === 'LOSS' || (e.outcome?.pnlR || 0) < 0);
        if (highConf.length === 0) {
            return {
                count: 0,
                frequencyPct: 0,
                averageLossR: 0,
                prominentRegimes: {},
                prominentFailureReasons: {},
                calibrationRecommendation: 'No high-confidence predictions recorded.',
            };
        }
        const lossCount = highConfLosses.length;
        const freqPct = Number(((lossCount / highConf.length) * 100).toFixed(1));
        const totalLossR = highConfLosses.reduce((acc, e) => acc + (e.outcome?.pnlR || 0), 0);
        const avgLossR = lossCount > 0 ? Number((totalLossR / lossCount).toFixed(2)) : 0;
        const regimeCounts = {};
        const failureCounts = {};
        for (const e of highConfLosses) {
            const reg = e.marketContext?.regime || 'UNKNOWN';
            regimeCounts[reg] = (regimeCounts[reg] || 0) + 1;
            for (const f of e.failureReasons || []) {
                failureCounts[f] = (failureCounts[f] || 0) + 1;
            }
        }
        const rec = freqPct > 25
            ? `Elevated high-confidence loss rate (${freqPct}%). Platt scaling calibration error detected. Dampen raw probabilities by 15%.`
            : `High-confidence win fidelity is healthy (${(100 - freqPct).toFixed(1)}% win rate for P >= 0.75).`;
        return {
            count: lossCount,
            frequencyPct: freqPct,
            averageLossR: avgLossR,
            prominentRegimes: regimeCounts,
            prominentFailureReasons: failureCounts,
            calibrationRecommendation: rec,
        };
    }
    /**
     * Computes conditional win probabilities: P(win | regime), P(win | volatility), P(win | session), P(win | setup).
     */
    static computeConditionalProbabilities(experiences) {
        const calcGroup = (keyExtractor) => {
            const groups = {};
            for (const e of experiences) {
                const k = keyExtractor(e) || 'UNKNOWN';
                if (!groups[k])
                    groups[k] = [];
                groups[k].push(e);
            }
            const res = {};
            for (const [k, exps] of Object.entries(groups)) {
                const wins = exps.filter((e) => e.outcome?.status === 'WIN' || (e.outcome?.pnlR || 0) > 0).length;
                const totalR = exps.reduce((acc, e) => acc + (e.outcome?.pnlR || 0), 0);
                res[k] = {
                    count: exps.length,
                    winRate: Number(((wins / exps.length) * 100).toFixed(1)),
                    expectancyR: Number((totalR / exps.length).toFixed(2)),
                };
            }
            return res;
        };
        return {
            byRegime: calcGroup((e) => e.marketContext?.regime || 'UNKNOWN'),
            byVolatility: calcGroup((e) => e.marketContext?.volatilityRegime || 'UNKNOWN'),
            bySession: calcGroup((e) => e.marketContext?.session || 'UNKNOWN'),
            bySetup: calcGroup((e) => e.decision?.action || 'UNKNOWN'),
        };
    }
}
exports.ErrorAnalyzer = ErrorAnalyzer;
//# sourceMappingURL=error-analyzer.js.map