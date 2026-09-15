import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import { RedisService } from '../common/redis/redis.service';
import {
  WS_EVENTS,
  MarketDataUnavailableError,
  StaleMarketDataError,
  getAuthoritativeInstrument,
  validateExecutionQuoteTimestamp,
  createCanonicalOptionQuoteRecord,
  ICanonicalOptionQuoteRecord,
  isValidatedCanonicalOptionProviderTick,
  isValidatedCanonicalSpotProviderTick,
  BINANCE_OPTION_PROVIDER_ADAPTER,
  BINANCE_REST_PROVIDER_ADAPTER,
  BINANCE_SPOT_PROVIDER_ADAPTER,
  BINANCE_REST_SPOT_PROVIDER_ADAPTER,
  NSE_REST_OPTION_PROVIDER_ADAPTER,
  NSE_STREAM_OPTION_PROVIDER_ADAPTER,
  NSE_STREAM_SPOT_PROVIDER_ADAPTER,
  NSE_YAHOO_REST_PROVIDER_ADAPTER,
  NSE_YAHOO_REST_SPOT_PROVIDER_ADAPTER,
  isProviderConnectionIdentity,
  ProviderConnectionIdentity,
  ValidatedCanonicalOptionProviderTick,
  ValidatedCanonicalSpotProviderTick,
  normalizeCanonicalProviderId,
  validateAuthoritativeExecutionQuote,
  validateCurrentProviderExecutionQuote,
  ProviderRuntimeState,
} from '@quant/shared';

export type QuoteProvenance = 'LIVE_PROVIDER' | 'BOOTSTRAP' | 'STALE' | 'DEGRADED' | 'UNKNOWN';
export type ProviderConnectionState = 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING' | 'RECONNECTED';

export interface ILiveRealTicker {
  symbol: string;
  price: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  prevClose?: number;
  changePercent?: number;
  changeAmount?: number;
  tickSize?: number;
  volatility?: number;
  lastUpdated: number;
  provenance: QuoteProvenance;
  marketEventTime?: number;
  sequence?: number;
  observedAt?: number;
  receivedAt?: number;
  isDerivedFields?: boolean;
  connectionEpoch?: number;
  providerInstanceId?: string;
  providerConnectionId?: string;
  providerTransport?: 'WEBSOCKET_STREAM' | 'REST_POLLING';
  providerId?: string;
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
      if (!res.ok) {
        return;
      }
      const data = await res.json();

      if (data && (data.lastPrice || data.c)) {
        const ticker = this.ingestBinanceTickerData(data);
        if (ticker) await this.broadcastTick(ticker);
      }

