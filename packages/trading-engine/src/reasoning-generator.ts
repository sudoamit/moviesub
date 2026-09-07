import { Direction, ISignalReasoning, SignalGrade } from '@quant/shared';
import { ITradeLevels } from './trade-levels';
import { IMTFAnalysisResult } from './mtf-analyzer';
import { IScoringInputs } from './signal-scorer';

export interface IReasoningInputs {
  symbol: string;
  timeframe: string;
  direction: Direction;
  grade: SignalGrade;
  totalScore: number;
  mtf: IMTFAnalysisResult;
  scoring: IScoringInputs;
  levels: ITradeLevels | null;
  triggerDescription: string;
}

export class ReasoningGenerator {
  /**
   * Generates a transparent, deterministic "Why This Trade?" structured explanation
   */
  static generateReasoning(inputs: IReasoningInputs): ISignalReasoning {
    const {
      symbol,
      timeframe,
      direction,
      grade,
      totalScore,
      mtf,
      scoring,
      levels,
      triggerDescription,
    } = inputs;

    if (direction === Direction.NEUTRAL || grade === SignalGrade.NO_TRADE) {
      return {
        htfStructure:
          mtf.reason || 'HTF structure shows mixed signals with no clear directional bias',
        liquidityReason: scoring.hasLiquiditySweep
          ? 'Liquidity sweep observed but lacked institutional confluence'
          : 'No confirmed liquidity sweep detected',
        triggerReason: 'No high-probability trigger met minimum quality threshold',
        invalidationReason: 'Market is in neutral consolidation or conflicting HTF structure',
        confirmedChecklist: ['Conditions insufficient for high-conviction entry'],
        summary: `Setup Score: ${totalScore}/100 (${grade}). Neutral market state on ${symbol} [${timeframe}]. Awaiting confirmed institutional displacement.`,
      };
    }

    const checklist: string[] = [];

    // 1. HTF Structure Reason
    const htfStructure = `Higher timeframe (${mtf.htf1Timeframe}) bias is confirmed ${mtf.htfBias} with ${mtf.alignmentScore}/30 trend confluence. ${mtf.reason}.`;
    if (scoring.htfAligned) checklist.push(`${mtf.htf1Timeframe} ${mtf.htfBias} trend alignment`);

    // 2. Liquidity Reason
    let liquidityReason = '';
    if (direction === Direction.BULLISH) {
      liquidityReason = scoring.hasLiquiditySweep
        ? `Sell-side liquidity (SSL) was swept below recent key swing lows, trapping retail breakout sellers before rapid reversal.`
        : `Price trading inside clean 50% discount zone with unmitigated buy-side liquidity pools (BSL) resting above as targets.`;
    } else {
      liquidityReason = scoring.hasLiquiditySweep
        ? `Buy-side liquidity (BSL) was swept above recent key swing highs, trapping retail breakout buyers before rapid reversal.`
        : `Price trading inside clean 50% premium zone with unmitigated sell-side liquidity pools (SSL) resting below as targets.`;
    }
    if (scoring.hasLiquiditySweep)
      checklist.push(
        direction === Direction.BULLISH
          ? 'SSL swept below swing lows'
          : 'BSL swept above swing highs',
      );

    // 3. Trigger Reason
    const triggerReason = `${triggerDescription}. Displacement intensity measured at ${scoring.displacementRatio.toFixed(2)}x ATR with ${scoring.hasVolumeExpansion ? 'confirmed volume surge' : 'healthy execution volume'}.`;
    if (scoring.hasBOSOrCHOCH) checklist.push(`${timeframe} Execution Structure Break (BOS/CHoCH)`);
    if (scoring.hasOBOrFVG) checklist.push('Institutional Order Block / FVG footprint confluence');
    if (scoring.inCorrectZone)
      checklist.push(
        direction === Direction.BULLISH
          ? 'Favorable 50% Discount entry zone'
          : 'Favorable 50% Premium entry zone',
      );
    if (scoring.indicatorsAligned)
      checklist.push('Momentum & Trend Indicator confluence (EMA/RSI)');

    // 4. Invalidation Reason
    let invalidationReason = 'Invalidation placed beyond structural swing extreme.';
    if (levels) {
      const riskPercent = ((levels.stopLossDistance / levels.entryZone.optimal) * 100).toFixed(2);
      invalidationReason = `Trade invalidation is set at ${levels.stopLoss} (${levels.stopLossDistance} pts / ${riskPercent}% risk) anchored strictly beyond the structural pivot and institutional imbalance floor.`;
      checklist.push(
        `Favorable R:R 1:${levels.riskRewardRatios.rr2.toFixed(1)} to TP2 (${levels.takeProfits.tp2})`,
      );
    }

    // 5. Unified Summary
    const dirText = direction === Direction.BULLISH ? 'LONG' : 'SHORT';
    const summary = `Setup Score: ${totalScore}/100 (Grade ${grade}). High-conviction ${dirText} setup on ${symbol} [${timeframe}] supported by ${mtf.htf1Timeframe} ${mtf.htfBias} trend, ${scoring.hasLiquiditySweep ? 'liquidity sweep' : 'structural alignment'}, and ${triggerDescription}. Target 2 provides 1:${levels?.riskRewardRatios.rr2 || 2.5} R:R.`;

    return {
      htfStructure,
      liquidityReason,
      triggerReason,
      invalidationReason,
      confirmedChecklist: checklist,
      summary,
    };
  }
}
