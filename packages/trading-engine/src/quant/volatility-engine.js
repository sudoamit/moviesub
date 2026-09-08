"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VolatilityEngine = void 0;
const indicators_1 = require("@quant/indicators");
class VolatilityEngine {
    /**
     * Parkinson High-Low Volatility Estimator
     */
    static calculateParkinson(candles, window = 20) {
        if (!candles || candles.length < 2)
            return 0;
        const slice = candles.slice(-window);
        const n = slice.length;
        if (n === 0)
            return 0;
        let sumSqLogHL = 0;
        for (const c of slice) {
            if (c.low > 0 && c.high >= c.low) {
                const logHL = Math.log(c.high / c.low);
                sumSqLogHL += logHL * logHL;
            }
        }
        const factor = 1.0 / (4.0 * Math.LN2 * n);
        const parkinsonVariance = factor * sumSqLogHL;
        return Math.sqrt(Math.max(0, parkinsonVariance));
    }
    /**
     * Garman-Klass OHLC Volatility Estimator (efficient & unbiased)
     */
    static calculateGarmanKlass(candles, window = 20) {
        if (!candles || candles.length < 2)
            return 0;
        const slice = candles.slice(-window);
        const n = slice.length;
        if (n === 0)
            return 0;
        let sum = 0;
        const constTerm = 2 * Math.LN2 - 1; // ≈ 0.38629
        for (const c of slice) {
            if (c.low > 0 && c.high >= c.low && c.open > 0 && c.close > 0) {
                const logHL = Math.log(c.high / c.low);
                const logCO = Math.log(c.close / c.open);
                sum += 0.5 * (logHL * logHL) - constTerm * (logCO * logCO);
            }
        }
        const gkVariance = Math.max(0, sum / n);
        return Math.sqrt(gkVariance);
    }
    /**
     * Rolling Realized Volatility from logarithmic returns
     */
    static calculateRealizedVolatility(closes, window = 30) {
        if (!closes || closes.length < 3)
            return 0;
        const n = closes.length;
        const count = Math.min(window, n - 1);
        const returns = [];
        for (let i = n - count; i < n; i++) {
            if (closes[i - 1] > 0 && closes[i] > 0) {
                returns.push(Math.log(closes[i] / closes[i - 1]));
            }
        }
        if (returns.length < 2)
            return 0;
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (returns.length - 1);
        return Math.sqrt(Math.max(0, variance));
    }
    /**
     * Fits GARCH(1,1) using Variance Targeting on rolling returns.
     * Returns fitted parameters or null if numerical optimization fails.
     */
    static fitGarch11(returns) {
        if (!returns || returns.length < 25)
            return null;
        const n = returns.length;
        const mean = returns.reduce((a, b) => a + b, 0) / n;
        const centered = returns.map((r) => r - mean);
        let sampleVar = 0;
        for (const eps of centered) {
            sampleVar += eps * eps;
        }
        sampleVar /= n;
        if (sampleVar <= 1e-12)
            return null;
        // Grid search for optimal (alpha, beta) using negative log-likelihood with variance targeting
        let bestNLL = Infinity;
        let bestAlpha = 0.08;
        let bestBeta = 0.88;
        const alphaCandidates = [0.03, 0.05, 0.08, 0.1, 0.15, 0.2];
        const betaCandidates = [0.7, 0.8, 0.85, 0.88, 0.9, 0.94];
        for (const alpha of alphaCandidates) {
            for (const beta of betaCandidates) {
                if (alpha + beta >= 0.999)
                    continue;
                const omega = sampleVar * (1.0 - alpha - beta);
                let nll = 0;
                let sigma2 = sampleVar;
                let isValid = true;
                for (let t = 0; t < n; t++) {
                    const eps2 = centered[t] * centered[t];
                    sigma2 = omega + alpha * eps2 + beta * sigma2;
                    if (sigma2 <= 0 || isNaN(sigma2) || !isFinite(sigma2)) {
                        isValid = false;
                        break;
                    }
                    nll += 0.5 * (Math.log(sigma2) + eps2 / sigma2);
                }
                if (isValid && nll < bestNLL) {
                    bestNLL = nll;
                    bestAlpha = alpha;
                    bestBeta = beta;
                }
            }
        }
        if (!isFinite(bestNLL))
            return null;
        const omega = sampleVar * (1.0 - bestAlpha - bestBeta);
        return {
            omega,
            alpha: bestAlpha,
            beta: bestBeta,
            unconditionalVariance: sampleVar,
        };
    }
    /**
     * Forecasts next-period volatility using EWMA baseline (RiskMetrics lambda = 0.94)
     */
    static forecastEwma(returns, lambda = 0.94) {
        if (!returns || returns.length < 2)
            return 0;
        let varEstimate = Math.pow(returns[0], 2);
        for (let t = 1; t < returns.length; t++) {
            varEstimate = lambda * varEstimate + (1.0 - lambda) * Math.pow(returns[t], 2);
        }
        return Math.sqrt(Math.max(0, varEstimate));
    }
    /**
     * Full Volatility Forecast with 3-Tier Graceful Fallback:
     * Tier 1: GARCH(1,1) -> Tier 2: EWMA(0.94) -> Tier 3: Realized Rolling Volatility
     */
    static computeVolatilityState(candles) {
        if (!candles || candles.length < 5) {
            return {
                currentAtr: 0,
                atrPercentage: 0,
                realizedVolatility: 0,
                parkinsonVolatility: 0,
                garmanKlassVolatility: 0,
                forecastVolatility: 0,
                forecastVariance: 0,
                volatilityPercentile: 50,
                volatilityBucket: 'P40',
                modelUsed: 'REALIZED',
                confidence: 50,
            };
        }
        const closes = candles.map((c) => c.close);
        const lastClose = closes[closes.length - 1];
        // 1. ATR calculation
        const atrSeries = (0, indicators_1.calculateATR)(candles, 14);
        const lastAtr = atrSeries[atrSeries.length - 1] ??
            candles[candles.length - 1].high - candles[candles.length - 1].low;
        const atrPercentage = lastClose > 0 ? (lastAtr / lastClose) * 100 : 0;
        // 2. Continuous Estimators
        const parkinson = this.calculateParkinson(candles, 20);
        const garmanKlass = this.calculateGarmanKlass(candles, 20);
        const realized = this.calculateRealizedVolatility(closes, 30);
        // 3. Return series for statistical modeling
        const returns = [];
        for (let i = 1; i < closes.length; i++) {
            if (closes[i - 1] > 0 && closes[i] > 0) {
                returns.push(Math.log(closes[i] / closes[i - 1]));
            }
        }
        let forecastVol = realized;
        let forecastVar = realized * realized;
        let modelUsed = 'REALIZED';
        let confidence = 70;
        // 4. Multi-Tier Modeling
        if (returns.length >= 30) {
            const garch = this.fitGarch11(returns.slice(-60));
            if (garch) {
                const lastReturn = returns[returns.length - 1];
                const lastEps2 = Math.pow(lastReturn, 2);
                forecastVar = garch.omega + garch.alpha * lastEps2 + garch.beta * Math.pow(realized, 2);
                forecastVol = Math.sqrt(Math.max(1e-8, forecastVar));
                modelUsed = 'GARCH';
                confidence = 90;
            }
            else {
                // Fallback 1: EWMA
                forecastVol = this.forecastEwma(returns.slice(-40), 0.94);
                forecastVar = forecastVol * forecastVol;
                modelUsed = 'EWMA';
                confidence = 80;
            }
        }
        else if (returns.length >= 10) {
            forecastVol = this.forecastEwma(returns, 0.94);
            forecastVar = forecastVol * forecastVol;
            modelUsed = 'EWMA';
            confidence = 75;
        }
        // 5. Compute rolling percentile of current volatility against past 50 periods
        const pastVols = [];
        const lookback = Math.min(50, closes.length - 15);
        for (let i = closes.length - lookback; i <= closes.length; i++) {
            const sliceCloses = closes.slice(0, i);
            if (sliceCloses.length >= 10) {
                pastVols.push(this.calculateRealizedVolatility(sliceCloses, 14));
            }
        }
        let percentile = 50;
        if (pastVols.length > 5) {
            const belowCount = pastVols.filter((v) => v <= forecastVol).length;
            percentile = Math.round((belowCount / pastVols.length) * 100);
        }
        // 6. Bucket
        let volatilityBucket = 'P40';
        if (percentile < 20)
            volatilityBucket = 'P20';
        else if (percentile < 40)
            volatilityBucket = 'P40';
        else if (percentile < 60)
            volatilityBucket = 'P60';
        else if (percentile < 80)
            volatilityBucket = 'P80';
        else
            volatilityBucket = 'HIGH';
        return {
            currentAtr: Number(lastAtr.toFixed(4)),
            atrPercentage: Number(atrPercentage.toFixed(3)),
            realizedVolatility: Number(realized.toFixed(6)),
            parkinsonVolatility: Number(parkinson.toFixed(6)),
            garmanKlassVolatility: Number(garmanKlass.toFixed(6)),
            forecastVolatility: Number(forecastVol.toFixed(6)),
            forecastVariance: Number(forecastVar.toFixed(8)),
            volatilityPercentile: percentile,
            volatilityBucket,
            modelUsed,
            confidence,
        };
    }
}
exports.VolatilityEngine = VolatilityEngine;
//# sourceMappingURL=volatility-engine.js.map