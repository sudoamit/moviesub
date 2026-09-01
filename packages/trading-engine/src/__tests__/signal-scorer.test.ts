import { SignalScorer } from '../signal-scorer';
import { Direction, SignalGrade } from '@quant/shared';

describe('SignalScorer', () => {
  it('should score high-confluence setup with Grade A+ (>=85)', () => {
    const { totalScore, grade, breakdown } = SignalScorer.calculateScore({
      direction: Direction.BULLISH,
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
    expect(grade).toBe(SignalGrade.A_PLUS);
    expect(breakdown.htfBias).toBe(20);
    expect(breakdown.liquiditySweep).toBe(15);
  });

  it('should return NO_TRADE for neutral direction or low score', () => {
    const { totalScore, grade } = SignalScorer.calculateScore({
      direction: Direction.NEUTRAL,
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
    expect(grade).toBe(SignalGrade.NO_TRADE);
  });
});
