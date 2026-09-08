"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const signal_scorer_1 = require("../signal-scorer");
const shared_1 = require("@quant/shared");
describe('SignalScorer', () => {
    it('should score high-confluence setup with Grade A+ (>=85)', () => {
        const { totalScore, grade, breakdown } = signal_scorer_1.SignalScorer.calculateScore({
            direction: shared_1.Direction.BULLISH,
            htfAligned: true,
            htfAlignmentScore: 20,
            hasLiquiditySweep: true,
            hasBOSOrCHOCH: true,
            hasOBOrFVG: true,
            displacementRatio: 1.6,
            inCorrectZone: true,
            hasVolumeExpansion: true,
            riskRewardRatio: 2.5,
            indicatorsAligned: true,
        });
        expect(totalScore).toBeGreaterThanOrEqual(85);
        expect(grade).toBe(shared_1.SignalGrade.A_PLUS);
        expect(breakdown.htfBias).toBe(20);
        expect(breakdown.liquiditySweep).toBe(15);
    });
    it('should return NO_TRADE for neutral direction or low score', () => {
        const { totalScore, grade } = signal_scorer_1.SignalScorer.calculateScore({
            direction: shared_1.Direction.NEUTRAL,
            htfAligned: false,
            htfAlignmentScore: 0,
            hasLiquiditySweep: false,
            hasBOSOrCHOCH: false,
            hasOBOrFVG: false,
            displacementRatio: 0.5,
            inCorrectZone: false,
            hasVolumeExpansion: false,
            riskRewardRatio: 1.0,
            indicatorsAligned: false,
        });
        expect(totalScore).toBe(0);
        expect(grade).toBe(shared_1.SignalGrade.NO_TRADE);
    });
});
//# sourceMappingURL=signal-scorer.test.js.map