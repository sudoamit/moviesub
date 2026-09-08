"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MTFFlowRadarEngine = void 0;
const shared_1 = require("@quant/shared");
const smc_analyzer_1 = require("./smc-analyzer");
class MTFFlowRadarEngine {
    /**
     * Computes 4-Tier Multi-Timeframe Institutional Order Flow Confluence
     */
    static analyze(symbol, candles4h = [], candles1h = [], candles15m = [], candles5m = []) {
        // 1. Tier 1: 4h Macro Trend
        const smc4h = candles4h.length >= 5 ? smc_analyzer_1.SMCAnalyzer.analyze(candles4h) : null;
        const is4hBull = smc4h
            ? smc4h.marketRegime.regime === shared_1.MarketRegimeType.BULLISH_TREND ||
                smc4h.breaksOfStructure.some((b) => b.direction === 'BULLISH')
            : true;
        const h4Tier = {
            timeframe: '4h',
            name: '4h Macro Order Flow',
            direction: is4hBull ? 'BULLISH' : 'BEARISH',
            score: smc4h ? 25 : 20,
            keyFactor: smc4h
                ? `4h Macro Structure is strictly ${smc4h.marketRegime.regime} (BOS: ${smc4h.breaksOfStructure.length})`
                : 'Macro Trend Aligned',
        };
        // 2. Tier 2: 1h Structural Order Flow
        const smc1h = candles1h.length >= 5 ? smc_analyzer_1.SMCAnalyzer.analyze(candles1h) : null;
        const is1hBull = smc1h
            ? smc1h.marketRegime.regime === shared_1.MarketRegimeType.BULLISH_TREND ||
                smc1h.breaksOfStructure.some((b) => b.direction === 'BULLISH')
            : is4hBull;
        const h1Tier = {
            timeframe: '1h',
            name: '1h Intermediate Structure',
            direction: is1hBull ? 'BULLISH' : 'BEARISH',
            score: smc1h ? 25 : 20,
            keyFactor: smc1h
                ? `1h Dealing Range Equilibrium @ ${smc1h.dealingRange?.equilibrium.toFixed(2) || 'N/A'}`
                : 'Intermediate Flow Aligned',
        };
        // 3. Tier 3: 15m Footprint Confluence
        const smc15m = candles15m.length >= 5 ? smc_analyzer_1.SMCAnalyzer.analyze(candles15m) : null;
        const is15mBull = smc15m
            ? smc15m.marketRegime.regime === shared_1.MarketRegimeType.BULLISH_TREND ||
                smc15m.orderBlocks.some((ob) => ob.direction === 'BULLISH')
            : is1hBull;
        const m15Tier = {
            timeframe: '15m',
            name: '15m SMC Execution Footprint',
            direction: is15mBull ? 'BULLISH' : 'BEARISH',
            score: smc15m ? 25 : 20,
            keyFactor: smc15m
                ? `Active OBs: ${smc15m.orderBlocks.length}, FVGs: ${smc15m.fairValueGaps.length}`
                : '15m Footprint Active',
        };
        // 4. Tier 4: 5m Momentum & Entry Trigger
        const smc5m = candles5m.length >= 5 ? smc_analyzer_1.SMCAnalyzer.analyze(candles5m) : null;
        const is5mBull = smc5m
            ? smc5m.marketRegime.regime === shared_1.MarketRegimeType.BULLISH_TREND
            : is15mBull;
        const m5Tier = {
            timeframe: '5m',
            name: '5m Micro Entry Trigger',
            direction: is5mBull ? 'BULLISH' : 'BEARISH',
            score: smc5m ? 25 : 20,
            keyFactor: smc5m
                ? `5m Micro Momentum is ${smc5m.marketRegime.regime}`
                : 'Micro Trigger Confirmed',
        };
        const bullCount = [is4hBull, is1hBull, is15mBull, is5mBull].filter(Boolean).length;
        const bearCount = 4 - bullCount;
        const isStrongBull = bullCount >= 3;
        const isStrongBear = bearCount >= 3;
        const alignmentScore = Math.max(bullCount, bearCount);
        const totalScore = Math.round((alignmentScore / 4) * 100);
        let tradePermission = 'TRADE_PROHIBITED';
        let overallBias = 'NEUTRAL_MIXED';
        if (bullCount === 4) {
            tradePermission = 'STRONG_BUY_AUTHORIZED';
            overallBias = 'STRONG_BULLISH';
        }
        else if (bearCount === 4) {
            tradePermission = 'STRONG_SELL_AUTHORIZED';
            overallBias = 'STRONG_BEARISH';
        }
        else if (bullCount === 3) {
            tradePermission = 'STRONG_BUY_AUTHORIZED';
            overallBias = 'STRONG_BULLISH';
        }
        else if (bearCount === 3) {
            tradePermission = 'STRONG_SELL_AUTHORIZED';
            overallBias = 'STRONG_BEARISH';
        }
        else {
            tradePermission = 'CAUTION_MIXED_FLOW';
            overallBias = 'NEUTRAL_MIXED';
        }
        const narrative = tradePermission === 'STRONG_BUY_AUTHORIZED'
            ? `🟢 100% Institutional Flow Alignment (${alignmentScore}/4 Tiers). Macro 4h/1h order flow and LTF 15m/5m execution triggers are in synchronized BULLISH harmony.`
            : tradePermission === 'STRONG_SELL_AUTHORIZED'
                ? `🔴 100% Institutional Flow Alignment (${alignmentScore}/4 Tiers). Macro 4h/1h order flow and LTF 15m/5m execution triggers are in synchronized BEARISH harmony.`
                : `⚠️ Mixed Multi-Timeframe Flow (${bullCount} Bullish vs ${bearCount} Bearish). Higher risk of fakeouts. Wait for 1h/15m realignment before entering.`;
        return {
            symbol: symbol.toUpperCase(),
            alignmentScore,
            totalScore,
            overallBias,
            tradePermission,
            tiers: {
                h4: h4Tier,
                h1: h1Tier,
                m15: m15Tier,
                m5: m5Tier,
            },
            narrative,
            timestamp: new Date().toISOString(),
        };
    }
}
exports.MTFFlowRadarEngine = MTFFlowRadarEngine;
//# sourceMappingURL=mtf-flow-radar.js.map