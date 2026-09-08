"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignalScorer = void 0;
const shared_1 = require("@quant/shared");
class SignalScorer {
    /**
     * Deterministically calculates 0-100 setup score and confidence grade with decoupled
     * Order Block, FVG, Liquidity, and Structural Quality components.
     */
    static calculateScore(inputs) {
        if (inputs.direction === shared_1.Direction.NEUTRAL) {
            return {
                totalScore: 0,
                grade: shared_1.SignalGrade.NO_TRADE,
                breakdown: {
                    htfBias: 0,
                    liquiditySweep: 0,
                    bos: 0,
                    fvg: 0,
                    orderBlock: 0,
                    displacement: 0,
                    volumeConfirmation: 0,
                    premiumDiscount: 0,
                    riskReward: 0,
                    indicatorAlignment: 0,
                    totalScore: 0,
                    grade: shared_1.SignalGrade.NO_TRADE,
                },
            };
        }
        const components = {};
        // 1. HTF Trend Alignment (20 points max)
        const htfScore = inputs.htfAligned ? (inputs.htfAlignmentScore >= 20 ? 20 : 15) : 0;
        components.htfAlignment = {
            score: htfScore,
            confidence: inputs.htfAligned ? (inputs.htfAlignmentScore >= 20 ? 1.0 : 0.75) : 0,
            evidence: `HTF Trend Bias Score: ${inputs.htfAlignmentScore}/20`,
            reason: inputs.htfAligned
                ? 'Execution direction matches Higher Timeframe structural flow'
                : 'HTF structural conflict',
        };
        // 2. Liquidity Sweep (15 points max)
        const liqQuality = inputs.liquidityQuality ?? (inputs.hasLiquiditySweep ? 1.0 : 0);
        const sweepScore = inputs.hasLiquiditySweep ? Math.round(15 * Math.max(0.5, liqQuality)) : 0;
        components.liquiditySweep = {
            score: sweepScore,
            confidence: liqQuality,
            evidence: inputs.hasLiquiditySweep
                ? `Liquidity pool swept with quality ${(liqQuality * 100).toFixed(0)}%`
                : 'No sweep detected',
            reason: inputs.hasLiquiditySweep
                ? 'Institutional liquidity grab prior to reversal'
                : 'Absence of stop run',
        };
        // 3. Break of Structure / CHoCH (15 points max)
        const hasStructure = Boolean(inputs.hasBOS || inputs.hasCHOCH || inputs.hasBOSOrCHOCH);
        const structureScore = hasStructure ? 15 : 0;
        components.structureBreak = {
            score: structureScore,
            confidence: hasStructure ? 1.0 : 0,
            evidence: inputs.hasCHOCH
                ? 'Change of Character (CHoCH) confirmed'
                : inputs.hasBOS
                    ? 'Break of Structure (BOS) confirmed'
                    : hasStructure
                        ? 'Market Structure Break'
                        : 'No structure shift',
            reason: hasStructure
                ? 'Valid structural break confirming order flow continuation'
                : 'No confirmed trend change',
        };
        // 4. Order Block Quality (8 points max) - DECOUPLED FROM FVG
        const hasOB = inputs.hasOrderBlock !== undefined ? inputs.hasOrderBlock : (inputs.hasOBOrFVG ?? false);
        const obQuality = inputs.orderBlockQuality ?? (hasOB ? 1.0 : 0);
        const obScore = hasOB ? Math.min(8, Math.round(8 * Math.max(0.5, obQuality))) : 0;
        components.orderBlock = {
            score: obScore,
            confidence: obQuality,
            evidence: hasOB
                ? `Order Block mitigation detected (quality: ${(obQuality * 100).toFixed(0)}%)`
                : 'No order block present',
            reason: hasOB
                ? 'Valid institutional supply/demand order block tap'
                : 'Missing order block POI',
        };
        // 5. FVG Quality (7 points max) - DECOUPLED FROM OB
        const hasFVG = inputs.hasFVG !== undefined ? inputs.hasFVG : (inputs.hasOBOrFVG ?? false);
        const fvgQuality = inputs.fvgQuality ?? (hasFVG ? 1.0 : 0);
        const fvgScore = hasFVG ? Math.min(7, Math.round(7 * Math.max(0.5, fvgQuality))) : 0;
        components.fairValueGap = {
            score: fvgScore,
            confidence: fvgQuality,
            evidence: hasFVG
                ? `Imbalance FVG mitigation (quality: ${(fvgQuality * 100).toFixed(0)}%)`
                : 'No Fair Value Gap present',
            reason: hasFVG ? 'Mitigation of price imbalance / liquidity void' : 'No active FVG zone',
        };
        // 6. Displacement Quality (10 points max)
        const dispRatio = inputs.displacementRatio || 0;
        const displacementScore = dispRatio >= 1.5 ? 10 : dispRatio >= 1.0 ? 6 : dispRatio >= 0.7 ? 3 : 0;
        components.displacement = {
            score: displacementScore,
            confidence: Math.min(1.0, dispRatio / 1.5),
            evidence: `Displacement expansion ratio: ${dispRatio.toFixed(2)}x ATR`,
            reason: dispRatio >= 1.0
                ? 'Strong institutional displacement momentum'
                : 'Weak or indecisive candle bodies',
        };
        // 7. Premium / Discount Zone (10 points max)
        const zoneScore = inputs.inCorrectZone ? 10 : 0;
        components.dealingRange = {
            score: zoneScore,
            confidence: inputs.inCorrectZone ? 1.0 : 0,
            evidence: inputs.inCorrectZone
                ? 'Optimal pricing in discount (Long) or premium (Short)'
                : 'Suboptimal dealing range pricing',
            reason: inputs.inCorrectZone
                ? 'Institutional pricing advantage'
                : 'Trading into opposing premium/discount equilibrium',
        };
        // 8. Volume Confirmation (5 points max)
        const volumeScore = inputs.hasVolumeExpansion ? 5 : 0;
        components.volumeExpansion = {
            score: volumeScore,
            confidence: inputs.hasVolumeExpansion ? 1.0 : 0.3,
            evidence: inputs.hasVolumeExpansion
                ? 'Volume surge above 20-period moving average'
                : 'Normal or declining volume',
            reason: inputs.hasVolumeExpansion ? 'Participation confirmation' : 'Low volume backdrop',
        };
        // 9. Risk-to-Reward >= 2.0 (5 points max)
        const rr = inputs.riskRewardRatio || 0;
        const rrScore = rr >= 2.0 ? 5 : rr >= 1.5 ? 3 : 0;
        components.riskReward = {
            score: rrScore,
            confidence: Math.min(1.0, rr / 2.0),
            evidence: `Setup Risk-to-Reward ratio: ${rr.toFixed(2)}R`,
            reason: rr >= 2.0 ? 'Favorable asymmetric payoff' : 'Substandard risk-reward profile',
        };
        // 10. Indicator Alignment (5 points max)
        const indicatorScore = inputs.indicatorsAligned ? 5 : 0;
        components.indicatorAlignment = {
            score: indicatorScore,
            confidence: inputs.indicatorsAligned ? 1.0 : 0,
            evidence: inputs.indicatorsAligned
                ? 'Momentum and volatility indicators in confluence'
                : 'Indicator divergence',
            reason: inputs.indicatorsAligned ? 'Multi-oscillator confirmation' : 'Oscillator conflict',
        };
        const total = htfScore +
            sweepScore +
            structureScore +
            obScore +
            fvgScore +
            displacementScore +
            zoneScore +
            volumeScore +
            rrScore +
            indicatorScore;
        const totalScore = Math.min(100, Math.max(0, total));
        let grade = shared_1.SignalGrade.NO_TRADE;
        if (totalScore >= 85) {
            grade = shared_1.SignalGrade.A_PLUS;
        }
        else if (totalScore >= 75) {
            grade = shared_1.SignalGrade.A;
        }
        else if (totalScore >= 65) {
            grade = shared_1.SignalGrade.B;
        }
        else if (totalScore >= 55) {
            grade = shared_1.SignalGrade.C;
        }
        else {
            grade = shared_1.SignalGrade.NO_TRADE;
        }
        return {
            totalScore,
            grade,
            breakdown: {
                htfBias: htfScore,
                liquiditySweep: sweepScore,
                bos: structureScore,
                fvg: fvgScore,
                orderBlock: obScore,
                displacement: displacementScore,
                premiumDiscount: zoneScore,
                volumeConfirmation: volumeScore,
                riskReward: rrScore,
                indicatorAlignment: indicatorScore,
                totalScore,
                grade,
            },
            components,
        };
    }
}
exports.SignalScorer = SignalScorer;
//# sourceMappingURL=signal-scorer.js.map