      // Fetch Binance PAXGUSDT Price
      const paxgRes = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=PAXGUSDT');
      if (paxgRes.ok) {
        const paxgData = await paxgRes.json();
        if (paxgData && paxgData.lastPrice) {
          const rawCloseTime = paxgData.closeTime;
          const eventTime = rawCloseTime ? Number(rawCloseTime) : null;
          if (!eventTime || eventTime <= 0 || !Number.isFinite(eventTime)) {
            // Missing provider event time -> reject quote without fabricating Date.now()
            return;
          }

          const livePrice = parseFloat(paxgData.lastPrice);
          const open = parseFloat(paxgData.openPrice);
          const high = parseFloat(paxgData.highPrice);
          const low = parseFloat(paxgData.lowPrice);
          const volume = parseFloat(paxgData.volume);
          const changePercent = parseFloat(paxgData.priceChangePercent);
          const changeAmount = parseFloat(paxgData.priceChange);
          const existingPaxgTicker = this.tickers.get('PAXGUSDT');

          const canonicalTick = BINANCE_REST_SPOT_PROVIDER_ADAPTER.toCanonicalExecutionTick({
            providerSymbol: 'PAXGUSDT',
            price: livePrice,
            providerEventTime: eventTime,
            open,
            high: Math.max(existingPaxgTicker?.high ?? high, high),
            low: Math.min(existingPaxgTicker?.low ?? low, low),
            close: livePrice,
            volume: Math.round(volume),
            prevClose: open,
            changePercent,
            changeAmount,
            tickSize: 0.01,
          });

          const updated = this.ingestCanonicalSpotTick(canonicalTick);
          if (updated) {
            await this.broadcastTick(updated);
          }
        }
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

          const marketEventTime = meta.regularMarketTime ? meta.regularMarketTime * 1000 : null;
          if (!marketEventTime || !Number.isFinite(marketEventTime) || marketEventTime <= 0) {
            this.setRestHealthState('DEGRADED', 'NSE_YAHOO_REST');
            continue;
          }

          this.setRestHealthState('HEALTHY', 'NSE_YAHOO_REST');
          const canonicalTick = NSE_YAHOO_REST_SPOT_PROVIDER_ADAPTER.toCanonicalExecutionTick({
            providerSymbol: sym,
            price: livePrice,
            providerEventTime: marketEventTime,
            open: Number((meta.regularMarketOpen || livePrice).toFixed(2)),
            high,
            low,
            close: livePrice,
            volume,
            prevClose,
            changeAmount,
            changePercent,
          });

          const updated = this.ingestCanonicalSpotTick(canonicalTick);
          if (updated) {
            await this.broadcastTick(updated);
          }
        }
      } catch (err) {
        this.setRestHealthState('UNAVAILABLE', 'NSE_YAHOO_REST');
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
   * Sealed production spot tick ingestion path.
   * Only accepts branded, sealed canonical spot ticks minted by spot provider adapters.
   */
  public ingestCanonicalSpotTick(
    canonicalTick: ValidatedCanonicalSpotProviderTick,
  ): ILiveRealTicker | null {
    if (!isValidatedCanonicalSpotProviderTick(canonicalTick)) {
      throw new Error('[UNBRANDED_SPOT_TICK_REJECTED] Spot tick ingestion requires a sealed canonical spot tick');
    }
    const params = canonicalTick.toRecordInput();
    const sym = (params.symbol || (params as any).contractSymbol || '').toUpperCase();
    const existing = this.tickers.get(sym);
    const now = Date.now();

    if (existing) {
      if (params.sequence !== undefined && existing.sequence !== undefined && params.sequence < existing.sequence) {
        return existing; // Sequence out of order rejection: keep higher sequence price
      }
      if (existing.marketEventTime && params.marketEventTime < existing.marketEventTime && (params.sequence === undefined || existing.sequence === undefined)) {
        return null; // Out of order rejection
      }
    }

    let tickSize: number | undefined = params.tickSize ?? existing?.tickSize;
    if (tickSize === undefined) {
      try {
        const inst = getAuthoritativeInstrument(sym);
        if (inst && inst.tickSize) tickSize = inst.tickSize;
      } catch {}
    }

    const updated: ILiveRealTicker = {
      symbol: sym,
      price: params.price,
      open: params.open ?? existing?.open ?? params.price,
      high: Math.max(existing?.high ?? params.price, params.high ?? params.price),
      low: Math.min(existing?.low ?? params.price, params.low ?? params.price),
      close: params.close ?? params.price,
      volume: params.volume ?? existing?.volume ?? 0,
      prevClose: params.prevClose ?? existing?.prevClose ?? params.price,
      changePercent: params.changePercent ?? existing?.changePercent ?? 0,
      changeAmount: params.changeAmount ?? existing?.changeAmount ?? 0,
      tickSize,
      volatility: params.volatility ?? existing?.volatility ?? 1.0,
      lastUpdated: now,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: params.marketEventTime,
      connectionEpoch: params.connectionEpoch,
      providerId: params.providerId,
      providerInstanceId: params.providerInstanceId,
      providerConnectionId: params.providerConnectionId,
      providerTransport: params.providerTransport,
      sequence: params.sequence ?? existing?.sequence,
      observedAt: params.observedAt ?? now,
      receivedAt: params.receivedAt ?? now,
    };

    this.tickers.set(sym, updated);
    const freshnessKey = `${params.providerTransport}:${params.providerId}:${params.providerConnectionId}:${sym}`;
    this.freshSymbolsAfterReconnect.add(freshnessKey);
    return updated;
  }


  /**
   * Helper to manually push/update a ticker for UI / test / non-authoritative state only.
   * If caller passes provenance === 'LIVE_PROVIDER' without a sealed tick, this method REJECTS
   * manufacturing connection identity authority.
   */
  public updateTicker(symbol: string, tick: Partial<ILiveRealTicker> & { price: number }) {
    const sym = symbol.toUpperCase();
    const now = Date.now();
    const existing = this.tickers.get(sym);

    const provenance = tick.provenance ?? 'UNKNOWN';

    // REQUIREMENT 1: updateTicker() is NOT a production authority boundary for LIVE_PROVIDER data.
    // Reject manufactured LIVE_PROVIDER execution authority from generic caller input.
    if (provenance === 'LIVE_PROVIDER') {
      throw new Error(
        '[UNAUTHORITATIVE_SPOT_TICK_REJECTED] updateTicker() cannot manufacture LIVE_PROVIDER execution authority from unbranded caller input. Production LIVE_PROVIDER ticks must be ingested via sealed provider adapters.',
      );
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
      connectionEpoch: undefined,
      providerId: undefined,
      providerInstanceId: undefined,
      providerConnectionId: undefined,
      providerTransport: undefined,
      sequence: tick.sequence ?? existing?.sequence ?? undefined,
      observedAt: tick.observedAt ?? now,
      receivedAt: tick.receivedAt ?? now,
    };
    this.tickers.set(sym, updated);
    return updated;
  }

  private optionTickers: Map<string, ILiveRealTicker> = new Map();

  getTicker(symbol: string) {
    return this.tickers.get(symbol.toUpperCase());
  }

  private streamRuntimeStateMap: Map<string, ProviderRuntimeState> = new Map();
  private restRuntimeStateMap: Map<string, ProviderRuntimeState> = new Map();

  private readonly providerInstanceId: string =
    process.env.CANONICAL_PROVIDER_INSTANCE_ID ||
    `api-${process.pid}-${crypto.randomUUID()}`;

  constructor(private readonly redis: RedisService) {
    this.initProviderConnections();
  }

  private initProviderConnections(): void {
    // 1. NSE_STREAM_GATEWAY
    const nseConn = NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection({
      providerInstanceId: this.providerInstanceId,
    });
    NSE_STREAM_SPOT_PROVIDER_ADAPTER.beginProviderConnection({ existingConnection: nseConn });
    this.streamRuntimeStateMap.set('NSE_STREAM_GATEWAY', {
      providerId: 'NSE_STREAM_GATEWAY',
      providerTransport: 'WEBSOCKET_STREAM',
      connectionState: 'CONNECTED',
      providerConnected: true,
      currentConnection: nseConn,
      reconnectedAt: null,
    });

    // 2. BINANCE_DIRECT
    const binanceConn = BINANCE_SPOT_PROVIDER_ADAPTER.beginProviderConnection({
      providerInstanceId: this.providerInstanceId,
    });
    BINANCE_OPTION_PROVIDER_ADAPTER.beginProviderConnection({ existingConnection: binanceConn });
    this.streamRuntimeStateMap.set('BINANCE_DIRECT', {
      providerId: 'BINANCE_DIRECT',
      providerTransport: 'WEBSOCKET_STREAM',
      connectionState: 'CONNECTED',
      providerConnected: true,
      currentConnection: binanceConn,
      reconnectedAt: null,
    });

    // REST Providers
    const nseRestConn = NSE_REST_OPTION_PROVIDER_ADAPTER.beginProviderConnection({
      providerInstanceId: this.providerInstanceId,
    });
    this.restRuntimeStateMap.set('NSE_REST_OPTION_PROVIDER', {
      providerId: 'NSE_REST_OPTION_PROVIDER',
      providerTransport: 'REST_POLLING',
      connectionState: 'CONNECTED',
      providerConnected: true,
      currentConnection: nseRestConn,
      reconnectedAt: null,
    });

    const yahooRestConn = NSE_YAHOO_REST_PROVIDER_ADAPTER.beginProviderConnection({
      providerInstanceId: this.providerInstanceId,
    });
    NSE_YAHOO_REST_SPOT_PROVIDER_ADAPTER.beginProviderConnection({ existingConnection: yahooRestConn });
    this.restRuntimeStateMap.set('NSE_YAHOO_REST', {
      providerId: 'NSE_YAHOO_REST',
      providerTransport: 'REST_POLLING',
      connectionState: 'CONNECTED',
      providerConnected: true,
      currentConnection: yahooRestConn,
      reconnectedAt: null,
    });

    const binanceRestConn = BINANCE_REST_PROVIDER_ADAPTER.beginProviderConnection({
      providerInstanceId: this.providerInstanceId,
    });
    BINANCE_REST_SPOT_PROVIDER_ADAPTER.beginProviderConnection({ existingConnection: binanceRestConn });
    this.restRuntimeStateMap.set('BINANCE_REST', {
      providerId: 'BINANCE_REST',
      providerTransport: 'REST_POLLING',
      connectionState: 'CONNECTED',
      providerConnected: true,
      currentConnection: binanceRestConn,
      reconnectedAt: null,
    });
  }

  private freshSymbolsAfterReconnect = new Set<string>();

  public resolveCurrentProviderRuntime(
    providerId: string,
    providerTransport: 'WEBSOCKET_STREAM' | 'REST_POLLING',
  ): ProviderRuntimeState {
    if (!providerId || typeof providerId !== 'string' || providerId.trim().length === 0) {
      throw new Error('[UNKNOWN_PROVIDER_ID_REJECTED] providerId is required');
    }
    const normId = normalizeCanonicalProviderId(providerId);

    if (!providerTransport || (providerTransport !== 'WEBSOCKET_STREAM' && providerTransport !== 'REST_POLLING')) {
      throw new Error(
        `[PROVIDER_TRANSPORT_MISMATCH] providerTransport is required and must be WEBSOCKET_STREAM or REST_POLLING`,
      );
    }

    if (providerTransport === 'WEBSOCKET_STREAM') {
      if (normId !== 'NSE_STREAM_GATEWAY' && normId !== 'BINANCE_DIRECT') {
        throw new Error(
          `[PROVIDER_TRANSPORT_MISMATCH] Provider '${providerId}' (canonical: '${normId}') does not support WEBSOCKET_STREAM transport`,
        );
      }
      const runtime = this.streamRuntimeStateMap.get(normId);
      if (!runtime || !runtime.currentConnection) {
        throw new Error(
          `[UNKNOWN_PROVIDER_ID_REJECTED] No active stream provider connection for '${providerId}' (canonical: '${normId}')`,
        );
      }
      return runtime;
    } else {
      if (
        normId !== 'NSE_REST_OPTION_PROVIDER' &&
        normId !== 'NSE_YAHOO_REST' &&
        normId !== 'BINANCE_REST'
      ) {
        throw new Error(
          `[PROVIDER_TRANSPORT_MISMATCH] Provider '${providerId}' (canonical: '${normId}') does not support REST_POLLING transport`,
        );
      }
      const runtime = this.restRuntimeStateMap.get(normId);
      if (!runtime || !runtime.currentConnection) {
        throw new Error(
          `[UNKNOWN_PROVIDER_ID_REJECTED] No active REST provider connection for '${providerId}' (canonical: '${normId}')`,
        );
      }
      return runtime;
    }
  }

  private transitionProviderRuntime(
    providerId: string,
    providerTransport: 'WEBSOCKET_STREAM' | 'REST_POLLING',
    updates: {
      connectionState?: ProviderConnectionState;
      providerConnected?: boolean;
      currentConnection?: ProviderConnectionIdentity;
      reconnectedAt?: number | null;
    },
  ): ProviderRuntimeState {
    const runtime = this.resolveCurrentProviderRuntime(providerId, providerTransport);
    if (updates.connectionState !== undefined) {
      runtime.connectionState = updates.connectionState;
    }
    if (updates.providerConnected !== undefined) {
      runtime.providerConnected = updates.providerConnected;
    }
    if (updates.currentConnection !== undefined) {
      runtime.currentConnection = updates.currentConnection;
    }
    if (updates.reconnectedAt !== undefined) {
      runtime.reconnectedAt = updates.reconnectedAt;
    }
    return runtime;
  }

  public getCurrentProviderConnection(
    providerId: string,
    providerTransport: 'WEBSOCKET_STREAM' | 'REST_POLLING',
  ): ProviderConnectionIdentity {
    return this.resolveCurrentProviderRuntime(providerId, providerTransport).currentConnection;
  }

  public getCurrentStreamProviderConnection(providerId: string): ProviderConnectionIdentity {
    return this.getCurrentProviderConnection(providerId, 'WEBSOCKET_STREAM');
  }

  public getCurrentRestProviderConnection(providerId: string): ProviderConnectionIdentity {
    return this.getCurrentProviderConnection(providerId, 'REST_POLLING');
  }

  public getCurrentOptionProviderConnection(
    providerId: string,
    providerTransport: 'WEBSOCKET_STREAM' | 'REST_POLLING',
  ): ProviderConnectionIdentity {
    return this.getCurrentProviderConnection(providerId, providerTransport);
  }

  public getProviderState(
    providerId: string,
    providerTransport: 'WEBSOCKET_STREAM' | 'REST_POLLING',
  ): ProviderConnectionState {
    const runtime = this.resolveCurrentProviderRuntime(providerId, providerTransport);
    return runtime.connectionState;
  }

  public getStreamConnectionState(providerId: string): ProviderConnectionState {
    return this.getProviderState(providerId, 'WEBSOCKET_STREAM');
  }

  public getRestHealthState(providerId: string): 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' {
    const runtime = this.resolveCurrentProviderRuntime(providerId, 'REST_POLLING');
    if (runtime.providerConnected && (runtime.connectionState === 'CONNECTED' || runtime.connectionState === 'RECONNECTED')) {
      return 'HEALTHY';
    }
    return runtime.connectionState === 'RECONNECTING' ? 'DEGRADED' : 'UNAVAILABLE';
  }

  /**
   * Models REST polling provider health as a logical provider connection session.
   * HEALTHY maps to CONNECTED state.
   * DEGRADED maps to RECONNECTING state.
   * UNAVAILABLE maps to DISCONNECTED state.
   */
  public setRestHealthState(
    state: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE',
    providerId: string,
  ): void {
    if (!providerId) throw new Error('[UNKNOWN_PROVIDER_ID_REJECTED] providerId is required');
    const normId = normalizeCanonicalProviderId(providerId);
    const runtime = this.resolveCurrentProviderRuntime(normId, 'REST_POLLING');
    const wasUnhealthy = !runtime.providerConnected || runtime.connectionState !== 'CONNECTED';
    if (state === 'HEALTHY') {
      this.transitionProviderRuntime(normId, 'REST_POLLING', {
        connectionState: 'CONNECTED',
        providerConnected: true,
      });
      if (wasUnhealthy) {
        this.beginRestProviderConnection(normId);
      }
    } else if (state === 'DEGRADED') {
      this.transitionProviderRuntime(normId, 'REST_POLLING', {
        connectionState: 'RECONNECTING',
        providerConnected: false,
      });
    } else {
      this.transitionProviderRuntime(normId, 'REST_POLLING', {
        connectionState: 'DISCONNECTED',
        providerConnected: false,
      });
    }
  }

  public isStreamExecutionHealthy(providerId: string): boolean {
    const runtime = this.resolveCurrentProviderRuntime(providerId, 'WEBSOCKET_STREAM');
    return (
      runtime.providerConnected &&
      (runtime.connectionState === 'CONNECTED' || runtime.connectionState === 'RECONNECTED')
    );
  }

  public isRestExecutionHealthy(providerId: string): boolean {
    const runtime = this.resolveCurrentProviderRuntime(providerId, 'REST_POLLING');
    return (
      runtime.providerConnected &&
      (runtime.connectionState === 'CONNECTED' || runtime.connectionState === 'RECONNECTED')
    );
  }

  // isExecutionDataHealthy()
  public isExecutionDataHealthy(
    providerTransport: 'WEBSOCKET_STREAM' | 'REST_POLLING',
    providerId: string,
  ): boolean {
    if (!providerTransport || !providerId) {
      throw new Error('[PROVIDER_TRANSPORT_MISMATCH] BOTH providerTransport AND providerId are required for isExecutionDataHealthy');
    }
    const runtime = this.resolveCurrentProviderRuntime(providerId, providerTransport);
    return (
      runtime.providerConnected &&
      (runtime.connectionState === 'CONNECTED' || runtime.connectionState === 'RECONNECTED')
    );
  }

  public getStreamConnectionEpoch(providerId: string): number {
    return this.getCurrentStreamProviderConnection(providerId).connectionEpoch;
  }

  public getRestConnectionEpoch(providerId: string): number {
    return this.getCurrentRestProviderConnection(providerId).connectionEpoch;
  }

  public getConnectionEpoch(
    providerId: string,
    providerTransport: 'WEBSOCKET_STREAM' | 'REST_POLLING',
  ): number {
    return this.getCurrentProviderConnection(providerId, providerTransport).connectionEpoch;
  }

  public getProviderInstanceId(): string {
    return this.providerInstanceId;
  }

  public getProviderConnectionId(
    providerId: string,
    providerTransport: 'WEBSOCKET_STREAM' | 'REST_POLLING',
  ): string {
    return this.getCurrentProviderConnection(providerId, providerTransport).providerConnectionId;
  }

  public beginStreamProviderConnection(
    providerId: string,
    options?: { existingConnection?: ProviderConnectionIdentity },
  ): ProviderConnectionIdentity {
    if (!providerId) throw new Error('[UNKNOWN_PROVIDER_ID_REJECTED] providerId is required');
    const normId = normalizeCanonicalProviderId(providerId);
    if (normId !== 'NSE_STREAM_GATEWAY' && normId !== 'BINANCE_DIRECT') {
      throw new Error(`[UNKNOWN_PROVIDER_ID_REJECTED] Cannot begin stream connection for unknown provider '${providerId}'`);
    }

    if (options?.existingConnection) {
      const existing = options.existingConnection;
      if (!isProviderConnectionIdentity(existing)) {
        throw new Error('[INVALID_SHARED_CONNECTION_IDENTITY] existingConnection must be a branded ProviderConnectionIdentity');
      }
      const existingNormId = normalizeCanonicalProviderId(existing.providerId);
      if (existingNormId !== normId || existing.providerTransport !== 'WEBSOCKET_STREAM' || existing.providerInstanceId !== this.providerInstanceId) {
        throw new Error(
          `[INVALID_SHARED_CONNECTION_IDENTITY] Existing connection providerId '${existing.providerId}' or transport '${existing.providerTransport}' does not match target stream provider '${normId}'`,
        );
      }
    }

    let conn: ProviderConnectionIdentity;
    if (normId === 'BINANCE_DIRECT') {
      conn = BINANCE_SPOT_PROVIDER_ADAPTER.beginProviderConnection({
        providerInstanceId: this.providerInstanceId,
        existingConnection: options?.existingConnection,
      });
      BINANCE_OPTION_PROVIDER_ADAPTER.beginProviderConnection({ existingConnection: conn });
    } else {
      conn = NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection({
        providerInstanceId: this.providerInstanceId,
        existingConnection: options?.existingConnection,
      });
      NSE_STREAM_SPOT_PROVIDER_ADAPTER.beginProviderConnection({ existingConnection: conn });
    }
    const state = this.streamRuntimeStateMap.get(normId);
    this.streamRuntimeStateMap.set(normId, {
      providerId: normId,
      providerTransport: 'WEBSOCKET_STREAM',
      connectionState: state?.connectionState || 'CONNECTED',
      providerConnected: state?.providerConnected ?? true,
      currentConnection: conn,
      reconnectedAt: state?.reconnectedAt ?? null,
    });
    return conn;
  }

  public beginRestProviderConnection(
    providerId: string,
    options?: { existingConnection?: ProviderConnectionIdentity },
  ): ProviderConnectionIdentity {
    if (!providerId) throw new Error('[UNKNOWN_PROVIDER_ID_REJECTED] providerId is required');
    const normId = normalizeCanonicalProviderId(providerId);

    if (options?.existingConnection) {
      const existing = options.existingConnection;
      if (!isProviderConnectionIdentity(existing)) {
        throw new Error('[INVALID_SHARED_CONNECTION_IDENTITY] existingConnection must be a branded ProviderConnectionIdentity');
      }
      const existingNormId = normalizeCanonicalProviderId(existing.providerId);
      if (existingNormId !== normId || existing.providerTransport !== 'REST_POLLING' || existing.providerInstanceId !== this.providerInstanceId) {
        throw new Error(
          `[INVALID_SHARED_CONNECTION_IDENTITY] Existing connection providerId '${existing.providerId}' or transport '${existing.providerTransport}' does not match target REST provider '${normId}'`,
        );
      }
    }

    let conn: ProviderConnectionIdentity;
    if (normId === 'BINANCE_REST') {
      conn = BINANCE_REST_PROVIDER_ADAPTER.beginProviderConnection({
        providerInstanceId: this.providerInstanceId,
        existingConnection: options?.existingConnection,
      });
      BINANCE_REST_SPOT_PROVIDER_ADAPTER.beginProviderConnection({ existingConnection: conn });
    } else if (normId === 'NSE_YAHOO_REST') {
      conn = NSE_YAHOO_REST_PROVIDER_ADAPTER.beginProviderConnection({
        providerInstanceId: this.providerInstanceId,
        existingConnection: options?.existingConnection,
      });
      NSE_YAHOO_REST_SPOT_PROVIDER_ADAPTER.beginProviderConnection({ existingConnection: conn });
    } else if (normId === 'NSE_REST_OPTION_PROVIDER') {
      conn = NSE_REST_OPTION_PROVIDER_ADAPTER.beginProviderConnection({
        providerInstanceId: this.providerInstanceId,
        existingConnection: options?.existingConnection,
      });
    } else {
      throw new Error(`[UNKNOWN_PROVIDER_ID_REJECTED] Cannot begin REST connection for unknown provider '${providerId}'`);
    }
    this.restRuntimeStateMap.set(normId, {
      providerId: normId,
      providerTransport: 'REST_POLLING',
      connectionState: 'CONNECTED',
      providerConnected: true,
      currentConnection: conn,
      reconnectedAt: null,
    });
    return conn;
  }

  public handleStreamProviderDisconnect(providerId: string, reason?: string): void {
    if (!providerId) throw new Error('[UNKNOWN_PROVIDER_ID_REJECTED] providerId is required');
    const normId = normalizeCanonicalProviderId(providerId);
    const state = this.resolveCurrentProviderRuntime(normId, 'WEBSOCKET_STREAM');
    if (state.providerConnected || state.connectionState !== 'DISCONNECTED') {
      this.logger.warn(`Market data stream provider '${normId}' disconnected: ${reason || 'Connection lost'}`);
    }
    this.transitionProviderRuntime(normId, 'WEBSOCKET_STREAM', {
      connectionState: 'DISCONNECTED',
      providerConnected: false,
    });

    const prefix = `WEBSOCKET_STREAM:${normId}:`;
    Array.from(this.freshSymbolsAfterReconnect)
      .filter((k) => k.startsWith(prefix))
      .forEach((k) => this.freshSymbolsAfterReconnect.delete(k));
  }

  public handleStreamProviderReconnecting(providerId: string): void {
    if (!providerId) throw new Error('[UNKNOWN_PROVIDER_ID_REJECTED] providerId is required');
    const normId = normalizeCanonicalProviderId(providerId);
    this.resolveCurrentProviderRuntime(normId, 'WEBSOCKET_STREAM');
    this.transitionProviderRuntime(normId, 'WEBSOCKET_STREAM', {
      connectionState: 'RECONNECTING',
      providerConnected: false,
    });

    const prefix = `WEBSOCKET_STREAM:${normId}:`;
    Array.from(this.freshSymbolsAfterReconnect)
      .filter((k) => k.startsWith(prefix))
      .forEach((k) => this.freshSymbolsAfterReconnect.delete(k));
  }

  public handleStreamProviderReconnect(providerId: string): void {
    if (!providerId) throw new Error('[UNKNOWN_PROVIDER_ID_REJECTED] providerId is required');
    const normId = normalizeCanonicalProviderId(providerId);
    const state = this.resolveCurrentProviderRuntime(normId, 'WEBSOCKET_STREAM');
    const wasNotConnected =
      !state.providerConnected ||
      (state.connectionState !== 'CONNECTED' && state.connectionState !== 'RECONNECTED');
    if (wasNotConnected) {
      this.transitionProviderRuntime(normId, 'WEBSOCKET_STREAM', {
        connectionState: 'RECONNECTED',
        providerConnected: true,
        reconnectedAt: Date.now(),
      });
      this.beginStreamProviderConnection(normId);

      const prefix = `WEBSOCKET_STREAM:${normId}:`;
      Array.from(this.freshSymbolsAfterReconnect)
        .filter((k) => k.startsWith(prefix))
        .forEach((k) => this.freshSymbolsAfterReconnect.delete(k));

      this.logger.log(`Market data stream provider '${normId}' reconnected. New stream connection epoch assigned.`);
    }
  }

  public handleRestProviderUnavailable(providerId: string, reason?: string): void {
    this.setRestHealthState('UNAVAILABLE', providerId);
  }

  public handleRestProviderDegraded(providerId: string, reason?: string): void {
    this.setRestHealthState('DEGRADED', providerId);
  }

  public handleRestProviderHealthy(providerId: string): void {
    this.setRestHealthState('HEALTHY', providerId);
  }

  public handleProviderDisconnect(reason?: string): void {
    for (const pid of this.streamRuntimeStateMap.keys()) {
      this.handleStreamProviderDisconnect(pid, reason);
    }
  }

  public handleProviderReconnecting(): void {
    for (const pid of this.streamRuntimeStateMap.keys()) {
      this.handleStreamProviderReconnecting(pid);
    }
  }

  public handleProviderReconnect(): void {
    for (const pid of this.streamRuntimeStateMap.keys()) {
      this.handleStreamProviderReconnect(pid);
    }
  }

  public setProviderConnected(connected: boolean): void {
    for (const pid of this.streamRuntimeStateMap.keys()) {
      if (connected) {
        this.handleStreamProviderReconnect(pid);
      } else {
        this.handleStreamProviderDisconnect(pid, 'Explicit setProviderConnected(false)');
      }
    }
  }

  public disconnectProvider(): void {
    for (const pid of this.streamRuntimeStateMap.keys()) {
      this.handleStreamProviderDisconnect(pid, 'Explicit disconnectProvider()');
    }
  }

  public ingestBinanceTickerData(data: any): ILiveRealTicker | null {
    if (!data) return null;

    const sym = (data.symbol || data.s || 'BTCUSDT').toUpperCase();
    const existing = this.tickers.get(sym);

    const rawCloseTime = data.closeTime ?? data.C ?? data.eventTime;
    const marketEventTime = Number(rawCloseTime);

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
      return null;
    }

    const now = Date.now();
    const maxClockSkewMs = 5000;
    if (marketEventTime > now + maxClockSkewMs) {
      if (existing) {
        existing.provenance = 'DEGRADED';
      }
      return null;
    }

    const rawProvenance = data.provenance;
    if (rawProvenance && rawProvenance !== 'LIVE_PROVIDER') {
      if (existing) {
        existing.provenance = 'DEGRADED';
      }
      return null;
    }

    const rawPrice = data.lastPrice ?? data.c ?? data.price;
    const livePrice = rawPrice !== undefined && rawPrice !== null ? parseFloat(rawPrice) : NaN;
    if (!Number.isFinite(livePrice) || livePrice <= 0) {
      if (existing) {
        existing.provenance = 'DEGRADED';
      }
      return null;
    }

    if (existing && existing.marketEventTime) {
      if (marketEventTime === existing.marketEventTime && livePrice === existing.price) {
        return existing;
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
    } catch {}

    const activeConn = this.getCurrentProviderConnection('BINANCE_DIRECT', 'WEBSOCKET_STREAM');
    const canonicalTick = BINANCE_SPOT_PROVIDER_ADAPTER.toCanonicalExecutionTick(
      {
        providerSymbol: sym,
        price: livePrice,
        providerEventTime: marketEventTime,
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
      },
      activeConn,
    );

    return this.ingestCanonicalSpotTick(canonicalTick);
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
      throw new Error(
        '[UNAUTHORITATIVE_OPTION_TICK_REJECTED] updateOptionTicker() cannot manufacture LIVE_PROVIDER execution authority from unbranded caller input. Production option ticks must be published via canonical option quote adapters.',
      );
    }

    const updated: ILiveRealTicker = {
      symbol: key,
      price: tick.price,
      open: tick.open ?? existing?.open,
      high: tick.high ?? existing?.high,
      low: tick.low ?? existing?.low,
      close: tick.close ?? existing?.close ?? tick.price,
      volume: tick.volume ?? existing?.volume,
      prevClose: tick.prevClose ?? existing?.prevClose,
      changePercent: tick.changePercent ?? existing?.changePercent,
      changeAmount: tick.changeAmount ?? existing?.changeAmount,
      tickSize: tick.tickSize ?? existing?.tickSize ?? undefined,
      volatility: tick.volatility ?? existing?.volatility,
      lastUpdated: tick.lastUpdated ?? now,
      provenance,
      marketEventTime: tick.marketEventTime ?? undefined,
      connectionEpoch: undefined,
      providerId: undefined,
      providerInstanceId: undefined,
      providerConnectionId: undefined,
      providerTransport: undefined,
      sequence: tick.sequence ?? existing?.sequence ?? undefined,
      observedAt: tick.observedAt ?? now,
      receivedAt: tick.receivedAt ?? now,
    };
    this.optionTickers.set(key, updated);
    return updated;
  }

  public getOptionTicker(contractSymbol: string): ILiveRealTicker | null {
    const key = contractSymbol.toUpperCase();
    const ticker = this.optionTickers.get(key) || null;
    if (!ticker) return null;

    if (!ticker.providerId || !ticker.providerTransport) return null;
    let activeConn: ProviderConnectionIdentity;
    try {
      activeConn = this.getCurrentProviderConnection(ticker.providerId, ticker.providerTransport);
    } catch {
      return null;
    }

    const isHealthy = ticker.providerTransport === 'WEBSOCKET_STREAM'
      ? this.isStreamExecutionHealthy(ticker.providerId)
      : this.isRestExecutionHealthy(ticker.providerId);

    if (!isHealthy) return null;

    const valResult = validateCurrentProviderExecutionQuote(ticker, {
      expectedSymbol: key,
      activeConnection: activeConn,
      isProviderHealthy: isHealthy,
    });

    if (!valResult.valid) {
      return null;
    }

    const normProviderId = normalizeCanonicalProviderId(ticker.providerId);
    const streamState = ticker.providerTransport === 'WEBSOCKET_STREAM' ? this.streamRuntimeStateMap.get(normProviderId) : null;
    const reconnectedAt = streamState?.reconnectedAt ?? null;

    const freshnessKey = `${ticker.providerTransport}:${normProviderId}:${ticker.providerConnectionId}:${key}`;
    if (reconnectedAt !== null && !this.freshSymbolsAfterReconnect.has(freshnessKey) && !this.freshSymbolsAfterReconnect.has(`OPTION:${key}`)) {
      return null;
    }

    return ticker;
  }

  public getValidatedTicker(
    symbol: string,
    maxAgeSeconds = 5,
  ): ILiveRealTicker {
    const sym = symbol.toUpperCase();
    const ticker = this.tickers.get(sym);

    if (!ticker) {
      throw new MarketDataUnavailableError(
        sym,
        'No active market data stream available for symbol',
      );
    }

    if (!ticker.providerId || !ticker.providerTransport) {
      throw new MarketDataUnavailableError(
        sym,
        'Market quote is missing authenticated providerId or providerTransport',
      );
    }
    let activeConn: ProviderConnectionIdentity;
    try {
      activeConn = this.getCurrentProviderConnection(ticker.providerId, ticker.providerTransport);
    } catch (err: any) {
      throw new MarketDataUnavailableError(
        sym,
        err.message || 'Unknown providerId or providerTransport mismatch',
      );
    }

    const isHealthy = ticker.providerTransport === 'WEBSOCKET_STREAM'
      ? this.isStreamExecutionHealthy(ticker.providerId)
      : this.isRestExecutionHealthy(ticker.providerId);

    if (!isHealthy) {
      const stateStr = ticker.providerTransport === 'WEBSOCKET_STREAM'
        ? this.streamRuntimeStateMap.get(normalizeCanonicalProviderId(ticker.providerId))?.connectionState || 'DISCONNECTED'
        : this.getRestHealthState(ticker.providerId);
      throw new MarketDataUnavailableError(
        sym,
        `Market data stream provider is in '${stateStr}' state. Trade execution blocked.`,
      );
    }

    const valResult = validateCurrentProviderExecutionQuote(ticker, {
      expectedSymbol: sym,
      activeConnection: activeConn,
      isProviderHealthy: isHealthy,
      maxAgeMs: maxAgeSeconds * 1000,
    });

    if (!valResult.valid) {
      if (valResult.errorType === 'STALE_QUOTE' || valResult.errorType === 'FUTURE_SKEW') {
        const now = Date.now();
        const ageSec = ticker.marketEventTime ? Math.abs(now - ticker.marketEventTime) / 1000 : 999;
        throw new StaleMarketDataError(
          sym,
          ageSec,
          maxAgeSeconds,
          ticker.marketEventTime ? new Date(ticker.marketEventTime) : new Date(),
        );
      }
      throw new MarketDataUnavailableError(
        sym,
        valResult.reason || 'Market quote authorization failed',
      );
    }

    const normProviderId = normalizeCanonicalProviderId(ticker.providerId);
    const streamState = ticker.providerTransport === 'WEBSOCKET_STREAM' ? this.streamRuntimeStateMap.get(normProviderId) : null;
    const reconnectedAt = streamState?.reconnectedAt ?? null;

    const freshnessKey = `${ticker.providerTransport}:${normProviderId}:${ticker.providerConnectionId}:${sym}`;
    if (
      reconnectedAt !== null &&
      !this.freshSymbolsAfterReconnect.has(freshnessKey) &&
      !this.freshSymbolsAfterReconnect.has(`SPOT:${sym}`)
    ) {
      throw new MarketDataUnavailableError(
        sym,
        `Market quote for ${sym} is a cached tick from before provider reconnection. A fresh valid tick is required after reconnection.`,
      );
    }

    return ticker;
  }

  private createValidatedOptionProviderTickFromNseStream(params: {
    contractSymbol: string;
    price: number;
    marketEventTime: number;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    volume?: number;
    prevClose?: number;
    changePercent?: number;
    changeAmount?: number;
    volatility?: number;
    tickSize?: number;
    sequence?: number;
  }): ValidatedCanonicalOptionProviderTick {
    return NSE_STREAM_OPTION_PROVIDER_ADAPTER.toCanonicalExecutionTick(
      {
        providerSymbol: params.contractSymbol,
        price: params.price,
        providerEventTime: params.marketEventTime,
        open: params.open,
        high: params.high,
        low: params.low,
        close: params.close,
        volume: params.volume,
        prevClose: params.prevClose,
        changePercent: params.changePercent,
        changeAmount: params.changeAmount,
        volatility: params.volatility,
        tickSize: params.tickSize,
        sequence: params.sequence,
      },
      this.getCurrentStreamProviderConnection('NSE_STREAM_GATEWAY'),
    );
  }

  private createValidatedOptionProviderTickFromNseRest(params: {
    contractSymbol: string;
    price: number;
    marketEventTime: number;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    volume?: number;
    prevClose?: number;
    changePercent?: number;
    changeAmount?: number;
    volatility?: number;
    tickSize?: number;
    sequence?: number;
  }): ValidatedCanonicalOptionProviderTick {
    return NSE_REST_OPTION_PROVIDER_ADAPTER.toCanonicalExecutionTick(
      {
        providerSymbol: params.contractSymbol,
        price: params.price,
        providerEventTime: params.marketEventTime,
        open: params.open,
        high: params.high,
        low: params.low,
        close: params.close,
        volume: params.volume,
        prevClose: params.prevClose,
        changePercent: params.changePercent,
        changeAmount: params.changeAmount,
        volatility: params.volatility,
        tickSize: params.tickSize,
        sequence: params.sequence,
      },
      this.getCurrentRestProviderConnection('NSE_REST_OPTION_PROVIDER'),
    );
  }

  public async publishNseStreamCanonicalOptionQuote(params: {
    contractSymbol: string;
    price: number;
    marketEventTime: number;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    volume?: number;
    prevClose?: number;
    changePercent?: number;
    changeAmount?: number;
    volatility?: number;
    tickSize?: number;
    sequence?: number;
  }): Promise<ICanonicalOptionQuoteRecord | null> {
    return this.publishCanonicalOptionQuote(this.createValidatedOptionProviderTickFromNseStream(params));
  }

  public async publishNseRestCanonicalOptionQuote(params: {
    contractSymbol: string;
    price: number;
    marketEventTime: number;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    volume?: number;
    prevClose?: number;
    changePercent?: number;
    changeAmount?: number;
    volatility?: number;
    tickSize?: number;
    sequence?: number;
  }): Promise<ICanonicalOptionQuoteRecord | null> {
    return this.publishCanonicalOptionQuote(this.createValidatedOptionProviderTickFromNseRest(params));
  }

  private async publishCanonicalOptionQuote(
    providerTick: ValidatedCanonicalOptionProviderTick,
  ): Promise<ICanonicalOptionQuoteRecord | null> {
    if (!isValidatedCanonicalOptionProviderTick(providerTick)) {
      throw new Error('Canonical option quote publication requires a validated provider-origin tick');
    }

    const params = providerTick.toRecordInput();
    if (!this.isExecutionDataHealthy(params.providerTransport, params.providerId)) {
      this.logger.warn(`Cannot publish canonical option quote for ${params?.contractSymbol || 'unknown'}: provider is in '${this.getProviderState(params.providerId, params.providerTransport)}' state`);
      return null;
    }

    if (!this.redis || typeof (this.redis as any).getClient !== 'function') return null;
    const redisClient = this.redis.getClient();
    if (!redisClient || redisClient.status !== 'ready') return null;

    const activeConnection = this.getCurrentOptionProviderConnection(params.providerId, params.providerTransport);
    // getCurrentOptionProviderConnection(params.providerId)
    if (
      params.connectionEpoch !== activeConnection.connectionEpoch ||
      params.providerInstanceId !== activeConnection.providerInstanceId ||
      params.providerConnectionId !== activeConnection.providerConnectionId
    ) {
      this.logger.warn(`Cannot publish canonical option quote for ${params.contractSymbol}: provider connection identity is not current`);
      return null;
    }

    const canonicalRecord = createCanonicalOptionQuoteRecord(providerTick);

    const key = `option:ltp:${params.contractSymbol.toUpperCase()}`;
    await redisClient.set(key, JSON.stringify(canonicalRecord), 'EX', 60);
    return canonicalRecord;
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
