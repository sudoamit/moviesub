"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuantFeatureEngine = void 0;
const indicators_1 = require("@quant/indicators");
const return_analysis_1 = require("./return-analysis");
const volatility_engine_1 = require("./volatility-engine");
const alternative_data_engine_1 = require("./alternative-data-engine");
class QuantFeatureEngine {
    /**
     * Computes the complete point-in-time QuantState for a symbol and historical candle series.
     */
    static extractQuantState(symbol, candles, smcAnalysis) {
        const closes = candles.map((c) => c.close);
        const n = closes.length;
        const lastCandle = candles[n - 1];
        const currentPrice = lastCandle ? lastCandle.close : 0;
        // 1. Returns
        const returns = return_analysis_1.ReturnAnalysisEngine.calculate(closes);
        // 2. Volatility
        const volatility = volatility_engine_1.VolatilityEngine.computeVolatilityState(candles);
        // 3. Momentum & Indicators
        const rsiSeries = (0, indicators_1.calculateRSI)(closes, 14);
        const rsi14 = rsiSeries[rsiSeries.length - 1] ?? 50;
        const macdSeries = (0, indicators_1.calculateMACD)(closes, 12, 26, 9);
        const lastMacdLine = macdSeries.macd[macdSeries.macd.length - 1] ?? 0;
        const lastMacdSignal = macdSeries.signal[macdSeries.signal.length - 1] ?? 0;
        const lastMacdHist = macdSeries.histogram[macdSeries.histogram.length - 1] ?? 0;
        const roc10 = n > 10 && closes[n - 11] > 0 ? ((currentPrice - closes[n - 11]) / closes[n - 11]) * 100 : 0;
        const vwapSeries = (0, indicators_1.calculateVWAP)(candles);
        const lastVwap = vwapSeries[vwapSeries.length - 1] ?? currentPrice;
        const distanceToVwap = lastVwap > 0 ? ((currentPrice - lastVwap) / lastVwap) * 100 : 0;
        const ema20Series = (0, indicators_1.calculateEMA)(closes, 20);
        const ema50Series = (0, indicators_1.calculateEMA)(closes, 50);
        const ema200Series = (0, indicators_1.calculateEMA)(closes, 200);
        const ema20 = ema20Series[ema20Series.length - 1] ?? currentPrice;
        const ema50 = ema50Series[ema50Series.length - 1] ?? currentPrice;
        const ema200 = ema200Series[ema200Series.length - 1] ?? currentPrice;
        const distanceToEma20 = ema20 > 0 ? ((currentPrice - ema20) / ema20) * 100 : 0;
        const distanceToEma50 = ema50 > 0 ? ((currentPrice - ema50) / ema50) * 100 : 0;
        const distanceToEma200 = ema200 > 0 ? ((currentPrice - ema200) / ema200) * 100 : 0;
        const bb = (0, indicators_1.calculateBollingerBands)(closes, 20, 2);
        const lastUpper = bb.upper[bb.upper.length - 1];
        const lastLower = bb.lower[bb.lower.length - 1];
        const lastMiddle = bb.middle[bb.middle.length - 1];
        const lastWidth = bb.bandwidth[bb.bandwidth.length - 1];
        const lastPercentB = bb.percentB[bb.percentB.length - 1];
        const bollingerPosition = lastPercentB ?? 0.5;
        const bollingerBandwidth = lastWidth ?? 0.05;
        // Volume Z-Score & RVOL
        const volumes = candles.map((c) => c.volume);
        const volWindow = Math.min(30, volumes.length - 1);
        let avgVol = lastCandle ? lastCandle.volume : 1;
        let volStd = 1;
        if (volWindow > 1) {
            const sliceVol = volumes.slice(-volWindow - 1, -1);
            const sumV = sliceVol.reduce((a, b) => a + b, 0);
            avgVol = sumV / sliceVol.length;
            const varV = sliceVol.reduce((a, b) => a + Math.pow(b - avgVol, 2), 0) / (sliceVol.length - 1);
            volStd = Math.sqrt(varV);
        }
        const relativeVolume = avgVol > 0 && lastCandle ? lastCandle.volume / avgVol : 1.0;
        const volumeZScore = volStd > 0 && lastCandle ? (lastCandle.volume - avgVol) / volStd : 0;
        const momentum = {
            rsi14: Number(rsi14.toFixed(2)),
            macdLine: Number(lastMacdLine.toFixed(4)),
            macdSignal: Number(lastMacdSignal.toFixed(4)),
            macdHist: Number(lastMacdHist.toFixed(4)),
            rateOfChange10: Number(roc10.toFixed(3)),
            distanceToVwap: Number(distanceToVwap.toFixed(3)),
            distanceToEma20: Number(distanceToEma20.toFixed(3)),
            distanceToEma50: Number(distanceToEma50.toFixed(3)),
            distanceToEma200: Number(distanceToEma200.toFixed(3)),
            bollingerPosition: Number(bollingerPosition.toFixed(4)),
            bollingerBandwidth: Number(bollingerBandwidth.toFixed(4)),
            relativeVolume: Number(relativeVolume.toFixed(2)),
            volumeZScore: Number(volumeZScore.toFixed(2)),
        };
        // 4. Quantified SMC metrics
        let bosStrength = 0;
        let chochStrength = 0;
        let liquiditySweepDepth = 0;
        let orderBlockStrength = 0;
        let fvgSizeAtrRatio = 0;
        let fvgFillPercentage = 0;
        let displacementRatio = 0;
        let premiumDiscountPosition = 0;
        let distanceToLiquidityPct = 0;
        let distanceToHTFOrderBlockPct = 0;
        if (smcAnalysis) {
            if (smcAnalysis.breaksOfStructure && smcAnalysis.breaksOfStructure.length > 0) {
                const lastBOS = smcAnalysis.breaksOfStructure[smcAnalysis.breaksOfStructure.length - 1];
                bosStrength = typeof lastBOS.strength === 'number' ? lastBOS.strength : 0;
            }
            if (smcAnalysis.changesOfCharacter && smcAnalysis.changesOfCharacter.length > 0) {
                const lastCHOCH = smcAnalysis.changesOfCharacter[smcAnalysis.changesOfCharacter.length - 1];
                chochStrength = typeof lastCHOCH.strength === 'number' ? lastCHOCH.strength : 0;
            }
            if (smcAnalysis.liquiditySweeps && smcAnalysis.liquiditySweeps.length > 0) {
                const lastSweep = smcAnalysis.liquiditySweeps[smcAnalysis.liquiditySweeps.length - 1];
                if (volatility.currentAtr > 0) {
                    liquiditySweepDepth =
                        (lastSweep.displacement ?? volatility.currentAtr) / volatility.currentAtr;
                }
            }
            if (smcAnalysis.orderBlocks && smcAnalysis.orderBlocks.length > 0) {
                const lastOB = smcAnalysis.orderBlocks[smcAnalysis.orderBlocks.length - 1];
                orderBlockStrength = typeof lastOB.strength === 'number' ? lastOB.strength : 0;
                if (currentPrice > 0) {
                    distanceToHTFOrderBlockPct =
                        (Math.abs(currentPrice - (lastOB.high + lastOB.low) / 2) / currentPrice) * 100;
                }
            }
            if (smcAnalysis.fairValueGaps && smcAnalysis.fairValueGaps.length > 0) {
                const lastFVG = smcAnalysis.fairValueGaps[smcAnalysis.fairValueGaps.length - 1];
                const gapWidth = Math.abs(lastFVG.upperBound - lastFVG.lowerBound);
                if (volatility.currentAtr > 0) {
                    fvgSizeAtrRatio = gapWidth / volatility.currentAtr;
                }
                fvgFillPercentage = lastFVG.fillPercentage ?? 0;
            }
            if (smcAnalysis.dealingRange) {
                const dr = smcAnalysis.dealingRange;
                if (dr.high > dr.low) {
                    premiumDiscountPosition = Math.max(0, Math.min(1, (currentPrice - dr.low) / (dr.high - dr.low)));
                }
            }
            if (smcAnalysis.liquidityPools && smcAnalysis.liquidityPools.length > 0) {
                const nearestPool = smcAnalysis.liquidityPools[0];
                if (currentPrice > 0) {
                    distanceToLiquidityPct =
                        (Math.abs(currentPrice - nearestPool.priceLevel) / currentPrice) * 100;
                }
            }
        }
        if (lastCandle) {
            const body = Math.abs(lastCandle.close - lastCandle.open);
            const range = Math.max(0.0001, lastCandle.high - lastCandle.low);
            displacementRatio = body / range;
        }
        const smcQuant = {
            bosStrength: Number(bosStrength.toFixed(2)),
            chochStrength: Number(chochStrength.toFixed(2)),
            liquiditySweepDepth: Number(liquiditySweepDepth.toFixed(3)),
            orderBlockStrength: Number(orderBlockStrength.toFixed(2)),
            fvgSizeAtrRatio: Number(fvgSizeAtrRatio.toFixed(3)),
            fvgFillPercentage: Number(fvgFillPercentage.toFixed(2)),
            displacementRatio: Number(displacementRatio.toFixed(3)),
            premiumDiscountPosition: Number(premiumDiscountPosition.toFixed(4)),
            distanceToLiquidityPct: Number(distanceToLiquidityPct.toFixed(3)),
            distanceToHTFOrderBlockPct: Number(distanceToHTFOrderBlockPct.toFixed(3)),
        };
        // 5. Alternative data
        const evalTime = lastCandle ? new Date(lastCandle.timestamp) : new Date(0);
        const alternativeData = alternative_data_engine_1.AlternativeDataEngine.getData(symbol, evalTime);
        return {
            returns,
            volatility,
            momentum,
            smcQuant,
            alternativeData,
            extractedAt: evalTime,
        };
    }
}
exports.QuantFeatureEngine = QuantFeatureEngine;
//# sourceMappingURL=quant-feature-engine.js.map