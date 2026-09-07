import { ICandle, Timeframe } from '@quant/shared';

export interface IBacktestMarketData {
  executionCandles: ICandle[];
  htf1Candles?: ICandle[];
  htf2Candles?: ICandle[];
  executionTimeframe: string;
  htf1Timeframe?: string;
  htf2Timeframe?: string;
}

export class MarketDataRouter {
  private executionCandles: ICandle[];
  private htf1Candles: ICandle[];
  private htf2Candles: ICandle[];
  private executionTimeframe: string;
  private htf1Timeframe: string;
  private htf2Timeframe: string;

  constructor(data: IBacktestMarketData) {
    this.executionTimeframe = data.executionTimeframe || '15m';
    this.htf1Timeframe = data.htf1Timeframe || '1h';
    this.htf2Timeframe = data.htf2Timeframe || '4h';

    // Normalize and sort candles chronologically
    this.executionCandles = this.normalizeAndSort(data.executionCandles);
    this.htf1Candles = this.normalizeAndSort(data.htf1Candles || []);
    this.htf2Candles = this.normalizeAndSort(data.htf2Candles || []);
  }

  private normalizeAndSort(candles: ICandle[]): ICandle[] {
    if (!candles || candles.length === 0) return [];
    const valid = candles.filter((c) => c && c.timestamp && !isNaN(new Date(c.timestamp).getTime()));
    return [...valid].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  private getDurationMs(tf: string): number {
    const unit = tf.slice(-1).toLowerCase();
    const val = parseInt(tf.slice(0, -1), 10) || 1;
    if (unit === 'm') return val * 60 * 1000;
    if (unit === 'h') return val * 3600 * 1000;
    if (unit === 'd') return val * 86400 * 1000;
    if (unit === 'w') return val * 7 * 86400 * 1000;
    return 15 * 60 * 1000;
  }

  /**
   * Returns market data slice available strictly AT OR BEFORE simulation timestamp T.
   * Higher timeframe candles that close after T are strictly excluded to eliminate lookahead bias.
   */
  getAvailableMarketDataAt(currentExecutionIndex: number): {
    executionSlice: ICandle[];
    htf1Slice: ICandle[];
    htf2Slice: ICandle[];
    currentCandle: ICandle;
    timestamp: number;
  } {
    const currentCandle = this.executionCandles[currentExecutionIndex];
    if (!currentCandle) {
      throw new Error(`Execution candle index ${currentExecutionIndex} out of bounds`);
    }

    const currentExecTime = new Date(currentCandle.timestamp).getTime();
    const execDuration = this.getDurationMs(this.executionTimeframe);
    // The exact close time of the current execution candle
    const currentExecCloseTime = currentExecTime + execDuration;

    const executionSlice = this.executionCandles.slice(0, currentExecutionIndex + 1);

    // HTF1 Filter: A HTF candle is ONLY visible if its close time <= currentExecCloseTime
    const htf1Duration = this.getDurationMs(this.htf1Timeframe);
    const htf1Slice = this.htf1Candles.filter((c) => {
      const openTime = new Date(c.timestamp).getTime();
      const closeTime = openTime + htf1Duration;
      return closeTime <= currentExecCloseTime;
    });

    // HTF2 Filter
    const htf2Duration = this.getDurationMs(this.htf2Timeframe);
    const htf2Slice = this.htf2Candles.filter((c) => {
      const openTime = new Date(c.timestamp).getTime();
      const closeTime = openTime + htf2Duration;
      return closeTime <= currentExecCloseTime;
    });

    return {
      executionSlice,
      htf1Slice,
      htf2Slice,
      currentCandle,
      timestamp: currentExecCloseTime,
    };
  }

  getTotalBars(): number {
    return this.executionCandles.length;
  }

  getExecutionCandles(): ICandle[] {
    return [...this.executionCandles];
  }
}
