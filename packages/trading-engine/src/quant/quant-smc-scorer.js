"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuantSMCScorer = void 0;
const shared_1 = require("@quant/shared");
class QuantSMCScorer {
    /**
     * Calculates an audited, explainable 10-pillar Quant + SMC confluence score.
     */
    static score(inputs) {
        if (inputs.direction === shared_1.Direction.NEUTRAL) {
            return {
                structureScore: 0,
                mtfScore: 0,
                liquidityScore: 0,
                obScore: 0,
                fvgScore: 0,
                volumeScore: 0,
                momentumScore: 0,
                regimeScore: 0,
                volatilityScore: 0,
                riskRewardScore: 0,
                totalScore: 0,
                grade: shared_1.SignalGrade.NO_TRADE,
                rankingRationale: ['Market is NEUTRAL - no directional trade setup'],
            };
        }
        const isBull = inputs.direction === shared_1.Direction.BULLISH;
        const rankedFactors = [];
        // 1. Structure Score (Max 15)
        let structureScore = 0;
        if (inputs.hasBOS && inputs.hasCHOCH) {
            structureScore = 15;
            rankedFactors.push({
                factor: 'Major Break of Structure (BOS) + Change of Character (CHoCH) Alignment',
                points: 15,
            });
        }
        else if (inputs.hasBOS) {
            structureScore = 12;
            rankedFactors.push({
                factor: 'Confirmed Break of Structure (BOS) in Trend Direction',
                points: 12,
            });
        }
        else if (inputs.hasCHOCH) {
            structureScore = 10;
            rankedFactors.push({ factor: 'Change of Character (CHoCH) Structural Reversal', points: 10 });
        }
        else {
            structureScore = 4;
        }
        // 2. Multi-Timeframe Alignment Score (Max 15)
        let mtfScore = 0;
        if (inputs.mtfAlignment === 'ALIGNED') {
            mtfScore = 15;
            rankedFactors.push({
                factor: 'Complete Multi-Timeframe Order Flow Agreement (Macro + HTF + Exec)',
                points: 15,
            });
        }
        else if (inputs.mtfAlignment === 'PARTIALLY_ALIGNED') {
            mtfScore = Math.round((inputs.mtfConfluenceScore / 100) * 11);
            rankedFactors.push({
                factor: 'Partial Multi-Timeframe Trend Confirmation',
                points: mtfScore,
            });
        }
        else {
            mtfScore = 2;
        }
        // 3. Liquidity Sweep Score (Max 10)
        let liquidityScore = 0;
        if (inputs.hasLiquiditySweep) {
            liquidityScore = 10;
            rankedFactors.push({ factor: 'Clean Key Liquidity Pool Sweep & Mitigation', points: 10 });
        }
        else {
            liquidityScore = 2;
        }
        // 4. Order Block Score (Max 10)
        let obScore = 0;
        if (inputs.hasOrderBlock) {
            const str = inputs.obStrength ? inputs.obStrength / 100 : 0.8;
            obScore = Math.max(5, Math.min(10, Math.round(str * 10)));
            rankedFactors.push({ factor: 'Fresh Institutional Order Block POI Tap', points: obScore });
        }
        // 5. Fair Value Gap Score (Max 10)
        let fvgScore = 0;
        if (inputs.hasFVG) {
            fvgScore = 10;
            rankedFactors.push({ factor: 'Unmitigated Fair Value Gap (FVG) Imbalance Tap', points: 10 });
        }
        // 6. Volume & RVOL Score (Max 10)
        let volumeScore = 0;
        if (inputs.relativeVolume >= 1.8) {
            volumeScore = 10;
            rankedFactors.push({
                factor: `Institutional Surge Volume (${inputs.relativeVolume.toFixed(1)}x RVOL)`,
                points: 10,
            });
        }
        else if (inputs.relativeVolume >= 1.25) {
            volumeScore = 8;
            rankedFactors.push({
                factor: `Above-Average Expansion Volume (${inputs.relativeVolume.toFixed(1)}x RVOL)`,
                points: 8,
            });
        }
        else if (inputs.relativeVolume >= 0.9) {
            volumeScore = 5;
        }
        else {
            volumeScore = 2;
        }
        // 7. Momentum & RSI Score (Max 10)
        let momentumScore = 0;
        const rsi = inputs.rsiValue;
        if (isBull) {
            if (rsi >= 45 && rsi <= 68) {
                momentumScore = 10;
                rankedFactors.push({
                    factor: `Optimal Bullish Momentum RSI (${rsi.toFixed(0)}) with Room to Expand`,
                    points: 10,
                });
            }
            else if (rsi >= 30 && rsi < 45) {
                momentumScore = 7;
                rankedFactors.push({
                    factor: `Oversold Bullish Divergence Zone (RSI ${rsi.toFixed(0)})`,
                    points: 7,
                });
            }
            else {
                momentumScore = 3;
            }
        }
        else {
            if (rsi >= 32 && rsi <= 55) {
                momentumScore = 10;
                rankedFactors.push({
                    factor: `Optimal Bearish Momentum RSI (${rsi.toFixed(0)}) with Downside Expansion`,
                    points: 10,
                });
            }
            else if (rsi > 55 && rsi <= 70) {
                momentumScore = 7;
                rankedFactors.push({
                    factor: `Overbought Bearish Rejection Zone (RSI ${rsi.toFixed(0)})`,
                    points: 7,
                });
            }
            else {
                momentumScore = 3;
            }
        }
        // 8. Market Regime Confluence Score (Max 10)
        let regimeScore = 0;
        if ((isBull && inputs.regime === shared_1.MarketRegimeType.BULLISH_TREND) ||
            (!isBull && inputs.regime === shared_1.MarketRegimeType.BEARISH_TREND)) {
            regimeScore = 10;
            rankedFactors.push({
                factor: `Strong Directional Regime Alignment (${inputs.regime})`,
                points: 10,
            });
        }
        else if (inputs.regime === shared_1.MarketRegimeType.RANGE &&
            inputs.hasLiquiditySweep &&
            inputs.inCorrectEquilibriumZone) {
            regimeScore = 8;
            rankedFactors.push({
                factor: 'Mean-Reversion Range Extreme Liquidity Sweep Confluence',
                points: 8,
            });
        }
        else if (inputs.regime === shared_1.MarketRegimeType.HIGH_VOLATILITY) {
            regimeScore = 4;
        }
        else {
            regimeScore = 5;
        }
        // 9. Volatility Conditions Score (Max 5)
        let volatilityScore = 0;
        if (inputs.volatilityPercentile >= 30 && inputs.volatilityPercentile <= 75) {
            volatilityScore = 5;
            rankedFactors.push({
                factor: `Optimal Volatility Window (${inputs.volatilityPercentile}th Percentile)`,
                points: 5,
            });
        }
        else {
            volatilityScore = 3;
        }
        // 10. Risk/Reward Geometry Score (Max 5)
        let riskRewardScore = 0;
        if (inputs.riskRewardRatio >= 3.0) {
            riskRewardScore = 5;
            rankedFactors.push({
                factor: `Asymmetric Risk/Reward Ratio (${inputs.riskRewardRatio.toFixed(1)}R)`,
                points: 5,
            });
        }
        else if (inputs.riskRewardRatio >= 2.0) {
            riskRewardScore = 4;
            rankedFactors.push({
                factor: `Favorable Risk/Reward Ratio (${inputs.riskRewardRatio.toFixed(1)}R)`,
                points: 4,
            });
        }
        else if (inputs.riskRewardRatio >= 1.5) {
            riskRewardScore = 2;
        }
        else {
            riskRewardScore = 0;
        }
        // Equilibrium zone penalty
        if (!inputs.inCorrectEquilibriumZone) {
            structureScore = Math.max(0, structureScore - 5);
        }
        const totalScore = Math.min(100, structureScore +
            mtfScore +
            liquidityScore +
            obScore +
            fvgScore +
            volumeScore +
            momentumScore +
            regimeScore +
            volatilityScore +
            riskRewardScore);
        let grade = shared_1.SignalGrade.NO_TRADE;
        if (totalScore >= 88)
            grade = shared_1.SignalGrade.A_PLUS;
        else if (totalScore >= 75)
            grade = shared_1.SignalGrade.A;
        else if (totalScore >= 60)
            grade = shared_1.SignalGrade.B;
        else if (totalScore >= 45)
            grade = shared_1.SignalGrade.C;
        else
            grade = shared_1.SignalGrade.NO_TRADE;
        // Sort ranked factors
        rankedFactors.sort((a, b) => b.points - a.points);
        const rankingRationale = rankedFactors.map((f) => `+${f.points} pts: ${f.factor}`);
        return {
            structureScore,
            mtfScore,
            liquidityScore,
            obScore,
            fvgScore,
            volumeScore,
            momentumScore,
            regimeScore,
            volatilityScore,
            riskRewardScore,
            totalScore,
            grade,
            rankingRationale,
        };
    }
}
exports.QuantSMCScorer = QuantSMCScorer;
//# sourceMappingURL=quant-smc-scorer.js.map