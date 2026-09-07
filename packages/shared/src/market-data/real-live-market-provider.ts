import { ICandle, IMarketDataProvider } from '../interfaces';
import { Timeframe } from '../enums';
import { CandleValidator } from './candle-validator';

export class RealLiveMarketDataProvider implements IMarketDataProvider {
  public readonly providerName = 'RealLiveMarketDataProvider';

  private static readonly SYMBOL_MAP: Record<string, string> = {
    NIFTY: '^NSEI',
    BANKNIFTY: '^NSEBANK',
    RELIANCE: 'RELIANCE.NS',
    HDFCBANK: 'HDFCBANK.NS',
    INFY: 'INFY.NS',
  };

  /**
   * Fetches real historical candles directly from Yahoo Finance and Binance public APIs
   */
  async getHistoricalCandles(
    symbol: string,
    timeframe: Timeframe | string,
    limit = 100,
    endTime: Date = new Date(),
  ): Promise<ICandle[]> {
    const sym = symbol.toUpperCase();

    if (sym === 'BTCUSDT') {
      return this.fetchBinanceCandles(timeframe, limit);
    }

    return this.fetchYahooCandles(sym, timeframe, limit);
  }

  async getLatestCandle(symbol: string, timeframe: Timeframe | string): Promise<ICandle> {
    const candles = await this.getHistoricalCandles(symbol, timeframe, 5);
    return candles[candles.length - 1];
  }

  async subscribeToMarketData(
    symbol: string,
    timeframe: Timeframe | string,
    onCandle: (candle: ICandle) => void,
  ): Promise<void> {
    // Real-time streaming handled by WebSocket connector
  }

  async unsubscribeFromMarketData(symbol: string, timeframe: Timeframe | string): Promise<void> {}

  private async fetchBinanceCandles(
    timeframe: Timeframe | string,
    limit: number,
  ): Promise<ICandle[]> {
    const interval = this.mapTimeframeToBinance(timeframe);
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`;

    try {
      const res = await fetch(url);
      const data = await res.json();

      if (!Array.isArray(data)) {
        throw new Error(`Binance API error: ${JSON.stringify(data)}`);
      }

      return data.map((k: any) => ({
        timestamp: new Date(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        isClosed: true,
      }));
    } catch (err) {
      console.error(`Error fetching Binance candles: ${(err as Error).message}`);
      return [];
    }
  }

  private async fetchYahooCandles(
    symbol: string,
    timeframe: Timeframe | string,
    limit: number,
  ): Promise<ICandle[]> {
    const yahooSymbol = RealLiveMarketDataProvider.SYMBOL_MAP[symbol] || symbol;
    const interval = this.mapTimeframeToYahoo(timeframe);
    const range = this.getRangeForTimeframe(timeframe, limit);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      yahooSymbol,
    )}?interval=${interval}&range=${range}`;

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const data = await res.json();

      const result = data?.chart?.result?.[0];
      if (!result || !result.timestamp) {
        throw new Error(`No chart data returned for ${yahooSymbol}`);
      }

      const timestamps: number[] = result.timestamp;
      const quote = result.indicators?.quote?.[0];
      if (!quote) return [];

      const candles: ICandle[] = [];

      for (let i = 0; i < timestamps.length; i++) {
        const o = quote.open[i];
        const h = quote.high[i];
        const l = quote.low[i];
        const c = quote.close[i];
        const v = quote.volume[i] || 0;

        if (o !== null && h !== null && l !== null && c !== null) {
          candles.push({
            timestamp: new Date(timestamps[i] * 1000),
            open: Number(Number(o).toFixed(2)),
            high: Number(Number(h).toFixed(2)),
            low: Number(Number(l).toFixed(2)),
            close: Number(Number(c).toFixed(2)),
            volume: Math.round(v),
            isClosed: true,
          });
        }
      }

      return candles.slice(-limit);
    } catch (err) {
      console.error(
        `Error fetching Yahoo Finance candles for ${symbol}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  private mapTimeframeToBinance(tf: Timeframe | string): string {
    switch (tf) {
      case '1m':
      case Timeframe.M1:
        return '1m';
      case '5m':
      case Timeframe.M5:
        return '5m';
      case '15m':
      case Timeframe.M15:
        return '15m';
      case '30m':
      case Timeframe.M30:
        return '30m';
      case '1h':
      case Timeframe.H1:
        return '1h';
      case '4h':
      case Timeframe.H4:
        return '4h';
      case '1d':
      case Timeframe.D1:
        return '1d';
      default:
        return '15m';
    }
  }

  private mapTimeframeToYahoo(tf: Timeframe | string): string {
    switch (tf) {
      case '1m':
      case Timeframe.M1:
        return '1m';
      case '5m':
      case Timeframe.M5:
        return '5m';
      case '15m':
      case Timeframe.M15:
        return '15m';
      case '30m':
      case Timeframe.M30:
        return '30m';
      case '1h':
      case Timeframe.H1:
        return '60m';
      case '4h':
      case Timeframe.H4:
        return '60m';
      case '1d':
      case Timeframe.D1:
        return '1d';
      default:
        return '15m';
    }
  }

  private getRangeForTimeframe(tf: Timeframe | string, limit: number): string {
    if (tf === '1m' || tf === '5m') return '5d';
    if (tf === '15m' || tf === '30m') return '1mo';
    if (tf === '1h' || tf === '4h') return '3mo';
    return '1y';
  }
}
