import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import { WS_EVENTS, MarketDataUnavailableError, StaleMarketDataError, getAuthoritativeInstrument } from '@quant/shared';

export type QuoteProvenance = 'LIVE_PROVIDER' | 'BOOTSTRAP' | 'STALE' | 'DEGRADED' | 'UNKNOWN';

export interface ILiveRealTicker {
  symbol: string;
  price: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  prevClose: number;
  changePercent: number;
  changeAmount: number;
  tickSize?: number;
  volatility: number;
  lastUpdated: number;
  provenance: QuoteProvenance;
  marketEventTime?: number;
  sequence?: number;
  observedAt?: number;
  receivedAt?: number;
}

@Injectable()
export class RealMarketStreamerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealMarketStreamerService.name);
  private nseTimer: NodeJS.Timeout | null = null;
  private binanceTimer: NodeJS.Timeout | null = null;
  private microTickTimer: NodeJS.Timeout | null = null;

  private tickers: Map<string, ILiveRealTicker> = new Map([
    [
      'NIFTY',
      {
        symbol: 'NIFTY',
        price: 24175.65,
        open: 24160.0,
        high: 24220.0,
        low: 24135.0,
        close: 24175.65,
        volume: 1250000,
        prevClose: 24207.8,
        changePercent: -0.13,
        changeAmount: -32.15,
        tickSize: 0.05,
        volatility: 0.8,
        lastUpdated: Date.now(),
        provenance: 'BOOTSTRAP',
      },
    ],
    [
      'BANKNIFTY',
      {
        symbol: 'BANKNIFTY',
        price: 57496.3,
        open: 57350.0,
        high: 57650.0,
        low: 57280.0,
        close: 57496.3,
        volume: 850000,
        prevClose: 57380.0,
        changePercent: 0.2,
        changeAmount: 116.3,
        tickSize: 0.05,
        volatility: 2.2,
        lastUpdated: Date.now(),
        provenance: 'BOOTSTRAP',
      },
    ],
    [
      'BTCUSDT',
      {
        symbol: 'BTCUSDT',
        price: 79623.35,
        open: 79200.0,
        high: 80100.0,
        low: 78900.0,
        close: 79623.35,
        volume: 45000,
        prevClose: 79150.0,
        changePercent: 0.6,
        changeAmount: 473.35,
        tickSize: 0.1,
        volatility: 8.5,
        lastUpdated: Date.now(),
        provenance: 'BOOTSTRAP',
      },
    ],
    [
      'XAUUSD',
      {
        symbol: 'XAUUSD',
        price: 2885.5,
        open: 2872.0,
        high: 2898.0,
        low: 2865.0,
        close: 2885.5,
        volume: 95000,
        prevClose: 2875.0,
        changePercent: 0.36,
        changeAmount: 10.5,
        tickSize: 0.01,
        volatility: 1.2,
        lastUpdated: Date.now(),
        provenance: 'BOOTSTRAP',
      },
    ],
    [
      'RELIANCE',
      {
        symbol: 'RELIANCE',
        price: 1287.0,
        open: 1282.0,
        high: 1291.8,
        low: 1280.0,
        close: 1287.0,
        volume: 320000,
        prevClose: 1285.0,
        changePercent: 0.16,
        changeAmount: 2.0,
        tickSize: 0.05,
        volatility: 0.3,
        lastUpdated: Date.now(),
        provenance: 'BOOTSTRAP',
      },
    ],
    [
      'HDFCBANK',
      {
        symbol: 'HDFCBANK',
        price: 720.3,
        open: 715.0,
        high: 720.3,
        low: 707.0,
        close: 720.3,
        volume: 450000,
        prevClose: 712.0,
        changePercent: 1.17,
        changeAmount: 8.3,
        tickSize: 0.05,
        volatility: 0.15,
        lastUpdated: Date.now(),
        provenance: 'BOOTSTRAP',
      },
    ],
    [
      'INFY',
      {
        symbol: 'INFY',
        price: 1144.0,
        open: 1135.0,
        high: 1145.0,
        low: 1123.3,
        close: 1144.0,
        volume: 280000,
        prevClose: 1138.0,
        changePercent: 0.53,
        changeAmount: 6.0,
        tickSize: 0.05,
        volatility: 0.25,
        lastUpdated: Date.now(),
        provenance: 'BOOTSTRAP',
      },
    ],
  ]);

  constructor(private readonly redis: RedisService) {}

  onModuleInit() {
    this.startRealTimeFeeds();
  }

  startRealTimeFeeds() {
    this.logger.log(
      'Connecting to Live Real Market Data Feeds (Binance Public API & NSE Real-Time Quotes)...',
    );

    // 1. Fetch Real Binance Bitcoin Price every 2 seconds
    this.binanceTimer = setInterval(async () => {
      await this.fetchRealBinancePrice();
    }, 2000);

    // 2. Fetch Real NSE Indian Market Quotes every 3.5 seconds
    this.nseTimer = setInterval(async () => {
      await this.fetchRealNSEQuotes();
    }, 3500);

    // Initial fetch
    this.fetchRealBinancePrice();
    this.fetchRealNSEQuotes();
  }

  private async fetchRealBinancePrice() {
    const now = Date.now();
    try {
      const res = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT');
      const data = await res.json();

      if (data && (data.lastPrice || data.c)) {
        const ticker = this.ingestBinanceTickerData(data);
        if (ticker) await this.broadcastTick(ticker);
      }

      // Fetch Binance PAXGUSDT Price
      const paxgRes = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=PAXGUSDT');
      const paxgData = await paxgRes.json();

      if (paxgData && paxgData.lastPrice) {
        const livePrice = parseFloat(paxgData.lastPrice);
        const open = parseFloat(paxgData.openPrice);
        const high = parseFloat(paxgData.highPrice);
        const low = parseFloat(paxgData.lowPrice);
        const volume = parseFloat(paxgData.volume);
        const changePercent = parseFloat(paxgData.priceChangePercent);
        const changeAmount = parseFloat(paxgData.priceChange);

        const ticker = this.tickers.get('PAXGUSDT') || {
          symbol: 'PAXGUSDT',
          price: livePrice,
          open,
          high,
          low,
          close: livePrice,
          volume: Math.round(volume),
          prevClose: open,
          changePercent,
          changeAmount,
          tickSize: 0.01,
          volatility: 1.2,
          lastUpdated: now,
          provenance: 'LIVE_PROVIDER',
        };

        ticker.price = livePrice;
        ticker.close = livePrice;
        ticker.high = Math.max(ticker.high, high);
        ticker.low = Math.min(ticker.low, low);
        ticker.volume = Math.round(volume);
        ticker.changePercent = changePercent;
        ticker.changeAmount = changeAmount;
        ticker.lastUpdated = now;
        ticker.provenance = 'LIVE_PROVIDER';
        ticker.marketEventTime = paxgData.closeTime ? Number(paxgData.closeTime) : now;
        ticker.observedAt = now;
        ticker.receivedAt = now;

        this.tickers.set('PAXGUSDT', ticker);
        await this.broadcastTick(ticker);
      }
    } catch (err) {
      this.logger.debug(`Binance real tick notice: ${(err as Error).message}`);
    }
  }

  private async fetchRealNSEQuotes() {
    const now = Date.now();
    const symbolMap: Record<string, string> = {
      NIFTY: '^NSEI',
      BANKNIFTY: '^NSEBANK',
      RELIANCE: 'RELIANCE.NS',
      HDFCBANK: 'HDFCBANK.NS',
      INFY: 'INFY.NS',
      XAUUSD: 'GC=F',
      GOLD: 'GC=F',
    };

    for (const [sym, yahooSym] of Object.entries(symbolMap)) {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
          yahooSym,
        )}?interval=1m&range=1d`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = await res.json();
        const meta = data?.chart?.result?.[0]?.meta;

        if (meta && meta.regularMarketPrice) {
          const livePrice = Number(meta.regularMarketPrice.toFixed(2));
          const prevClose = Number(
            (meta.chartPreviousClose || meta.previousClose || livePrice).toFixed(2),
          );
          const high = Number((meta.regularMarketDayHigh || livePrice).toFixed(2));
          const low = Number((meta.regularMarketDayLow || livePrice).toFixed(2));
          const volume = meta.regularMarketVolume || 100000;
          const changeAmount = Number((livePrice - prevClose).toFixed(2));
          const changePercent = Number(((changeAmount / prevClose) * 100).toFixed(2));

          const ticker = this.tickers.get(sym);
          if (ticker) {
            ticker.price = livePrice;
            ticker.close = livePrice;
            ticker.open = Number((meta.regularMarketOpen || ticker.open).toFixed(2));
            ticker.high = Math.max(ticker.high, high);
            ticker.low = Math.min(ticker.low, low);
            ticker.volume = volume;
            ticker.prevClose = prevClose;
            ticker.changeAmount = changeAmount;
            ticker.changePercent = changePercent;
            ticker.lastUpdated = now;
            ticker.provenance = 'LIVE_PROVIDER';
            ticker.marketEventTime = meta.regularMarketTime ? meta.regularMarketTime * 1000 : now;
            ticker.observedAt = now;
            ticker.receivedAt = now;
            await this.broadcastTick(ticker);
          }
        }
      } catch (err) {
        this.logger.debug(`NSE real tick notice for ${sym}: ${(err as Error).message}`);
      }
    }
  }

  private async broadcastTick(ticker: ILiveRealTicker) {
    const redisClient = this.redis.getClient();
    if (!redisClient || redisClient.status !== 'ready') return;

    // Cache live tick with timestamp for worker and execution services
    await this.redis.set(`ticker:${ticker.symbol}:live`, JSON.stringify(ticker), 60);

    const payload = {
      symbol: ticker.symbol,
      timeframe: '15m',
      price: ticker.price,
      open: ticker.open,
      high: ticker.high,
      low: ticker.low,
      close: ticker.close,
      volume: ticker.volume,
      changeAmount: ticker.changeAmount,
      changePercent: ticker.changePercent,
      timestamp: new Date().toISOString(),
      provenance: ticker.provenance,
      marketEventTime: ticker.marketEventTime,
      isRealMarket: true,
    };

    await redisClient.publish(WS_EVENTS.CANDLE_UPDATED, JSON.stringify(payload));
  }

  /**
   * Helper to manually push/update a ticker (e.g. for live provider feeds or automated tests)
   */
  public updateTicker(symbol: string, tick: Partial<ILiveRealTicker> & { price: number }) {
    const sym = symbol.toUpperCase();
    const now = Date.now();
    const existing = this.tickers.get(sym);

    const provenance = tick.provenance ?? 'LIVE_PROVIDER';
    if (provenance === 'LIVE_PROVIDER') {
      const eventTime = tick.marketEventTime;
      if (eventTime === undefined || eventTime === null || !Number.isFinite(eventTime) || eventTime <= 0) {
        return existing || null; // Reject tick: LIVE_PROVIDER requires valid positive marketEventTime
      }
    }

    // Sequence number ordering: higher sequence takes precedence over timestamp
    const hasSequenceComparison = existing && existing.sequence !== undefined && tick.sequence !== undefined;
    if (hasSequenceComparison) {
      if (tick.sequence! < existing!.sequence!) {
        return existing;
      }
    } else if (existing && existing.marketEventTime && tick.marketEventTime && tick.marketEventTime < existing.marketEventTime) {
      // Out-of-order rejection: Do NOT regress to an older provider marketEventTime when sequence is absent
      return existing;
    }

    let tickSize: number | undefined = tick.tickSize ?? existing?.tickSize;
    if (tickSize === undefined) {
      try {
        const inst = getAuthoritativeInstrument(sym);
        if (inst && inst.tickSize) tickSize = inst.tickSize;
      } catch {
        // Unknown instrument -> tickSize remains undefined
      }
    }

    const updated: ILiveRealTicker = {
      symbol: sym,
      price: tick.price,
      open: tick.open ?? existing?.open ?? tick.price,
      high: tick.high ?? existing?.high ?? tick.price,
      low: tick.low ?? existing?.low ?? tick.price,
      close: tick.close ?? tick.price,
      volume: tick.volume ?? existing?.volume ?? 1000,
      prevClose: tick.prevClose ?? existing?.prevClose ?? tick.price,
      changePercent: tick.changePercent ?? existing?.changePercent ?? 0,
      changeAmount: tick.changeAmount ?? existing?.changeAmount ?? 0,
      tickSize,
      volatility: tick.volatility ?? existing?.volatility ?? 1.0,
      lastUpdated: tick.lastUpdated ?? now,
      provenance,
      marketEventTime: tick.marketEventTime ?? undefined,
      sequence: tick.sequence ?? existing?.sequence ?? undefined,
      observedAt: tick.observedAt ?? now,
      receivedAt: tick.receivedAt ?? now,
    };
    this.tickers.set(sym, updated);
    if (provenance === 'LIVE_PROVIDER') {
      this.freshSymbolsAfterReconnect.add(`SPOT:${sym}`);
    }
    return updated;
  }

  private optionTickers: Map<string, ILiveRealTicker> = new Map();

  getTicker(symbol: string) {
    return this.tickers.get(symbol.toUpperCase());
  }

  private providerConnected = true;
  private reconnectedAt: number | null = null;
  private freshSymbolsAfterReconnect = new Set<string>();

  public setProviderConnected(connected: boolean): void {
    const wasDisconnected = !this.providerConnected;
    this.providerConnected = connected;
    if (connected && wasDisconnected) {
      this.reconnectedAt = Date.now();
      this.freshSymbolsAfterReconnect.clear();
    }
  }

  public disconnectProvider(): void {
    this.providerConnected = false;
  }

  public ingestBinanceTickerData(data: any): ILiveRealTicker | null {
    if (!data) return null;

    const sym = (data.symbol || data.s || 'BTCUSDT').toUpperCase();
    const existing = this.tickers.get(sym);

    const rawCloseTime = data.closeTime ?? data.C;
    const marketEventTime = Number(rawCloseTime);

    // If incoming tick has a timestamp strictly older than existing valid marketEventTime,
    // ignore it completely — do NOT degrade a fresh existing ticker with an old out-of-order tick!
    if (
      existing &&
      existing.marketEventTime &&
      Number.isFinite(marketEventTime) &&
      marketEventTime < existing.marketEventTime
    ) {
      return null;
    }

    if (!Number.isFinite(marketEventTime) || marketEventTime <= 0) {
      if (existing) {
        existing.provenance = 'DEGRADED';
      }
      return null; // Reject tick: Provider timestamp missing, zero, negative, or invalid
    }

    const now = Date.now();
    const maxClockSkewMs = 5000;
    if (marketEventTime > now + maxClockSkewMs) {
      if (existing) {
        existing.provenance = 'DEGRADED';
      }
      return null; // Reject tick: Provider timestamp is from future beyond clock skew limit (5s)
    }

    const rawProvenance = data.provenance;
    if (rawProvenance && rawProvenance !== 'LIVE_PROVIDER') {
      if (existing) {
        existing.provenance = 'DEGRADED';
      }
      return null; // Reject tick: Non-LIVE_PROVIDER provenance
    }

    const rawPrice = data.lastPrice ?? data.c ?? data.price;
    const livePrice = rawPrice !== undefined && rawPrice !== null ? parseFloat(rawPrice) : NaN;
    if (!Number.isFinite(livePrice) || livePrice <= 0) {
      if (existing) {
        existing.provenance = 'DEGRADED';
      }
      return null; // Reject tick: Invalid or non-positive execution price
    }
    if (existing && existing.marketEventTime) {
      if (marketEventTime === existing.marketEventTime && livePrice === existing.price) {
        return existing; // Duplicate payload: return existing without mutating
      }
    }

    const rawOpen = data.openPrice ?? data.o;
    const open = rawOpen !== undefined && rawOpen !== null ? parseFloat(rawOpen) : NaN;
    const rawHigh = data.highPrice ?? data.h;
    const high = rawHigh !== undefined && rawHigh !== null ? parseFloat(rawHigh) : NaN;
    const rawLow = data.lowPrice ?? data.l;
    const low = rawLow !== undefined && rawLow !== null ? parseFloat(rawLow) : NaN;
    const rawVol = data.volume ?? data.v;
    const volume = rawVol !== undefined && rawVol !== null ? parseFloat(rawVol) : NaN;
    const rawChangePct = data.priceChangePercent ?? data.P;
    const changePercent = rawChangePct !== undefined && rawChangePct !== null ? parseFloat(rawChangePct) : NaN;
    const rawChangeAmt = data.priceChange ?? data.p;
    const changeAmount = rawChangeAmt !== undefined && rawChangeAmt !== null ? parseFloat(rawChangeAmt) : NaN;

    let tickSize: number | undefined = undefined;
    try {
      const inst = getAuthoritativeInstrument(sym);
      if (inst && inst.tickSize) tickSize = inst.tickSize;
    } catch {
      // Do not fabricate tickSize if metadata lookup fails
    }

    const updated: ILiveRealTicker = {
      symbol: sym,
      price: livePrice,
      open: Number.isFinite(open) ? open : livePrice,
      high: Number.isFinite(high) ? high : livePrice,
      low: Number.isFinite(low) ? low : livePrice,
      close: livePrice,
      volume: Number.isFinite(volume) && volume >= 0 ? Math.round(volume) : 0,
      prevClose: Number.isFinite(open) ? open : livePrice,
      changePercent: Number.isFinite(changePercent) ? changePercent : 0,
      changeAmount: Number.isFinite(changeAmount) ? changeAmount : 0,
      tickSize: tickSize ?? existing?.tickSize ?? undefined,
      volatility: existing?.volatility ?? 1.0,
      lastUpdated: now,
      provenance: 'LIVE_PROVIDER',
      marketEventTime,
      observedAt: now,
      receivedAt: now,
    };

    this.tickers.set(sym, updated);
    this.freshSymbolsAfterReconnect.add(`SPOT:${sym}`);
    return updated;
  }

  public async handleBinanceTickerData(data: any) {
    const ticker = this.ingestBinanceTickerData(data);
    if (ticker) {
      await this.broadcastTick(ticker);
    }
    return ticker;
  }

  public updateOptionTicker(
    contractSymbol: string,
    tick: Partial<ILiveRealTicker> & { price: number },
  ) {
    const key = contractSymbol.toUpperCase();
    const now = Date.now();
    const existing = this.optionTickers.get(key);

    const provenance = tick.provenance ?? 'LIVE_PROVIDER';
    if (provenance === 'LIVE_PROVIDER') {
      const eventTime = tick.marketEventTime;
      if (eventTime === undefined || eventTime === null || !Number.isFinite(eventTime) || eventTime <= 0) {
        return existing || null; // Reject tick: LIVE_PROVIDER requires valid positive marketEventTime
      }
    }

    const updated: ILiveRealTicker = {
      symbol: key,
      price: tick.price,
      open: tick.open ?? existing?.open ?? tick.price,
      high: tick.high ?? existing?.high ?? tick.price,
      low: tick.low ?? existing?.low ?? tick.price,
      close: tick.close ?? tick.price,
      volume: tick.volume ?? existing?.volume ?? 1000,
      prevClose: tick.prevClose ?? existing?.prevClose ?? tick.price,
      changePercent: tick.changePercent ?? existing?.changePercent ?? 0,
      changeAmount: tick.changeAmount ?? existing?.changeAmount ?? 0,
      tickSize: tick.tickSize ?? existing?.tickSize ?? undefined,
      volatility: tick.volatility ?? existing?.volatility ?? 1.0,
      lastUpdated: tick.lastUpdated ?? now,
      provenance,
      marketEventTime: tick.marketEventTime ?? undefined,
      sequence: tick.sequence ?? existing?.sequence ?? undefined,
      observedAt: tick.observedAt ?? now,
      receivedAt: tick.receivedAt ?? now,
    };
    this.optionTickers.set(key, updated);
    if (provenance === 'LIVE_PROVIDER') {
      this.freshSymbolsAfterReconnect.add(`OPTION:${key}`);
    }
    return updated;
  }

  public getOptionTicker(contractSymbol: string): ILiveRealTicker | null {
    const key = contractSymbol.toUpperCase();
    if (this.reconnectedAt !== null && !this.freshSymbolsAfterReconnect.has(`OPTION:${key}`)) {
      return null;
    }
    return this.optionTickers.get(key) || null;
  }

  /**
   * Retrieves live ticker with strict validation for trade execution:
   * 1. Price > 0
   * 2. Provenance must be LIVE_PROVIDER (BOOTSTRAP / UNKNOWN / STALE rejected)
   * 3. Must contain genuine, positive marketEventTime
   * 4. Freshness check: age <= maxAgeSeconds (default 5s)
   * 5. Throws MarketDataUnavailableError or StaleMarketDataError on failure.
   */
  getValidatedTicker(
    symbol: string,
    maxAgeSeconds = 5,
  ): ILiveRealTicker {
    const sym = symbol.toUpperCase();

    if (!this.providerConnected) {
      throw new MarketDataUnavailableError(
        sym,
        'Market data provider is disconnected. Trade execution blocked.',
      );
    }

    if (this.reconnectedAt !== null && !this.freshSymbolsAfterReconnect.has(`SPOT:${sym}`)) {
      throw new MarketDataUnavailableError(
        sym,
        `Market quote for ${sym} is a cached tick from before provider reconnection. A fresh valid tick is required after reconnection.`,
      );
    }

    const ticker = this.tickers.get(sym);

    if (!ticker) {
      throw new MarketDataUnavailableError(
        sym,
        'No active market data stream available for symbol',
      );
    }

    if (ticker.provenance !== 'LIVE_PROVIDER') {
      throw new MarketDataUnavailableError(
        sym,
        `Market quote for ${sym} is of provenance '${ticker.provenance}'. Startup BOOTSTRAP defaults cannot be used for execution.`,
      );
    }

    if (!ticker.marketEventTime || !Number.isFinite(ticker.marketEventTime) || ticker.marketEventTime <= 0) {
      throw new MarketDataUnavailableError(
        sym,
        `Market quote for ${sym} is missing mandatory provider marketEventTime`,
      );
    }

    if (!Number.isFinite(ticker.price) || ticker.price <= 0) {
      throw new MarketDataUnavailableError(
        sym,
        `Invalid execution price received: ${ticker.price}`,
        new Date(ticker.marketEventTime),
      );
    }

    const now = Date.now();
    const eventTime = ticker.marketEventTime;
    const maxClockSkewMs = 5000;
    if (eventTime > now + maxClockSkewMs) {
      throw new StaleMarketDataError(sym, (eventTime - now) / 1000, maxAgeSeconds, new Date(eventTime));
    }

    const ageMs = Math.max(0, now - eventTime);
    const ageSeconds = ageMs / 1000;
    if (ageSeconds > maxAgeSeconds) {
      throw new StaleMarketDataError(sym, ageSeconds, maxAgeSeconds, new Date(eventTime));
    }

    return ticker;
  }

  getAllTickers() {
    return Array.from(this.tickers.values());
  }

  onModuleDestroy() {
    if (this.binanceTimer) clearInterval(this.binanceTimer);
    if (this.nseTimer) clearInterval(this.nseTimer);
    if (this.microTickTimer) clearInterval(this.microTickTimer);
  }
}
