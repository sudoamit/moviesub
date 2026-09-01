import { Direction, IScoreBreakdown, SignalGrade } from '@quant/shared';

export interface IScoringInputs {
  direction: Direction;
  htfAligned: boolean;
  htfAlignmentScore: number;
  hasLiquiditySweep: boolean;
  hasBOSOrCHOCH: boolean;
  hasOBOrFVG: boolean;
  displacementRatio: number;
  inCorrectZone: boolean; // in Discount for LONG, in Premium for SHORT
  hasVolumeExpansion: boolean;
  riskRewardRatio: number;
  indicatorsAligned: boolean;
}

export class SignalScorer {
  /**
   * Deterministically calculates 0-100 setup score and confidence grade.
   * Strictly NO LLM / AI hallucination used.
   */
  static calculateScore(inputs: IScoringInputs): {
    totalScore: number;
    grade: SignalGrade;
    breakdown: IScoreBreakdown;
  } {
    if (inputs.direction === Direction.NEUTRAL) {
      return {
        totalScore: 0,
        grade: SignalGrade.NO_TRADE,
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
          grade: SignalGrade.NO_TRADE,
        },
      };
    }

    // 1. HTF Trend Alignment (20 points max)
    const htfScore = inputs.htfAligned ? (inputs.htfAlignmentScore >= 20 ? 20 : 15) : 0;

    // 2. Liquidity Sweep (15 points max)
    const sweepScore = inputs.hasLiquiditySweep ? 15 : 0;

    // 3. Break of Structure / CHoCH (15 points max)
    const structureScore = inputs.hasBOSOrCHOCH ? 15 : 0;

    // 4. Order Block / FVG Confluence (15 points max)
    const obScore = inputs.hasOBOrFVG ? 8 : 0;
    const fvgScore = inputs.hasOBOrFVG ? 7 : 0;

    // 5. Displacement Quality (10 points max)
    const displacementScore = inputs.displacementRatio >= 1.5 ? 10 : (inputs.displacementRatio >= 1.0 ? 6 : 0);

    // 6. Premium / Discount Zone (10 points max)
    const zoneScore = inputs.inCorrectZone ? 10 : 0;

    // 7. Volume Confirmation (5 points max)
    const volumeScore = inputs.hasVolumeExpansion ? 5 : 0;

    // 8. Risk-to-Reward >= 2.0 (5 points max)
    const rrScore = inputs.riskRewardRatio >= 2.0 ? 5 : (inputs.riskRewardRatio >= 1.5 ? 3 : 0);

    // 9. Indicator Alignment (5 points max)
    const indicatorScore = inputs.indicatorsAligned ? 5 : 0;

    const total =
      htfScore +
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

    let grade: SignalGrade = SignalGrade.NO_TRADE;
    if (totalScore >= 85) {
      grade = SignalGrade.A_PLUS;
    } else if (totalScore >= 75) {
      grade = SignalGrade.A;
    } else if (totalScore >= 65) {
      grade = SignalGrade.B;
    } else if (totalScore >= 55) {
      grade = SignalGrade.C;
    } else {
      grade = SignalGrade.NO_TRADE;
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
    };
  }
}
