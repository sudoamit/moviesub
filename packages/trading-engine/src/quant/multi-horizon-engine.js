"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiHorizonEngine = void 0;
const shared_1 = require("@quant/shared");
const indicators_1 = require("@quant/indicators");
const regime_clustering_engine_1 = require("./regime-clustering-engine");
const candle_normalizer_1 = require("../candle-normalizer");
class MultiHorizonEngine {
    /**
     * Filters a horizon candle set down to only closed candles whose close time is <= asOfTimestamp.
     */
    static getClosedCandlesAsOf(candles, timeframe, asOfTimestamp) {
        if (!candles || candles.length === 0)
            return [];
        if (!asOfTimestamp) {
            return candle_normalizer_1.CandleNormalizer.normalize(candles).filter((c) => c.isClosed !== false);
        }
        return candle_normalizer_1.CandleNormalizer.getClosedCandlesAsOf(candles, timeframe, asOfTimestamp);
    }
    /**
     * Analyzes an individual horizon timeframe.
     */
    static analyzeHorizon(candles, tfName, asOfTimestamp) {
        const closedCandles = this.getClosedCandlesAsOf(candles || [], tfName, asOfTimestamp);
        if (!closedCandles || closedCandles.length < 5) {
            return {
                timeframe: tfName,
                trend: shared_1.Direction.NEUTRAL,
                regime: shared_1.MarketRegimeType.RANGE,
                volatilityAtr: 0,
                momentumScore: 50,
                structureBroken: false,
            };
        }
        const closes = closedCandles.map((c) => c.close);
        const lastClose = closes[closes.length - 1];
        const ema20 = (0, indicators_1.calculateEMA)(closes, 20);
        const ema50 = (0, indicators_1.calculateEMA)(closes, 50);
        const rsi = (0, indicators_1.calculateRSI)(closes, 14);
        const atr = (0, indicators_1.calculateATR)(closedCandles, 14);
        const lastEma20 = ema20[closes.length - 1] ?? lastClose;
        const lastEma50 = ema50[closes.length - 1] ?? lastClose;
        const lastRsi = rsi[closes.length - 1] ?? 50;
        const lastAtr = atr[closedCandles.length - 1] ?? 0;
        let trend = shared_1.Direction.NEUTRAL;
        if (lastClose > lastEma20 && lastEma20 >= lastEma50) {
            trend = shared_1.Direction.BULLISH;
        }
        else if (lastClose < lastEma20 && lastEma20 <= lastEma50) {
            trend = shared_1.Direction.BEARISH;
        }
        const regime = regime_clustering_engine_1.RegimeClusteringEngine.classifyRegime(closedCandles).regime;
        // Check recent high/low break
        let structureBroken = false;
        if (closedCandles.length >= 10) {
            const recentHighs = closedCandles.slice(-10, -1).map((c) => c.high);
            const recentLows = closedCandles.slice(-10, -1).map((c) => c.low);
            const maxHigh = Math.max(...recentHighs);
            const minLow = Math.min(...recentLows);
            if (lastClose > maxHigh || lastClose < minLow) {
                structureBroken = true;
            }
        }
        return {
            timeframe: tfName,
            trend,
            regime,
            volatilityAtr: Number(lastAtr.toFixed(2)),
            momentumScore: Math.round(lastRsi),
            structureBroken,
        };
    }
    /**
     * Compiles multi-horizon alignment across Macro, HTF, and Execution.
     */
    static evaluateMultiHorizon(executionCandles, htfCandles, macroCandles, options = {}) {
        const executionTf = options.executionTimeframe || '15m';
        const htfTf = options.htfTimeframe || '1h';
        const macroTf = options.macroTimeframe || '4h';
        let asOfTimestamp = options.asOfTimestamp;
        if (!asOfTimestamp && executionCandles && executionCandles.length > 0) {
            const normExec = candle_normalizer_1.CandleNormalizer.normalize(executionCandles).filter((c) => c.isClosed !== false);
            if (normExec.length > 0) {
                const lastExec = normExec[normExec.length - 1];
                asOfTimestamp = candle_normalizer_1.CandleNormalizer.getCandleCloseTimestamp(lastExec, executionTf);
            }
        }
        const execFiltered = this.getClosedCandlesAsOf(executionCandles, executionTf, asOfTimestamp);
        const htfFiltered = this.getClosedCandlesAsOf(htfCandles || executionCandles, htfTf, asOfTimestamp);
        const macroFiltered = this.getClosedCandlesAsOf(macroCandles || htfCandles || executionCandles, macroTf, asOfTimestamp);
        const execution = this.analyzeHorizon(execFiltered, executionTf, asOfTimestamp);
        const higherTimeframe = this.analyzeHorizon(htfFiltered, htfTf, asOfTimestamp);
        const macro = this.analyzeHorizon(macroFiltered, macroTf, asOfTimestamp);
        const trends = [execution.trend, higherTimeframe.trend, macro.trend].filter((t) => t !== shared_1.Direction.NEUTRAL);
        const bullCount = trends.filter((t) => t === shared_1.Direction.BULLISH).length;
        const bearCount = trends.filter((t) => t === shared_1.Direction.BEARISH).length;
        let alignment = 'PARTIALLY_ALIGNED';
        let confluenceScore = 50;
        if (bullCount === 3 || bearCount === 3) {
            alignment = 'ALIGNED';
            confluenceScore = 95;
        }
        else if (bullCount >= 2 || bearCount >= 2) {
            if (execution.trend !== shared_1.Direction.NEUTRAL &&
                higherTimeframe.trend !== shared_1.Direction.NEUTRAL &&
                execution.trend !== higherTimeframe.trend) {
                alignment = 'CONFLICTED';
                confluenceScore = 30;
            }
            else {
                alignment = 'PARTIALLY_ALIGNED';
                confluenceScore = 75;
            }
        }
        else {
            alignment = 'PARTIALLY_ALIGNED';
            confluenceScore = 50;
        }
        return {
            macro,
            higherTimeframe,
            execution,
            alignment,
            confluenceScore,
        };
    }
}
exports.MultiHorizonEngine = MultiHorizonEngine;
//# sourceMappingURL=multi-horizon-engine.js.map