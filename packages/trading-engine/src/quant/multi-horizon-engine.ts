import { Direction, ICandle, MarketRegimeType } from '@quant/shared';
import { calculateADX, calculateATR, calculateEMA, calculateRSI } from '@quant/indicators';
import { HorizonState, MultiHorizonQuantState } from './quant-types';
import { RegimeClusteringEngine } from './regime-clustering-engine';

export class MultiHorizonEngine {
  /**
   * Analyzes an individual horizon timeframe.
   */
  public static analyzeHorizon(candles: ICandle[], tfName: string): HorizonState {
    if (!candles || candles.length < 5) {
      return {
        timeframe: tfName,
        trend: Direction.NEUTRAL,
        regime: MarketRegimeType.RANGE,
        volatilityAtr: 0,
        momentumScore: 50,
        structureBroken: false,
      };
    }

    const closes = candles.map((c) => c.close);
    const lastClose = closes[closes.length - 1];

    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const rsi = calculateRSI(closes, 14);
    const atr = calculateATR(candles, 14);

    const lastEma20 = ema20[closes.length - 1] ?? lastClose;
    const lastEma50 = ema50[closes.length - 1] ?? lastClose;
    const lastRsi = rsi[closes.length - 1] ?? 50;
    const lastAtr = atr[candles.length - 1] ?? 0;

    let trend = Direction.NEUTRAL;
    if (lastClose > lastEma20 && lastEma20 >= lastEma50) {
      trend = Direction.BULLISH;
    } else if (lastClose < lastEma20 && lastEma20 <= lastEma50) {
      trend = Direction.BEARISH;
    }

    const regime = RegimeClusteringEngine.classifyRegime(candles).regime;

    // Check recent high/low break
    let structureBroken = false;
    if (candles.length >= 10) {
      const recentHighs = candles.slice(-10, -1).map((c) => c.high);
      const recentLows = candles.slice(-10, -1).map((c) => c.low);
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
  ): MultiHorizonQuantState {
    const execution = this.analyzeHorizon(executionCandles, '15m');
    const higherTimeframe = this.analyzeHorizon(htfCandles || executionCandles, '1h');
    const macro = this.analyzeHorizon(macroCandles || htfCandles || executionCandles, '4h');

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
