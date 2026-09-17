import { ICandle, IMarketDataProvider } from '../interfaces';
import { AssetType, Timeframe, getTimeframeDurationMs } from '../enums';
import { getAuthoritativeInstrument } from '../instrument/instrument-registry';

export class RealLiveMarketDataProvider implements IMarketDataProvider {
  public readonly providerName = 'RealLiveMarketDataProvider';

  private static readonly YAHOO_SYMBOL_MAP: Record<string, string> = {
    NIFTY: '^NSEI',
    NIFTY_SPOT: '^NSEI',
    BANKNIFTY: '^NSEBANK',
    BANKNIFTY_SPOT: '^NSEBANK',
    RELIANCE: 'RELIANCE.NS',
    HDFCBANK: 'HDFCBANK.NS',
    INFY: 'INFY.NS',
    XAUUSD: 'GC=F',
    GOLD: 'GC=F',
    GOLD_MCX: 'GC=F',
  };

  /**
   * Fetches real historical/live candles according to the authoritative Instrument Registry and Venue Profile.
   * STRICT FAIL-CLOSED: Fails on unknown or inactive instruments.
   * XAUUSD is routed exclusively to authoritative metals feeds (Yahoo GC=F), NEVER Binance PAXGUSDT.
   */
  async getHistoricalCandles(
    symbol: string,
    timeframe: Timeframe | string,
    limit = 100,
    endTime: Date = new Date(),
  ): Promise<ICandle[]> {
    const sym = symbol.toUpperCase();

    // 1. Authoritative Instrument Resolution & Validation
    const instrument = getAuthoritativeInstrument(sym);
    if (!instrument || instrument.isActive === false) {
      throw new Error(
        `[MARKET DATA FAIL-CLOSED] Inactive or unrecognized instrument: '${sym}'. RealLiveMarketDataProvider requires an active authoritative instrument.`,
      );
    }

    // 2. Route by Venue & Asset Type
    if (instrument.exchange === 'BINANCE' || instrument.assetType === AssetType.CRYPTO) {
      return this.fetchBinanceCandles(sym, timeframe, limit);
    }

    return this.fetchYahooCandles(sym, timeframe, limit);
  }

  async getLatestCandle(symbol: string, timeframe: Timeframe | string): Promise<ICandle> {
    const candles = await this.getHistoricalCandles(symbol, timeframe, 5);
    if (!candles || candles.length === 0) {
      throw new Error(`[MARKET DATA FAIL-CLOSED] No market data returned for '${symbol}' on ${timeframe}.`);
    }
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
    symbol: string,
    timeframe: Timeframe | string,
    limit: number,
  ): Promise<ICandle[]> {
    const binanceSymbol = symbol === 'BTCUSDT_SPOT' ? 'BTCUSDT' : symbol;
    const interval = this.mapTimeframeToBinance(timeframe);
    const durationMs = getTimeframeDurationMs(timeframe);
    const serverNow = Date.now();
    const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(binanceSymbol)}&interval=${interval}&limit=${Math.min(limit + 10, 500)}`;

    try {
      const res = await fetch(url);
      const data = await res.json();

      if (!Array.isArray(data)) {
        throw new Error(`Binance API error for ${symbol}: ${JSON.stringify(data)}`);
      }

      const candles: ICandle[] = data.map((k: any) => {
        const openTimeMs = Number(k[0]);
        const closeTimeMs = Number(k[6]) || (openTimeMs + durationMs - 1);
        const isClosed = serverNow >= openTimeMs + durationMs || serverNow > closeTimeMs;
        return {
          timestamp: new Date(openTimeMs),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
          isClosed,
          provenance: 'LIVE',
        };
      });

      return candles.slice(-limit);
    } catch (err) {
      console.error(`Error fetching Binance candles for ${symbol}: ${(err as Error).message}`);
      return [];
    }
  }

  private async fetchYahooCandles(
    symbol: string,
    timeframe: Timeframe | string,
    limit: number,
  ): Promise<ICandle[]> {
    const yahooSymbol = RealLiveMarketDataProvider.YAHOO_SYMBOL_MAP[symbol] || symbol;
    const interval = this.mapTimeframeToYahoo(timeframe);
    const range = this.getRangeForTimeframe(timeframe, limit);
    const durationMs = getTimeframeDurationMs(timeframe);
    const serverNow = Date.now();
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      yahooSymbol,
    )}?interval=${interval}&range=${range}`;

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
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
          const openTimeMs = timestamps[i] * 1000;
          const isClosed = serverNow >= openTimeMs + durationMs;
          candles.push({
            timestamp: new Date(openTimeMs),
            open: Number(Number(o).toFixed(2)),
            high: Number(Number(h).toFixed(2)),
            low: Number(Number(l).toFixed(2)),
            close: Number(Number(c).toFixed(2)),
            volume: Math.round(v),
            isClosed,
            provenance: 'LIVE',
          });
        }
      }

      return candles.slice(-limit);
    } catch (err) {
      console.error(
        `Error fetching Yahoo Finance candles for ${symbol} (${yahooSymbol}): ${(err as Error).message}`,
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
