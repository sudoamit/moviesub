"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiTimeframeAnalyzer = void 0;
const shared_1 = require("@quant/shared");
const smc_analyzer_1 = require("./smc-analyzer");
const candle_normalizer_1 = require("./candle-normalizer");
class MultiTimeframeAnalyzer {
    static getTimeframeDurationMs(tf) {
        const s = String(tf).toLowerCase().trim();
        if (s === '1m')
            return 60 * 1000;
        if (s === '3m')
            return 3 * 60 * 1000;
        if (s === '5m')
            return 5 * 60 * 1000;
        if (s === '15m')
            return 15 * 60 * 1000;
        if (s === '30m')
            return 30 * 60 * 1000;
        if (s === '1h' || s === '60m')
            return 60 * 60 * 1000;
        if (s === '2h')
            return 2 * 60 * 60 * 1000;
        if (s === '4h')
            return 4 * 60 * 60 * 1000;
        if (s === '1d' || s === 'd')
            return 24 * 60 * 60 * 1000;
        if (s === '1w' || s === 'w')
            return 7 * 24 * 60 * 60 * 1000;
        const unit = s.slice(-1);
        const val = parseInt(s.slice(0, -1), 10) || 1;
        if (unit === 'm')
            return val * 60 * 1000;
        if (unit === 'h')
            return val * 3600 * 1000;
        if (unit === 'd')
            return val * 86400 * 1000;
        if (unit === 'w')
            return val * 7 * 86400 * 1000;
        return 15 * 60 * 1000;
    }
    /**
     * Filters HTF candles strictly to only those whose close time is <= maxAllowedCloseTime.
     * Eliminates look-ahead bias across all multi-timeframe analysis.
     */
    static filterClosedHTFCandles(htfCandles, htfTimeframe, maxAllowedCloseTime) {
        if (!htfCandles || htfCandles.length === 0)
            return [];
        const duration = MultiTimeframeAnalyzer.getTimeframeDurationMs(htfTimeframe);
        return htfCandles.filter((c) => {
            const candleTime = new Date(c.timestamp).getTime();
            const closeTime = candleTime + duration;
            return closeTime <= maxAllowedCloseTime && c.isClosed !== false;
        });
    }
    /**
     * Analyzes Higher Timeframe (HTF) market structure to establish directional bias for lower timeframe execution
     * with guaranteed zero look-ahead bias.
     */
    static analyzeMTF(executionTf, htf1, htf2, mode = shared_1.MTFMode.BALANCED, asOfTimestamp) {
        let execCandles = candle_normalizer_1.CandleNormalizer.normalize(executionTf.candles);
        const execDuration = MultiTimeframeAnalyzer.getTimeframeDurationMs(executionTf.timeframe);
        let maxCloseTime;
        if (asOfTimestamp) {
            maxCloseTime = asOfTimestamp.getTime();
            execCandles = candle_normalizer_1.CandleNormalizer.getClosedCandlesAsOf(execCandles, executionTf.timeframe, asOfTimestamp);
        }
        else {
            const lastExecCandle = execCandles[execCandles.length - 1];
            maxCloseTime = lastExecCandle
                ? new Date(lastExecCandle.timestamp).getTime() + execDuration
                : Date.now();
        }
        const resolveTrendFromAnalysis = (candles, timeframe) => {
            if (candles && candles.length > 0) {
                const cleanCandles = MultiTimeframeAnalyzer.filterClosedHTFCandles(candle_normalizer_1.CandleNormalizer.normalize(candles), timeframe, maxCloseTime);
                if (cleanCandles.length > 0) {
                    const resolved = smc_analyzer_1.SMCAnalyzer.analyze(cleanCandles, {
                        timeframe,
                        asOfTimestamp: asOfTimestamp || new Date(maxCloseTime),
                    });
                    if (resolved.currentTrend !== shared_1.Direction.NEUTRAL) {
                        return resolved.currentTrend;
                    }
                    if (resolved.marketRegime?.regime === 'BULLISH_TREND')
                        return shared_1.Direction.BULLISH;
                    if (resolved.marketRegime?.regime === 'BEARISH_TREND')
                        return shared_1.Direction.BEARISH;
                }
            }
            return shared_1.Direction.NEUTRAL;
        };
        const htf1Trend = resolveTrendFromAnalysis(htf1.candles, htf1.timeframe);
        let htf2Trend = undefined;
        if (htf2) {
            htf2Trend = resolveTrendFromAnalysis(htf2.candles, htf2.timeframe);
        }
        // Determine overall HTF bias
        let htfBias = shared_1.Direction.NEUTRAL;
        let alignmentScore = 0;
        let isAligned = false;
        let reason = '';
        if (htf2Trend && htf2) {
            if (htf1Trend === htf2Trend && htf1Trend !== shared_1.Direction.NEUTRAL) {
                htfBias = htf1Trend;
                alignmentScore = 20;
                isAligned = true;
                reason = `Strong HTF alignment: Both ${htf1.timeframe} and ${htf2.timeframe} are strictly ${htf1Trend}`;
            }
            else if (htf1Trend !== shared_1.Direction.NEUTRAL) {
                if (mode === shared_1.MTFMode.AGGRESSIVE) {
                    htfBias = htf1Trend;
                    alignmentScore = 15;
                    isAligned = true;
                    reason = `Aggressive mode: Following intermediate HTF (${htf1.timeframe} is ${htf1Trend}) while ${htf2.timeframe} is ${htf2Trend}`;
                }
                else {
                    htfBias = htf1Trend;
                    alignmentScore = 10;
                    isAligned = mode === shared_1.MTFMode.BALANCED;
                    reason = `Moderate alignment: ${htf1.timeframe} is ${htf1Trend}, while ${htf2.timeframe} is ${htf2Trend}`;
                }
            }
            else {
                htfBias = htf2Trend;
                alignmentScore = 10;
                isAligned = mode !== shared_1.MTFMode.STRICT;
                reason = `Intermediate HTF (${htf1.timeframe}) is neutral; using macro ${htf2.timeframe} ${htf2Trend}`;
            }
        }
        else {
            htfBias = htf1Trend;
            alignmentScore = htf1Trend !== shared_1.Direction.NEUTRAL ? 20 : 0;
            isAligned = htf1Trend !== shared_1.Direction.NEUTRAL;
            reason = `Single HTF reference (${htf1.timeframe}) is ${htf1Trend}`;
        }
        return {
            executionTimeframe: executionTf.timeframe,
            htfBias,
            htf1Timeframe: htf1.timeframe,
            htf1Trend,
            htf2Timeframe: htf2?.timeframe,
            htf2Trend,
            isAligned,
            alignmentScore,
            reason,
        };
    }
}
exports.MultiTimeframeAnalyzer = MultiTimeframeAnalyzer;
//# sourceMappingURL=mtf-analyzer.js.map