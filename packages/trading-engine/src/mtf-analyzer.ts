import { Direction, ICandle, MTFMode, Timeframe } from '@quant/shared';
import { SMCAnalyzer } from './smc-analyzer';
import { ISMCAnalysisResult } from './types';

export interface IMTFTimeframeData {
  timeframe: Timeframe | string;
  candles: ICandle[];
  analysis?: ISMCAnalysisResult;
}

export interface IMTFAnalysisResult {
  executionTimeframe: Timeframe | string;
  htfBias: Direction;
  htf1Timeframe: Timeframe | string;
  htf1Trend: Direction;
  htf2Timeframe?: Timeframe | string;
  htf2Trend?: Direction;
  isAligned: boolean;
  alignmentScore: number;
  reason: string;
}

export class MultiTimeframeAnalyzer {
  /**
   * Analyzes Higher Timeframe (HTF) market structure to establish directional bias for lower timeframe execution
   */
  static analyzeMTF(
    executionTf: IMTFTimeframeData,
    htf1: IMTFTimeframeData,
    htf2?: IMTFTimeframeData,
    mode: MTFMode = MTFMode.BALANCED,
  ): IMTFAnalysisResult {
    const htf1Analysis = htf1.analysis || SMCAnalyzer.analyze(htf1.candles);
    const htf1Trend = htf1Analysis.currentTrend !== Direction.NEUTRAL
      ? htf1Analysis.currentTrend
      : (htf1Analysis.marketRegime.regime === 'BULLISH_TREND' ? Direction.BULLISH : (htf1Analysis.marketRegime.regime === 'BEARISH_TREND' ? Direction.BEARISH : Direction.NEUTRAL));

    let htf2Trend: Direction | undefined = undefined;
    if (htf2 && htf2.candles.length > 0) {
      const htf2Analysis = htf2.analysis || SMCAnalyzer.analyze(htf2.candles);
      htf2Trend = htf2Analysis.currentTrend !== Direction.NEUTRAL
        ? htf2Analysis.currentTrend
        : (htf2Analysis.marketRegime.regime === 'BULLISH_TREND' ? Direction.BULLISH : (htf2Analysis.marketRegime.regime === 'BEARISH_TREND' ? Direction.BEARISH : Direction.NEUTRAL));
    }

    // Determine overall HTF bias
    let htfBias: Direction = Direction.NEUTRAL;
    let alignmentScore = 0;
    let isAligned = false;
    let reason = '';

    if (htf2Trend && htf2) {
      if (htf1Trend === htf2Trend && htf1Trend !== Direction.NEUTRAL) {
        htfBias = htf1Trend;
        alignmentScore = 20;
        isAligned = true;
        reason = `Strong HTF alignment: Both ${htf1.timeframe} and ${htf2.timeframe} are strictly ${htf1Trend}`;
      } else if (htf1Trend !== Direction.NEUTRAL) {
        if (mode === MTFMode.AGGRESSIVE) {
          htfBias = htf1Trend;
          alignmentScore = 15;
          isAligned = true;
          reason = `Aggressive mode: Following intermediate HTF (${htf1.timeframe} is ${htf1Trend}) while ${htf2.timeframe} is ${htf2Trend}`;
        } else {
          htfBias = htf1Trend;
          alignmentScore = 10;
          isAligned = mode === MTFMode.BALANCED;
          reason = `Moderate alignment: ${htf1.timeframe} is ${htf1Trend}, while ${htf2.timeframe} is ${htf2Trend}`;
        }
      } else {
        htfBias = htf2Trend;
        alignmentScore = 10;
        isAligned = mode !== MTFMode.STRICT;
        reason = `Intermediate HTF (${htf1.timeframe}) is neutral; using macro ${htf2.timeframe} ${htf2Trend}`;
      }
    } else {
      htfBias = htf1Trend;
      alignmentScore = htf1Trend !== Direction.NEUTRAL ? 20 : 0;
      isAligned = htf1Trend !== Direction.NEUTRAL;
      reason = `Single HTF reference (${htf1.timeframe}) is ${htf1Trend}`;
    }

    return {
      executionTimeframe: executionTf.timeframe,
      htfBias,
      htf1Timeframe: htf1.timeframe,
      htf1Trend,
      htf2Timeframe: htf2?.timeframe,
      htf2Trend,
      isAligned,
      alignmentScore,
      reason,
    };
  }
}
