import { Direction, ICandle, MarketRegimeType } from '@quant/shared';
import { calculateADX, calculateATR, calculateEMA, calculateRSI } from '@quant/indicators';
import { HorizonState, MultiHorizonQuantState } from './quant-types';
import { RegimeClusteringEngine } from './regime-clustering-engine';

export class MultiHorizonEngine {
  /**
   * Filters a horizon candle set down to only closed candles whose close time is <= asOfTimestamp.
   */
  public static getClosedCandlesAsOf(
    candles: ICandle[],
    timeframe: string,
    asOfTimestamp?: Date,
  ): ICandle[] {
    const normalized = candles || [];
    if (!asOfTimestamp) {
      return normalized.filter((c) => c.isClosed !== false);
    }

    const durationMs = (() => {
      const tf = timeframe.toLowerCase();
      if (tf.includes('1m')) return 60 * 1000;
      if (tf.includes('5m')) return 5 * 60 * 1000;
      if (tf.includes('15m')) return 15 * 60 * 1000;
      if (tf.includes('30m')) return 30 * 60 * 1000;
      if (tf.includes('1h') || tf.includes('60m')) return 60 * 60 * 1000;
      if (tf.includes('4h')) return 4 * 60 * 60 * 1000;
      if (tf.includes('1d') || tf.includes('d')) return 24 * 60 * 60 * 1000;
      if (tf.includes('1w') || tf.includes('w')) return 7 * 24 * 60 * 60 * 1000;
      return 15 * 60 * 1000;
    })();

    const asOfTime = asOfTimestamp.getTime();
    return normalized.filter((c) => {
      const candleTime = new Date(c.timestamp).getTime();
      const closeTime = candleTime + durationMs;
      return c.isClosed !== false && closeTime <= asOfTime;
    });
  }

  /**
   * Analyzes an individual horizon timeframe.
   */
  public static analyzeHorizon(
    candles: ICandle[],
    tfName: string,
    asOfTimestamp?: Date,
  ): HorizonState {
    const closedCandles = this.getClosedCandlesAsOf(candles || [], tfName, asOfTimestamp);
    if (!closedCandles || closedCandles.length < 5) {
      return {
        timeframe: tfName,
        trend: Direction.NEUTRAL,
        regime: MarketRegimeType.RANGE,
        volatilityAtr: 0,
        momentumScore: 50,
        structureBroken: false,
      };
    }

    const closes = closedCandles.map((c) => c.close);
    const lastClose = closes[closes.length - 1];

    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const rsi = calculateRSI(closes, 14);
    const atr = calculateATR(closedCandles, 14);

    const lastEma20 = ema20[closes.length - 1] ?? lastClose;
    const lastEma50 = ema50[closes.length - 1] ?? lastClose;
    const lastRsi = rsi[closes.length - 1] ?? 50;
    const lastAtr = atr[closedCandles.length - 1] ?? 0;

    let trend = Direction.NEUTRAL;
    if (lastClose > lastEma20 && lastEma20 >= lastEma50) {
      trend = Direction.BULLISH;
    } else if (lastClose < lastEma20 && lastEma20 <= lastEma50) {
      trend = Direction.BEARISH;
    }

    const regime = RegimeClusteringEngine.classifyRegime(closedCandles).regime;

    // Check recent high/low break
    let structureBroken = false;
    if (closedCandles.length >= 10) {
      const recentHighs = closedCandles.slice(-10, -1).map((c) => c.high);
      const recentLows = closedCandles.slice(-10, -1).map((c) => c.low);
      const maxHigh = Math.max(...recentHighs);
      const minLow = Math.min(...recentLows);
      if (lastClose > maxHigh || lastClose < minLow) {
        structureBroken = true;
      }
    }

    return {
      timeframe: tfName,
      trend,
      regime,
      volatilityAtr: Number(lastAtr.toFixed(2)),
      momentumScore: Math.round(lastRsi),
      structureBroken,
    };
  }

  /**
   * Compiles multi-horizon alignment across Macro, HTF, and Execution.
   */
  public static evaluateMultiHorizon(
    executionCandles: ICandle[],
    htfCandles?: ICandle[],
    macroCandles?: ICandle[],
    options: { asOfTimestamp?: Date; executionTimeframe?: string; htfTimeframe?: string; macroTimeframe?: string } = {},
  ): MultiHorizonQuantState {
    const executionTf = options.executionTimeframe || '15m';
    const htfTf = options.htfTimeframe || '1h';
    const macroTf = options.macroTimeframe || '4h';
    const asOfTimestamp = options.asOfTimestamp;

    const execution = this.analyzeHorizon(executionCandles, executionTf, asOfTimestamp);
    const higherTimeframe = this.analyzeHorizon(htfCandles || executionCandles, htfTf, asOfTimestamp);
    const macro = this.analyzeHorizon(macroCandles || htfCandles || executionCandles, macroTf, asOfTimestamp);

    const trends = [execution.trend, higherTimeframe.trend, macro.trend].filter(
      (t) => t !== Direction.NEUTRAL,
    );

    const bullCount = trends.filter((t) => t === Direction.BULLISH).length;
    const bearCount = trends.filter((t) => t === Direction.BEARISH).length;

    let alignment: 'ALIGNED' | 'PARTIALLY_ALIGNED' | 'CONFLICTED' = 'PARTIALLY_ALIGNED';
    let confluenceScore = 50;

    if (bullCount === 3 || bearCount === 3) {
      alignment = 'ALIGNED';
      confluenceScore = 95;
    } else if (bullCount >= 2 || bearCount >= 2) {
      if (
        execution.trend !== Direction.NEUTRAL &&
        higherTimeframe.trend !== Direction.NEUTRAL &&
        execution.trend !== higherTimeframe.trend
      ) {
        alignment = 'CONFLICTED';
        confluenceScore = 30;
      } else {
        alignment = 'PARTIALLY_ALIGNED';
        confluenceScore = 75;
      }
    } else {
      alignment = 'PARTIALLY_ALIGNED';
      confluenceScore = 50;
    }

    return {
      macro,
      higherTimeframe,
      execution,
      alignment,
      confluenceScore,
    };
  }
}
