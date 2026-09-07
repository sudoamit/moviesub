import { Direction, ICandle, MTFMode, Timeframe } from '@quant/shared';
import { SMCAnalyzer } from './smc-analyzer';
import { ISMCAnalysisResult } from './types';
import { CandleNormalizer } from './candle-normalizer';

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
  public static getTimeframeDurationMs(tf: Timeframe | string): number {
    const s = String(tf).toLowerCase().trim();
    if (s === '1m') return 60 * 1000;
    if (s === '3m') return 3 * 60 * 1000;
    if (s === '5m') return 5 * 60 * 1000;
    if (s === '15m') return 15 * 60 * 1000;
    if (s === '30m') return 30 * 60 * 1000;
    if (s === '1h' || s === '60m') return 60 * 60 * 1000;
    if (s === '2h') return 2 * 60 * 60 * 1000;
    if (s === '4h') return 4 * 60 * 60 * 1000;
    if (s === '1d' || s === 'd') return 24 * 60 * 60 * 1000;
    if (s === '1w' || s === 'w') return 7 * 24 * 60 * 60 * 1000;

    const unit = s.slice(-1);
    const val = parseInt(s.slice(0, -1), 10) || 1;
    if (unit === 'm') return val * 60 * 1000;
    if (unit === 'h') return val * 3600 * 1000;
    if (unit === 'd') return val * 86400 * 1000;
    if (unit === 'w') return val * 7 * 86400 * 1000;
    return 15 * 60 * 1000;
  }

  /**
   * Filters HTF candles strictly to only those whose close time is <= maxAllowedCloseTime.
   * Eliminates look-ahead bias across all multi-timeframe analysis.
   */
  public static filterClosedHTFCandles(
    htfCandles: ICandle[],
    htfTimeframe: Timeframe | string,
    maxAllowedCloseTime: number,
  ): ICandle[] {
    if (!htfCandles || htfCandles.length === 0) return [];
    const duration = MultiTimeframeAnalyzer.getTimeframeDurationMs(htfTimeframe);

    return htfCandles.filter((c) => {
      const candleTime = new Date(c.timestamp).getTime();
      const closeTime = candleTime + duration;
      return closeTime <= maxAllowedCloseTime && c.isClosed !== false;
    });
  }

  /**
   * Analyzes Higher Timeframe (HTF) market structure to establish directional bias for lower timeframe execution
   * with guaranteed zero look-ahead bias.
   */
  static analyzeMTF(
    executionTf: IMTFTimeframeData,
    htf1: IMTFTimeframeData,
    htf2?: IMTFTimeframeData,
    mode: MTFMode = MTFMode.BALANCED,
    asOfTimestamp?: Date,
  ): IMTFAnalysisResult {
    let execCandles = CandleNormalizer.normalize(executionTf.candles);
    const execDuration = MultiTimeframeAnalyzer.getTimeframeDurationMs(executionTf.timeframe);

    let maxCloseTime: number;
    if (asOfTimestamp) {
      maxCloseTime = asOfTimestamp.getTime();
      execCandles = CandleNormalizer.getClosedCandlesAsOf(execCandles, executionTf.timeframe, asOfTimestamp);
    } else {
      const lastExecCandle = execCandles[execCandles.length - 1];
      maxCloseTime = lastExecCandle
        ? new Date(lastExecCandle.timestamp).getTime() + execDuration
        : Date.now();
    }

    const resolveTrendFromAnalysis = (
      candles: ICandle[],
      timeframe: Timeframe | string,
      analysis?: ISMCAnalysisResult,
    ): Direction => {
      if (candles && candles.length > 0) {
        const cleanCandles = MultiTimeframeAnalyzer.filterClosedHTFCandles(
          CandleNormalizer.normalize(candles),
          timeframe,
          maxCloseTime,
        );
        const resolved = SMCAnalyzer.analyze(cleanCandles, {
          asOfTimestamp: asOfTimestamp || new Date(maxCloseTime),
        });

        if (resolved.currentTrend !== Direction.NEUTRAL) {
          return resolved.currentTrend;
        }
        if (resolved.marketRegime?.regime === 'BULLISH_TREND') return Direction.BULLISH;
        if (resolved.marketRegime?.regime === 'BEARISH_TREND') return Direction.BEARISH;
      }

      if (analysis) {
        if (analysis.currentTrend !== Direction.NEUTRAL) return analysis.currentTrend;
        if (analysis.marketRegime?.regime === 'BULLISH_TREND') return Direction.BULLISH;
        if (analysis.marketRegime?.regime === 'BEARISH_TREND') return Direction.BEARISH;
      }

      return Direction.NEUTRAL;
    };

    const htf1Trend = resolveTrendFromAnalysis(htf1.candles, htf1.timeframe, htf1.analysis);

    let htf2Trend: Direction | undefined = undefined;
    if (htf2) {
      htf2Trend = resolveTrendFromAnalysis(htf2.candles, htf2.timeframe, htf2.analysis);
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

