import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional, forwardRef } from '@nestjs/common';
import * as crypto from 'crypto';
import { RedisService } from '../common/redis/redis.service';
import { IndianOptionsExpiryEngine } from '@quant/trading-engine';
import { TradingWebsocketGateway } from '../websocket/websocket.gateway';
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
  SUPPORTED_PERPETUAL_SYMBOLS,
  PERPETUAL_SPECS,
  perpetualVenueSymbol,
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

export interface IPerpFundingSettlement {
  fundingTime: number;
  /** Positive: longs pay shorts. */
  fundingRate: number;
  markPrice: number;
}

export interface IPerpPremiumSnapshot {
  markPrice: number;
  indexPrice: number;
  predictedFundingRate: number;
  nextFundingTime: number;
  time: number;
}

@Injectable()
export class RealMarketStreamerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealMarketStreamerService.name);
  private nseTimer: NodeJS.Timeout | null = null;
  private binanceTimer: NodeJS.Timeout | null = null;
  private microTickTimer: NodeJS.Timeout | null = null;
  private nseOptionTimer: NodeJS.Timeout | null = null;
  private nseOptionPollInFlight = false;
  private lastOptionExpiryMismatchLog = 0;

  private tickers: Map<string, ILiveRealTicker> = new Map([
    [
      'NIFTY',
      {
        symbol: 'NIFTY',
        price: 0,
        open: 0,
        high: 0,
        low: 0,
        close: 0,
        volume: 0,
        prevClose: 0,
        changePercent: 0,
        changeAmount: 0,
        tickSize: 0.05,
        volatility: 0,
        lastUpdated: 0,
        provenance: 'UNKNOWN',
      },
    ],
    [
      'BANKNIFTY',
      {
        symbol: 'BANKNIFTY',
        price: 0,
        open: 0,
        high: 0,
        low: 0,
        close: 0,
        volume: 0,
        prevClose: 0,
        changePercent: 0,
        changeAmount: 0,
        tickSize: 0.05,
        volatility: 0,
        lastUpdated: 0,
        provenance: 'UNKNOWN',
      },
    ],
    [
      'XAUUSD',
      {
        symbol: 'XAUUSD',
        price: 0,
        open: 0,
        high: 0,
        low: 0,
        close: 0,
        volume: 0,
        prevClose: 0,
        changePercent: 0,
        changeAmount: 0,
        tickSize: 0.01,
        volatility: 0,
        lastUpdated: 0,
        provenance: 'UNKNOWN',
      },
    ],
    [
      'RELIANCE',
      {
        symbol: 'RELIANCE',
        price: 0,
        open: 0,
        high: 0,
        low: 0,
        close: 0,
        volume: 0,
        prevClose: 0,
        changePercent: 0,
        changeAmount: 0,
        tickSize: 0.05,
        volatility: 0,
        lastUpdated: 0,
        provenance: 'UNKNOWN',
      },
    ],
    [
      'HDFCBANK',
      {
        symbol: 'HDFCBANK',
        price: 0,
        open: 0,
        high: 0,
        low: 0,
        close: 0,
        volume: 0,
        prevClose: 0,
        changePercent: 0,
        changeAmount: 0,
        tickSize: 0.05,
        volatility: 0,
        lastUpdated: 0,
        provenance: 'UNKNOWN',
      },
    ],
    [
      'INFY',
      {
        symbol: 'INFY',
        price: 0,
        open: 0,
        high: 0,
        low: 0,
        close: 0,
        volume: 0,
        prevClose: 0,
        changePercent: 0,
        changeAmount: 0,
        tickSize: 0.05,
        volatility: 0,
        lastUpdated: 0,
        provenance: 'UNKNOWN',
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
      await this.fetchRealBinanceFuturesPrice();
    }, 2000);

    // 2. Fetch Real NSE Indian Market Quotes every 3.5 seconds
    this.nseTimer = setInterval(async () => {
      await this.fetchRealNSEQuotes();
    }, 3500);

    // 3. Live NSE option quotes (NIFTY / BANKNIFTY) every 2 seconds
    this.nseOptionTimer = setInterval(async () => {
      await this.fetchRealNseOptionQuotes();
    }, 2000);

    // Initial fetch
    this.fetchRealBinancePrice();
    this.fetchRealNSEQuotes();
    this.fetchRealNseOptionQuotes();
  }

  /**
   * Live option quote producer for NIFTY / BANKNIFTY (NSE_REST_OPTION_PROVIDER).
   *
   * Reads the Groww option chain (exchange LTP + genuine last-trade time) and publishes each near-the-money
   * CE/PE through the validated canonical option path, which makes it available to execution
   * (getValidatedOptionPrice), the position monitor and smart-strike eligibility.
   *
   * Safety:
   * - the quote timestamp is the exchange last-trade time; the provider validator rejects ticks older than
   *   the execution max age, so stale or after-hours quotes are never published;
   * - contract symbols carry no expiry, so quotes are published ONLY when the chain's expiry is the one the
   *   contract resolver trades (the nearest expiry); otherwise nothing is published for that underlying.
   */
  private nseOptionPollPromise: Promise<void> | null = null;

  /**
   * Fetches the NSE option chains now (or joins the poll already in flight) so a caller that found an option
   * quote missing or older than its freshness limit can retry against fresh exchange data. Groww last-trade
   * times are whole seconds and 1-4s old when served, so between 2s polls a quote can cross a 5s limit.
   */
  public refreshNseOptionQuotesNow(): Promise<void> {
    return this.fetchRealNseOptionQuotes();
  }

  private fetchRealNseOptionQuotes(): Promise<void> {
    if (this.nseOptionPollPromise) return this.nseOptionPollPromise;
    this.nseOptionPollPromise = this.runNseOptionPoll().finally(() => {
      this.nseOptionPollPromise = null;
    });
    return this.nseOptionPollPromise;
  }

  private async runNseOptionPoll(): Promise<void> {
    if (this.nseOptionPollInFlight) return;
    this.nseOptionPollInFlight = true;
    const providerId = 'NSE_REST_OPTION_PROVIDER';
    try {
      const underlyings: Array<{ underlying: 'NIFTY' | 'BANKNIFTY'; slug: string; step: number }> = [
        { underlying: 'NIFTY', slug: 'nifty', step: 50 },
        { underlying: 'BANKNIFTY', slug: 'nifty-bank', step: 100 },
      ];
      let anySuccess = false;
      for (const { underlying, slug, step } of underlyings) {
        try {
          const res = await fetch(
            `https://groww.in/v1/api/option_chain_service/v1/option_chain/${slug}`,
            {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
                Accept: 'application/json',
              },
            },
          );
          if (!res.ok) continue;
          const json: any = await res.json();
          const chains: any[] = json?.optionChain?.optionChains || [];
          const chainExpiry: string | undefined = json?.optionChain?.expiryDetailsDto?.currentExpiry;
          if (chains.length === 0 || !chainExpiry) continue;
          anySuccess = true;

          const tradedExpiry = IndianOptionsExpiryEngine.getUpcomingExpiries(underlying)[0]?.dateString;
          if (!tradedExpiry || !RealMarketStreamerService.isExpiryMatch(chainExpiry, tradedExpiry)) {
            if (Date.now() - this.lastOptionExpiryMismatchLog > 60_000) {
              this.lastOptionExpiryMismatchLog = Date.now();
              this.logger.warn(
                `[OPTION_FEED] ${underlying} chain expiry ${chainExpiry} != traded expiry ${tradedExpiry}; not publishing option quotes.`,
              );
            }
            continue;
          }

          if (!this.isExecutionDataHealthy('REST_POLLING', providerId)) {
            this.setRestHealthState('HEALTHY', providerId);
          }

          const spot = this.tickers.get(underlying)?.price;
          const window = step * 15;
          for (const row of chains) {
            const rawStrike = Number(row?.strikePrice);
            const strike = rawStrike >= 500000 ? Math.round(rawStrike / 100) : Math.round(rawStrike);
            if (!strike || (spot && spot > 0 && Math.abs(strike - spot) > window)) continue;
            for (const [side, opt] of [
              ['CE', row?.callOption],
              ['PE', row?.putOption],
            ] as const) {
              const ltp = Number(opt?.ltp);
              const lastTradeSec = Number(opt?.lastTradeTime);
              if (!(ltp > 0) || !(lastTradeSec > 0)) continue;
              try {
                await this.publishNseRestCanonicalOptionQuote({
                  contractSymbol: `${underlying} ${strike} ${side}`,
                  price: ltp,
                  marketEventTime: lastTradeSec * 1000,
                  open: Number(opt.open) || undefined,
                  high: Number(opt.high) || undefined,
                  low: Number(opt.low) || undefined,
                  close: ltp,
                  volume: Number(opt.volume) || undefined,
                  prevClose: Number(opt.close) || undefined,
                  changePercent: Number(opt.dayChangePerc) || undefined,
                  changeAmount: Number(opt.dayChange) || undefined,
                  tickSize: 0.05,
                });
              } catch {
                // Stale (no recent trade) or otherwise invalid tick: never publish it.
              }
            }
          }
        } catch (err) {
          this.logger.debug(`[OPTION_FEED] ${underlying} fetch notice: ${(err as Error).message}`);
        }
      }
      if (!anySuccess && this.isExecutionDataHealthy('REST_POLLING', providerId)) {
        this.setRestHealthState('UNAVAILABLE', providerId);
      }
    } finally {
      this.nseOptionPollInFlight = false;
    }
  }

  /**
   * The exchange's chain expiry matches the engine's expiry on the same day, or up to 3 days earlier: NSE moves
   * an expiry that falls on a holiday to the previous trading day, and the engine has no holiday calendar.
   */
  private static isExpiryMatch(chainExpiry: string, engineExpiry: string): boolean {
    if (RealMarketStreamerService.isSameCalendarDay(chainExpiry, engineExpiry)) return true;
    const a = RealMarketStreamerService.toUtcDay(chainExpiry);
    const b = RealMarketStreamerService.toUtcDay(engineExpiry);
    if (a === null || b === null) return false;
    const daysEarlier = (b - a) / 86_400_000;
    return daysEarlier > 0 && daysEarlier <= 3;
  }

  private static toUtcDay(v: string): number | null {
    const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
    const dmy = v.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
    if (!dmy) return null;
    const m = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].indexOf(dmy[2].toUpperCase());
    return m < 0 ? null : Date.UTC(+dmy[3], m, +dmy[1]);
  }

  /** Compares '2026-10-06' with '06-Oct-2026' (or any two parseable dates) by calendar day. */
  private static isSameCalendarDay(a: string, b: string): boolean {
    const toYmd = (v: string): string | null => {
      const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
      if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
      const dmy = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(v);
      if (dmy) {
        const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
        const m = months.indexOf(dmy[2].toUpperCase()) + 1;
        if (m === 0) return null;
        return `${dmy[3]}-${String(m).padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
      }
      return null;
    };
    const ya = toYmd(a);
    return ya !== null && ya === toYmd(b);
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
        const ticker = this.ingestBinanceTickerData({
          ...data,
          symbol: 'BTCUSDT_SPOT',
          providerTransport: 'REST_POLLING',
        });
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

          // XAUUSD & GOLD are Spot Gold, benchmarked 1:1 to physical spot gold (PAXG)
          const goldCanonicalTick = BINANCE_REST_SPOT_PROVIDER_ADAPTER.toCanonicalExecutionTick({
            providerSymbol: 'XAUUSD',
            price: livePrice,
            providerEventTime: eventTime,
            open,
            high: Math.max(this.tickers.get('XAUUSD')?.high ?? high, high),
            low: Math.min(this.tickers.get('XAUUSD')?.low ?? low, low),
            close: livePrice,
            volume: Math.round(volume),
            prevClose: open,
            changePercent,
            changeAmount,
            tickSize: 0.01,
          });
          const goldUpdated = this.ingestCanonicalSpotTick(goldCanonicalTick);
          if (goldUpdated) {
            await this.broadcastTick(goldUpdated);
          }
        }
      }
    } catch (err) {
      this.logger.debug(`Binance real tick notice: ${(err as Error).message}`);
    }
  }

  /** Per perpetual (e.g. BTCUSDT_PERP): settled funding history (oldest first), premium snapshot, 24h stats. */
  private perpFundingHistory = new Map<string, IPerpFundingSettlement[]>();
  private perpFundingFetchedAt = new Map<string, number>();
  private perpPremium = new Map<string, IPerpPremiumSnapshot>();
  private perpStats = new Map<string, { open: number; high: number; low: number; volume: number }>();
  private perpStatsFetchedAt = 0;
  private perpPremiumFetchedAt = 0;

  /**
   * Binance USDⓈ-M perpetuals (SUPPORTED_PERPETUAL_SYMBOLS), one request per data type for all of them:
   * - execution quote: best bid/ask midpoint with its real-time transaction time (bookTicker, every poll).
   *   ticker/24hr and ticker/price are served from a cache whose timestamps are 2-7s old, so they are never
   *   used as the execution price or time;
   * - 24h statistics (display only) and mark price / predicted funding (premiumIndex): every 10s;
   * - settled funding history (fundingRate): per symbol every 5 minutes and right after a funding time.
   * Perpetuals are distinct instruments from spot and are published as <SYMBOL>_PERP only.
   */
  private async fetchRealBinanceFuturesPrice() {
    try {
      const now = Date.now();
      const venueToPerp = new Map([...SUPPORTED_PERPETUAL_SYMBOLS].map((p) => [perpetualVenueSymbol(p), p]));

      if (now - this.perpStatsFetchedAt >= 10_000) {
        this.perpStatsFetchedAt = now;
        const sRes = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
        if (sRes.ok) {
          for (const d of (await sRes.json()) as any[]) {
            const perp = venueToPerp.get(d?.symbol);
            if (perp && parseFloat(d.openPrice) > 0) {
              this.perpStats.set(perp, { open: parseFloat(d.openPrice), high: parseFloat(d.highPrice), low: parseFloat(d.lowPrice), volume: Math.round(parseFloat(d.volume)) });
            }
          }
        }
      }

      const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/bookTicker');
      if (res.ok) {
        for (const data of (await res.json()) as any[]) {
          const perp = venueToPerp.get(data?.symbol);
          if (!perp) continue;
          const eventTime = Number(data.time);
          const bid = parseFloat(data.bidPrice);
          const ask = parseFloat(data.askPrice);
          // Missing provider event time -> reject the quote rather than stamping it with the poll time
          if (!(Number.isFinite(eventTime) && eventTime > 0 && bid > 0 && ask >= bid)) continue;
          const spec = PERPETUAL_SPECS[perp];
          const decimals = Math.max(2, (spec?.pricePrecision ?? 2) + 1);
          const livePrice = Number(((bid + ask) / 2).toFixed(decimals));
          const st = this.perpStats.get(perp);
          const open = st?.open ?? livePrice;
          const canonicalTick = BINANCE_REST_SPOT_PROVIDER_ADAPTER.toCanonicalExecutionTick({
            providerSymbol: perp,
            price: livePrice,
            providerEventTime: eventTime,
            open,
            high: Math.max(st?.high ?? livePrice, livePrice),
            low: Math.min(st?.low ?? livePrice, livePrice),
            close: livePrice,
            volume: st?.volume ?? 0,
            prevClose: open,
            changePercent: open > 0 ? Number((((livePrice - open) / open) * 100).toFixed(3)) : 0,
            changeAmount: Number((livePrice - open).toFixed(decimals)),
            tickSize: spec?.tickSize ?? 0.01,
          });
          const updated = this.ingestCanonicalSpotTick(canonicalTick);
          if (updated) await this.broadcastTick(updated);
        }
      }

      if (now - this.perpPremiumFetchedAt >= 10_000) {
        this.perpPremiumFetchedAt = now;
        const pRes = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex');
        if (pRes.ok) {
          for (const p of (await pRes.json()) as any[]) {
            const perp = venueToPerp.get(p?.symbol);
            const markPrice = parseFloat(p?.markPrice);
            const time = Number(p?.time);
            if (perp && markPrice > 0 && time > 0) {
              this.perpPremium.set(perp, {
                markPrice, indexPrice: parseFloat(p.indexPrice), predictedFundingRate: parseFloat(p.lastFundingRate),
                nextFundingTime: Number(p.nextFundingTime), time,
              });
            }
          }
        }
      }

      for (const perp of SUPPORTED_PERPETUAL_SYMBOLS) {
        const history = this.perpFundingHistory.get(perp) ?? [];
        const fetchedAt = this.perpFundingFetchedAt.get(perp) ?? 0;
        const premium = this.perpPremium.get(perp);
        const lastSettled = history[history.length - 1]?.fundingTime ?? 0;
        const fundingDue = premium !== undefined && premium.nextFundingTime <= now && lastSettled < premium.nextFundingTime;
        if (!(now - fetchedAt >= 300_000 || (fundingDue && now - fetchedAt >= 15_000))) continue;
        this.perpFundingFetchedAt.set(perp, now);
        const fRes = await fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${perpetualVenueSymbol(perp)}&limit=100`);
        if (!fRes.ok) continue;
        const rows: any[] = await fRes.json();
        if (!Array.isArray(rows)) continue;
        const parsed = rows
          .map((r) => ({ fundingTime: Number(r.fundingTime), fundingRate: parseFloat(r.fundingRate), markPrice: parseFloat(r.markPrice) }))
          .filter((r) => r.fundingTime > 0 && Number.isFinite(r.fundingRate) && r.markPrice > 0)
          .sort((a, b) => a.fundingTime - b.fundingTime);
        if (parsed.length > 0) this.perpFundingHistory.set(perp, parsed);
      }
    } catch (err) {
      this.logger.debug(`Binance futures tick notice: ${(err as Error).message}`);
    }
  }

  /** Settled funding events for a perpetual (oldest first). Empty when none have been fetched yet. */
  public getPerpFundingSettlements(symbol: string): IPerpFundingSettlement[] {
    return [...(this.perpFundingHistory.get((symbol || '').toUpperCase()) ?? [])];
  }

  /** Latest mark price / predicted funding snapshot for a perpetual, or null when unavailable. */
  public getPerpPremium(symbol: string): IPerpPremiumSnapshot | null {
    return this.perpPremium.get((symbol || '').toUpperCase()) ?? null;
  }

  /**
   * NSE spot quotes. Every tick carries the provider's REAL event time: a quote is never re-stamped with the
   * poll time, so delayed data is rejected as stale instead of being presented as live.
   * - NIFTY / BANKNIFTY: Groww live index quote (value + exchange timestamp), falling back to Yahoo.
   * - Equities: Yahoo chart meta (regularMarketTime).
   * Ticks are ingested through the NSE REST spot connection (labelled NSE_YAHOO_REST for both sources).
   */
  private async fetchRealNSEQuotes() {
    const providerId = 'NSE_YAHOO_REST';
    const symbolMap: Record<string, string> = {
      NIFTY: '^NSEI',
      BANKNIFTY: '^NSEBANK',
      RELIANCE: 'RELIANCE.NS',
      HDFCBANK: 'HDFCBANK.NS',
      INFY: 'INFY.NS',
    };
    let anyFetched = false;

    for (const [sym, yahooSym] of Object.entries(symbolMap)) {
      try {
        const quote =
          (sym === 'NIFTY' || sym === 'BANKNIFTY' ? await this.fetchGrowwIndexQuote(sym) : null) ??
          (await this.fetchYahooQuote(yahooSym));
        if (!quote) continue;
        anyFetched = true;
        if (this.getRestHealthState(providerId) !== 'HEALTHY') {
          this.setRestHealthState('HEALTHY', providerId);
        }

        let canonicalTick;
        try {
          canonicalTick = NSE_YAHOO_REST_SPOT_PROVIDER_ADAPTER.toCanonicalExecutionTick({
            providerSymbol: sym,
            price: quote.price,
            providerEventTime: quote.eventTimeMs,
            open: quote.open,
            high: quote.high,
            low: quote.low,
            close: quote.price,
            volume: quote.volume,
            prevClose: quote.prevClose,
            changeAmount: quote.changeAmount,
            changePercent: quote.changePercent,
          });
        } catch {
          // Stale (e.g. market closed or delayed source) or invalid: skip THIS symbol only.
          continue;
        }

        const updated = this.ingestCanonicalSpotTick(canonicalTick);
        if (updated) {
          await this.broadcastTick(updated);
        }
      } catch (err) {
        this.logger.debug(`NSE real tick notice for ${sym}: ${(err as Error).message}`);
      }
    }

    if (!anyFetched && this.getRestHealthState(providerId) === 'HEALTHY') {
      this.setRestHealthState('UNAVAILABLE', providerId);
    }
  }

  private async fetchGrowwIndexQuote(sym: 'NIFTY' | 'BANKNIFTY'): Promise<{
    price: number;
    eventTimeMs: number;
    open?: number;
    high?: number;
    low?: number;
    volume?: number;
    prevClose?: number;
    changeAmount?: number;
    changePercent?: number;
  } | null> {
    try {
      const res = await fetch(
        `https://groww.in/v1/api/stocks_data/v1/accord_points/exchange/NSE/segment/CASH/latest_indices_ohlc/${sym}`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', Accept: 'application/json' } },
      );
      if (!res.ok) return null;
      const d: any = await res.json();
      const price = Number(d?.value);
      const rawTs = Number(d?.tsInMillis);
      if (!(price > 0) || !(rawTs > 0)) return null;
      // Despite its name, Groww reports this timestamp in seconds.
      const eventTimeMs = rawTs < 1e12 ? rawTs * 1000 : rawTs;
      return {
        price: Number(price.toFixed(2)),
        eventTimeMs,
        open: Number(d.open) || undefined,
        high: Number(d.high) || undefined,
        low: Number(d.low) || undefined,
        prevClose: Number(d.close) || undefined,
        changeAmount: Number.isFinite(Number(d.dayChange)) ? Number(Number(d.dayChange).toFixed(2)) : undefined,
        changePercent: Number.isFinite(Number(d.dayChangePerc))
          ? Number(Number(d.dayChangePerc).toFixed(2))
          : undefined,
      };
    } catch {
      return null;
    }
  }

  private async fetchYahooQuote(yahooSym: string): Promise<{
    price: number;
    eventTimeMs: number;
    open?: number;
    high?: number;
    low?: number;
    volume?: number;
    prevClose?: number;
    changeAmount?: number;
    changePercent?: number;
  } | null> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1m&range=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data: any = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || !meta.regularMarketPrice || !meta.regularMarketTime) return null;
    const price = Number(meta.regularMarketPrice.toFixed(2));
    const prevClose = Number((meta.chartPreviousClose || meta.previousClose || price).toFixed(2));
    const changeAmount = Number((price - prevClose).toFixed(2));
    return {
      price,
      // Yahoo's own quote time. Never replaced by the poll time: a delayed quote must look delayed.
      eventTimeMs: meta.regularMarketTime * 1000,
      open: Number((meta.regularMarketOpen || price).toFixed(2)),
      high: Number((meta.regularMarketDayHigh || price).toFixed(2)),
      low: Number((meta.regularMarketDayLow || price).toFixed(2)),
      volume: meta.regularMarketVolume || undefined,
      prevClose,
      changeAmount,
      changePercent: Number(((changeAmount / prevClose) * 100).toFixed(2)),
    };
  }

  public async broadcastTick(ticker: ILiveRealTicker) {
    const isPerp = ticker.symbol.endsWith('_PERP');
    const isBtc = ticker.symbol.includes('BTC') && !isPerp;
    const providerId = isPerp ? 'BINANCE_FUTURES' : isBtc ? 'BINANCE_SPOT' : (ticker.providerId || undefined);

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
      observedAt: ticker.observedAt,
      receivedAt: ticker.receivedAt,
      providerId,
      providerTransport: ticker.providerTransport || 'REST_POLLING',
      isRealMarket: true,
    };

    const redisClient = this.redis.getClient();
    if (redisClient && redisClient.status === 'ready') {
      await this.redis.set(`ticker:${ticker.symbol}:live`, JSON.stringify(ticker), 60);
      await redisClient.publish(WS_EVENTS.CANDLE_UPDATED, JSON.stringify(payload));
      if (ticker.symbol === 'BTCUSDT_SPOT') {
        await this.redis.set(`ticker:BTCUSDT:live`, JSON.stringify({ ...ticker, symbol: 'BTCUSDT' }), 60);
        await redisClient.publish(WS_EVENTS.CANDLE_UPDATED, JSON.stringify({ ...payload, symbol: 'BTCUSDT' }));
      }
      if (ticker.symbol === 'XAUUSD') {
        await this.redis.set(`ticker:GOLD:live`, JSON.stringify({ ...ticker, symbol: 'GOLD' }), 60);
        await redisClient.publish(WS_EVENTS.CANDLE_UPDATED, JSON.stringify({ ...payload, symbol: 'GOLD' }));
      }
    } else {
      this.logger.warn(
        `[REDIS_NOT_READY_TICK_BROADCAST] Redis connection not ready for tick broadcast: ${ticker.symbol}`,
      );
    }

    if (this.websocketGateway?.server) {
      try {
        this.websocketGateway.server.to(`instrument:${ticker.symbol}`).emit(WS_EVENTS.CANDLE_UPDATED, payload);
        this.websocketGateway.server.emit(WS_EVENTS.CANDLE_UPDATED, payload);
        if (ticker.symbol === 'BTCUSDT_SPOT') {
          this.websocketGateway.server.to(`instrument:BTCUSDT`).emit(WS_EVENTS.CANDLE_UPDATED, { ...payload, symbol: 'BTCUSDT' });
          this.websocketGateway.server.emit(WS_EVENTS.CANDLE_UPDATED, { ...payload, symbol: 'BTCUSDT' });
        }
        if (ticker.symbol === 'XAUUSD') {
          this.websocketGateway.server.to(`instrument:GOLD`).emit(WS_EVENTS.CANDLE_UPDATED, { ...payload, symbol: 'GOLD' });
          this.websocketGateway.server.emit(WS_EVENTS.CANDLE_UPDATED, { ...payload, symbol: 'GOLD' });
        }
      } catch (err: any) {
        this.logger.debug(`Direct websocket emit notice: ${err?.message}`);
      }
    }
  }

  /**
   * Sealed production spot tick ingestion path.
   * Only accepts branded, sealed canonical spot ticks minted by spot provider adapters.
   */
  public ingestCanonicalSpotTick(
    canonicalTick: ValidatedCanonicalSpotProviderTick,
  ): ILiveRealTicker | null {
    if (!isValidatedCanonicalSpotProviderTick(canonicalTick)) {
      throw new Error(
        '[UNBRANDED_SPOT_TICK_REJECTED] Spot tick ingestion requires a sealed canonical spot tick',
      );
    }
    const params = canonicalTick.toRecordInput();
    const rawSym = (params.symbol || (params as any).contractSymbol || '').toUpperCase();
    const sym = rawSym === 'BTCUSDT' ? 'BTCUSDT_SPOT' : rawSym;
    const existing = this.tickers.get(sym);
    const now = Date.now();

    if (existing) {
      if (
        params.sequence !== undefined &&
        existing.sequence !== undefined &&
        params.sequence < existing.sequence
      ) {
        return existing; // Sequence out of order rejection: keep higher sequence price
      }
      if (
        existing.marketEventTime &&
        params.marketEventTime < existing.marketEventTime &&
        (params.sequence === undefined || existing.sequence === undefined)
      ) {
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
    if (sym === 'BTCUSDT_SPOT') {
      this.tickers.set('BTCUSDT', { ...updated, symbol: 'BTCUSDT' });
    }
    if (sym === 'XAUUSD') {
      this.tickers.set('GOLD', { ...updated, symbol: 'GOLD' });
    } else if (sym === 'GOLD') {
      this.tickers.set('XAUUSD', { ...updated, symbol: 'XAUUSD' });
    }
    this.recordFreshSymbol(
      params.providerTransport,
      params.providerId,
      params.providerConnectionId,
      sym,
    );
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

  private streamRuntimeStateMap: Map<string, Readonly<ProviderRuntimeState>> = new Map();
  private restRuntimeStateMap: Map<string, Readonly<ProviderRuntimeState>> = new Map();

  private readonly providerInstanceId: string =
    process.env.CANONICAL_PROVIDER_INSTANCE_ID || `api-${process.pid}-${crypto.randomUUID()}`;

  constructor(
    private readonly redis: RedisService,
    @Optional()
    @Inject(forwardRef(() => TradingWebsocketGateway))
    private readonly websocketGateway?: TradingWebsocketGateway,
  ) {
    this.initProviderConnections();
  }

  private initProviderConnections(): void {
    // 1. NSE_STREAM_GATEWAY
    const nseConn = NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection({
      providerInstanceId: this.providerInstanceId,
    });
    NSE_STREAM_SPOT_PROVIDER_ADAPTER.beginProviderConnection({ existingConnection: nseConn });
    this.installInitialProviderConnection('NSE_STREAM_GATEWAY', 'WEBSOCKET_STREAM', nseConn);

    // 2. BINANCE_DIRECT
    const binanceConn = BINANCE_SPOT_PROVIDER_ADAPTER.beginProviderConnection({
      providerInstanceId: this.providerInstanceId,
    });
    BINANCE_OPTION_PROVIDER_ADAPTER.beginProviderConnection({ existingConnection: binanceConn });
    this.installInitialProviderConnection('BINANCE_DIRECT', 'WEBSOCKET_STREAM', binanceConn);

    // REST Providers
    const nseRestConn = NSE_REST_OPTION_PROVIDER_ADAPTER.beginProviderConnection({
      providerInstanceId: this.providerInstanceId,
    });
    this.installInitialProviderConnection('NSE_REST_OPTION_PROVIDER', 'REST_POLLING', nseRestConn);

    const yahooRestConn = NSE_YAHOO_REST_PROVIDER_ADAPTER.beginProviderConnection({
      providerInstanceId: this.providerInstanceId,
    });
    NSE_YAHOO_REST_SPOT_PROVIDER_ADAPTER.beginProviderConnection({
      existingConnection: yahooRestConn,
    });
    this.installInitialProviderConnection('NSE_YAHOO_REST', 'REST_POLLING', yahooRestConn);

    const binanceRestConn = BINANCE_REST_PROVIDER_ADAPTER.beginProviderConnection({
      providerInstanceId: this.providerInstanceId,
    });
    BINANCE_REST_SPOT_PROVIDER_ADAPTER.beginProviderConnection({
      existingConnection: binanceRestConn,
    });
    this.installInitialProviderConnection('BINANCE_REST', 'REST_POLLING', binanceRestConn);
  }

  // Structured Map: transport -> normId -> connectionId -> Set<symbol>
  private freshnessStore = new Map<
    'WEBSOCKET_STREAM' | 'REST_POLLING',
    Map<string, Map<string, Set<string>>>
  >();

  private recordFreshSymbol(
    providerTransport: 'WEBSOCKET_STREAM' | 'REST_POLLING' | string | undefined,
    providerId: string | undefined,
    connectionId: string | undefined,
    symbol: string,
  ): void {
    if (!providerTransport || !providerId || !connectionId || !symbol) return;
    if (providerTransport !== 'WEBSOCKET_STREAM' && providerTransport !== 'REST_POLLING') return;
    const normId = normalizeCanonicalProviderId(providerId);

    let transportMap = this.freshnessStore.get(providerTransport);
    if (!transportMap) {
      transportMap = new Map();
      this.freshnessStore.set(providerTransport, transportMap);
    }
    let providerMap = transportMap.get(normId);
    if (!providerMap) {
      providerMap = new Map();
      transportMap.set(normId, providerMap);
    }
    let connSet = providerMap.get(connectionId);
    if (!connSet) {
      connSet = new Set();
      providerMap.set(connectionId, connSet);
    }
    connSet.add(symbol.toUpperCase());
  }

  private isFreshSymbolPresent(
    providerTransport: 'WEBSOCKET_STREAM' | 'REST_POLLING' | string | undefined,
    providerId: string | undefined,
    connectionId: string | undefined,
    symbol: string,
  ): boolean {
    if (!providerTransport || !providerId || !connectionId || !symbol) return false;
    if (providerTransport !== 'WEBSOCKET_STREAM' && providerTransport !== 'REST_POLLING')
      return false;
    const normId = normalizeCanonicalProviderId(providerId);
    return (
      this.freshnessStore
        .get(providerTransport)
        ?.get(normId)
        ?.get(connectionId)
        ?.has(symbol.toUpperCase()) ?? false
    );
  }

  private purgeFreshnessForConnection(
    providerTransport: 'WEBSOCKET_STREAM' | 'REST_POLLING',
    providerId: string,
    connectionId: string,
  ): void {
    if (!providerTransport || !providerId || !connectionId) return;
    const normId = normalizeCanonicalProviderId(providerId);
    this.freshnessStore.get(providerTransport)?.get(normId)?.delete(connectionId);
  }

  private purgeFreshnessForProvider(
    providerTransport: 'WEBSOCKET_STREAM' | 'REST_POLLING',
    providerId: string,
  ): void {
    if (!providerTransport || !providerId) return;
    const normId = normalizeCanonicalProviderId(providerId);
    this.freshnessStore.get(providerTransport)?.get(normId)?.clear();
  }

  public resolveCurrentProviderRuntime(
    providerId: string,
    providerTransport: 'WEBSOCKET_STREAM' | 'REST_POLLING',
  ): Readonly<ProviderRuntimeState> {
    if (!providerId || typeof providerId !== 'string' || providerId.trim().length === 0) {
      throw new Error('[UNKNOWN_PROVIDER_ID_REJECTED] providerId is required');
    }
    const normId = normalizeCanonicalProviderId(providerId);

    if (
      !providerTransport ||
      (providerTransport !== 'WEBSOCKET_STREAM' && providerTransport !== 'REST_POLLING')
    ) {
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
      reconnectedAt?: number | null;
    },
  ): Readonly<ProviderRuntimeState> {
    const existing = this.resolveCurrentProviderRuntime(providerId, providerTransport);
    const map =
      providerTransport === 'WEBSOCKET_STREAM'
        ? this.streamRuntimeStateMap
        : this.restRuntimeStateMap;
    const normId = normalizeCanonicalProviderId(providerId);

    const frozenState: Readonly<ProviderRuntimeState> = Object.freeze({
      providerId: existing.providerId,
      providerTransport: existing.providerTransport,
      connectionState: updates.connectionState ?? existing.connectionState,
      providerConnected: updates.providerConnected ?? existing.providerConnected,
      currentConnection: existing.currentConnection,
      reconnectedAt:
        updates.reconnectedAt !== undefined ? updates.reconnectedAt : existing.reconnectedAt,
    });

    map.set(normId, frozenState);
    return frozenState;
  }

  private installInitialProviderConnection(
    providerId: string,
    providerTransport: 'WEBSOCKET_STREAM' | 'REST_POLLING',
    connection: ProviderConnectionIdentity,
  ): Readonly<ProviderRuntimeState> {
    if (!isProviderConnectionIdentity(connection)) {
      throw new Error(
        '[INVALID_SHARED_CONNECTION_IDENTITY] connection must be a branded ProviderConnectionIdentity',
      );
    }
    const normId = normalizeCanonicalProviderId(providerId);
    const connNormId = normalizeCanonicalProviderId(connection.providerId);
    if (normId !== connNormId) {
      throw new Error(
        `[PROVIDER_TRANSPORT_MISMATCH] Connection providerId '${connection.providerId}' (canonical: '${connNormId}') does not match target '${normId}'`,
      );
    }
    if (providerTransport !== connection.providerTransport) {
      throw new Error(
        `[PROVIDER_TRANSPORT_MISMATCH] Connection providerTransport '${connection.providerTransport}' does not match target '${providerTransport}'`,
      );
    }
    if (connection.providerInstanceId !== this.providerInstanceId) {
      throw new Error(
        `[INVALID_SHARED_CONNECTION_IDENTITY] Connection providerInstanceId '${connection.providerInstanceId}' does not match streamer instance '${this.providerInstanceId}'`,
      );
    }

    const map =
      providerTransport === 'WEBSOCKET_STREAM'
        ? this.streamRuntimeStateMap
        : this.restRuntimeStateMap;
    if (map.has(normId)) {
      throw new Error(
        `[INITIAL_PROVIDER_RUNTIME_ALREADY_EXISTS] Cannot install initial connection: provider runtime for '${normId}' (${providerTransport}) already exists`,
      );
    }

    const initialRuntime: Readonly<ProviderRuntimeState> = Object.freeze({
      providerId: normId,
      providerTransport,
      connectionState: 'CONNECTED',
      providerConnected: true,
      currentConnection: connection,
      reconnectedAt: null,
    });
    map.set(normId, initialRuntime);
    return initialRuntime;
  }

  private createStreamProviderConnection(
    providerId: string,
    options?: { existingConnection?: ProviderConnectionIdentity },
  ): ProviderConnectionIdentity {
    if (!providerId) throw new Error('[UNKNOWN_PROVIDER_ID_REJECTED] providerId is required');
    const normId = normalizeCanonicalProviderId(providerId);
    if (normId !== 'NSE_STREAM_GATEWAY' && normId !== 'BINANCE_DIRECT') {
      throw new Error(
        `[UNKNOWN_PROVIDER_ID_REJECTED] Cannot begin stream connection for unknown provider '${providerId}'`,
      );
    }

    if (options?.existingConnection) {
      const existing = options.existingConnection;
      if (!isProviderConnectionIdentity(existing)) {
        throw new Error(
          '[INVALID_SHARED_CONNECTION_IDENTITY] existingConnection must be a branded ProviderConnectionIdentity',
        );
      }
      const existingNormId = normalizeCanonicalProviderId(existing.providerId);
      if (
        existingNormId !== normId ||
        existing.providerTransport !== 'WEBSOCKET_STREAM' ||
        existing.providerInstanceId !== this.providerInstanceId
      ) {
        throw new Error(
          `[INVALID_SHARED_CONNECTION_IDENTITY] Existing connection providerId '${existing.providerId}' or transport '${existing.providerTransport}' does not match target stream provider '${normId}'`,
        );
      }
    }

    if (normId === 'BINANCE_DIRECT') {
      const conn = BINANCE_SPOT_PROVIDER_ADAPTER.beginProviderConnection({
        providerInstanceId: this.providerInstanceId,
        existingConnection: options?.existingConnection,
      });
      BINANCE_OPTION_PROVIDER_ADAPTER.beginProviderConnection({ existingConnection: conn });
      return conn;
    } else {
      const conn = NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection({
        providerInstanceId: this.providerInstanceId,
        existingConnection: options?.existingConnection,
      });
      NSE_STREAM_SPOT_PROVIDER_ADAPTER.beginProviderConnection({ existingConnection: conn });
      return conn;
    }
  }

  private createRestProviderConnection(
    providerId: string,
    options?: { existingConnection?: ProviderConnectionIdentity },
  ): ProviderConnectionIdentity {
    if (!providerId) throw new Error('[UNKNOWN_PROVIDER_ID_REJECTED] providerId is required');
    const normId = normalizeCanonicalProviderId(providerId);

    if (options?.existingConnection) {
      const existing = options.existingConnection;
      if (!isProviderConnectionIdentity(existing)) {
        throw new Error(
          '[INVALID_SHARED_CONNECTION_IDENTITY] existingConnection must be a branded ProviderConnectionIdentity',
        );
      }
      const existingNormId = normalizeCanonicalProviderId(existing.providerId);
      if (
        existingNormId !== normId ||
        existing.providerTransport !== 'REST_POLLING' ||
        existing.providerInstanceId !== this.providerInstanceId
      ) {
        throw new Error(
          `[INVALID_SHARED_CONNECTION_IDENTITY] Existing connection providerId '${existing.providerId}' or transport '${existing.providerTransport}' does not match target REST provider '${normId}'`,
        );
      }
    }

    if (normId === 'BINANCE_REST') {
      const conn = BINANCE_REST_PROVIDER_ADAPTER.beginProviderConnection({
        providerInstanceId: this.providerInstanceId,
        existingConnection: options?.existingConnection,
      });
      BINANCE_REST_SPOT_PROVIDER_ADAPTER.beginProviderConnection({ existingConnection: conn });
      return conn;
    } else if (normId === 'NSE_YAHOO_REST') {
      const conn = NSE_YAHOO_REST_PROVIDER_ADAPTER.beginProviderConnection({
        providerInstanceId: this.providerInstanceId,
        existingConnection: options?.existingConnection,
      });
      NSE_YAHOO_REST_SPOT_PROVIDER_ADAPTER.beginProviderConnection({ existingConnection: conn });
      return conn;
    } else if (normId === 'NSE_REST_OPTION_PROVIDER') {
      return NSE_REST_OPTION_PROVIDER_ADAPTER.beginProviderConnection({
        providerInstanceId: this.providerInstanceId,
        existingConnection: options?.existingConnection,
      });
    } else {
      throw new Error(
        `[UNKNOWN_PROVIDER_ID_REJECTED] Cannot begin REST connection for unknown provider '${providerId}'`,
      );
    }
  }

  private rotateProviderRuntime(
    providerId: string,
    providerTransport: 'WEBSOCKET_STREAM' | 'REST_POLLING',
    updates?: {
      connectionState?: ProviderConnectionState;
      providerConnected?: boolean;
      reconnectedAt?: number | null;
    },
  ): Readonly<ProviderRuntimeState> {
    const existing = this.resolveCurrentProviderRuntime(providerId, providerTransport);
    const oldConnection = existing.currentConnection;
    const normId = normalizeCanonicalProviderId(providerId);

    // 1. Mint new connection directly from adapter (pure helper, no map side-effects during minting)
    let newConnection: ProviderConnectionIdentity;
    if (providerTransport === 'WEBSOCKET_STREAM') {
      newConnection = this.createStreamProviderConnection(normId);
    } else {
      newConnection = this.createRestProviderConnection(normId);
    }

    // 2. Validate new connection identity
    if (!isProviderConnectionIdentity(newConnection)) {
      throw new Error(
        '[INVALID_SHARED_CONNECTION_IDENTITY] newConnection must be a branded ProviderConnectionIdentity',
      );
    }
    const connNormId = normalizeCanonicalProviderId(newConnection.providerId);
    if (normId !== connNormId) {
      throw new Error(
        `[PROVIDER_TRANSPORT_MISMATCH] Connection providerId '${newConnection.providerId}' (canonical: '${connNormId}') does not match target '${normId}'`,
      );
    }
    if (providerTransport !== newConnection.providerTransport) {
      throw new Error(
        `[PROVIDER_TRANSPORT_MISMATCH] Connection providerTransport '${newConnection.providerTransport}' does not match target '${providerTransport}'`,
      );
    }
    if (newConnection.providerInstanceId !== this.providerInstanceId) {
      throw new Error(
        `[INVALID_SHARED_CONNECTION_IDENTITY] Connection providerInstanceId '${newConnection.providerInstanceId}' does not match streamer instance '${this.providerInstanceId}'`,
      );
    }

    // 3. Validate rotation invariants
    if (newConnection.connectionEpoch <= oldConnection.connectionEpoch) {
      throw new Error(
        `[INVALID_CONNECTION_ROTATION] New connection epoch ${newConnection.connectionEpoch} must be strictly greater than old epoch ${oldConnection.connectionEpoch}`,
      );
    }
    if (newConnection.providerConnectionId === oldConnection.providerConnectionId) {
      throw new Error(
        `[INVALID_CONNECTION_ROTATION] New providerConnectionId '${newConnection.providerConnectionId}' must differ from old connection ID '${oldConnection.providerConnectionId}'`,
      );
    }

    // 4. Construct ONE next immutable ProviderRuntimeState snapshot
    const nextRuntime: Readonly<ProviderRuntimeState> = Object.freeze({
      providerId: normId,
      providerTransport,
      connectionState: updates?.connectionState ?? 'CONNECTED',
      providerConnected: updates?.providerConnected ?? true,
      currentConnection: newConnection,
      reconnectedAt: updates?.reconnectedAt !== undefined ? updates.reconnectedAt : Date.now(),
    });

    // 5. Replace runtime Map entry exactly once
    const map =
      providerTransport === 'WEBSOCKET_STREAM'
        ? this.streamRuntimeStateMap
        : this.restRuntimeStateMap;
    map.set(normId, nextRuntime);

    // 6. Purge freshness strictly for the old connection ID AFTER successful runtime replacement
    this.purgeFreshnessForConnection(providerTransport, normId, oldConnection.providerConnectionId);

    return nextRuntime;
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
    if (
      runtime.providerConnected &&
      (runtime.connectionState === 'CONNECTED' || runtime.connectionState === 'RECONNECTED')
    ) {
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
      if (wasUnhealthy) {
        this.rotateProviderRuntime(normId, 'REST_POLLING', {
          connectionState: 'CONNECTED',
          providerConnected: true,
          reconnectedAt: null,
        });
      } else {
        this.transitionProviderRuntime(normId, 'REST_POLLING', {
          connectionState: 'CONNECTED',
          providerConnected: true,
        });
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
      throw new Error(
        '[PROVIDER_TRANSPORT_MISMATCH] BOTH providerTransport AND providerId are required for isExecutionDataHealthy',
      );
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

  public handleStreamProviderDisconnect(providerId: string, reason?: string): void {
    if (!providerId) throw new Error('[UNKNOWN_PROVIDER_ID_REJECTED] providerId is required');
    const normId = normalizeCanonicalProviderId(providerId);
    const state = this.resolveCurrentProviderRuntime(normId, 'WEBSOCKET_STREAM');
    if (state.providerConnected || state.connectionState !== 'DISCONNECTED') {
      this.logger.warn(
        `Market data stream provider '${normId}' disconnected: ${reason || 'Connection lost'}`,
      );
    }
    this.transitionProviderRuntime(normId, 'WEBSOCKET_STREAM', {
      connectionState: 'DISCONNECTED',
      providerConnected: false,
    });
    this.purgeFreshnessForProvider('WEBSOCKET_STREAM', normId);
  }

  public handleStreamProviderReconnecting(providerId: string): void {
    if (!providerId) throw new Error('[UNKNOWN_PROVIDER_ID_REJECTED] providerId is required');
    const normId = normalizeCanonicalProviderId(providerId);
    this.resolveCurrentProviderRuntime(normId, 'WEBSOCKET_STREAM');
    this.transitionProviderRuntime(normId, 'WEBSOCKET_STREAM', {
      connectionState: 'RECONNECTING',
      providerConnected: false,
    });
    this.purgeFreshnessForProvider('WEBSOCKET_STREAM', normId);
  }

  public handleStreamProviderReconnect(providerId: string): void {
    if (!providerId) throw new Error('[UNKNOWN_PROVIDER_ID_REJECTED] providerId is required');
    const normId = normalizeCanonicalProviderId(providerId);
    const state = this.resolveCurrentProviderRuntime(normId, 'WEBSOCKET_STREAM');
    const wasNotConnected =
      !state.providerConnected ||
      (state.connectionState !== 'CONNECTED' && state.connectionState !== 'RECONNECTED');
    if (wasNotConnected) {
      // Single atomic rotation & lifecycle snapshot replacement
      this.rotateProviderRuntime(normId, 'WEBSOCKET_STREAM', {
        connectionState: 'RECONNECTED',
        providerConnected: true,
        reconnectedAt: Date.now(),
      });
      this.logger.log(
        `Market data stream provider '${normId}' reconnected. New stream connection epoch assigned.`,
      );
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

    const rawSym = (data.symbol || data.s || 'BTCUSDT_SPOT').toUpperCase();
    const sym = rawSym === 'BTC' || rawSym === 'BTCUSDT' || rawSym === 'BTCUSDT_SPOT' ? 'BTCUSDT_SPOT' : rawSym;
    const existing = this.tickers.get(sym) || this.tickers.get('BTCUSDT');

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

    const markDegraded = () => {
      if (existing) {
        existing.provenance = 'DEGRADED';
      }
      if (sym === 'BTCUSDT_SPOT' || sym === 'BTCUSDT' || sym === 'BTC') {
        const spot = this.tickers.get('BTCUSDT_SPOT');
        if (spot) spot.provenance = 'DEGRADED';
        const usdt = this.tickers.get('BTCUSDT');
        if (usdt) usdt.provenance = 'DEGRADED';
      }
      if (sym === 'GOLD' || sym === 'XAUUSD') {
        const gold = this.tickers.get('GOLD');
        if (gold) gold.provenance = 'DEGRADED';
        const xau = this.tickers.get('XAUUSD');
        if (xau) xau.provenance = 'DEGRADED';
      }
    };

    if (!Number.isFinite(marketEventTime) || marketEventTime <= 0) {
      markDegraded();
      return null;
    }

    const now = Date.now();
    const maxClockSkewMs = 5000;
    if (marketEventTime > now + maxClockSkewMs) {
      markDegraded();
      return null;
    }

    const rawProvenance = data.provenance;
    if (rawProvenance && rawProvenance !== 'LIVE_PROVIDER') {
      markDegraded();
      return null;
    }

    const rawPrice = data.lastPrice ?? data.c ?? data.price;
    const livePrice = rawPrice !== undefined && rawPrice !== null ? parseFloat(rawPrice) : NaN;
    if (!Number.isFinite(livePrice) || livePrice <= 0) {
      markDegraded();
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
    const changePercent =
      rawChangePct !== undefined && rawChangePct !== null ? parseFloat(rawChangePct) : NaN;
    const rawChangeAmt = data.priceChange ?? data.p;
    const changeAmount =
      rawChangeAmt !== undefined && rawChangeAmt !== null ? parseFloat(rawChangeAmt) : NaN;

    let tickSize: number | undefined = undefined;
    try {
      const inst = getAuthoritativeInstrument(sym);
      if (inst && inst.tickSize) tickSize = inst.tickSize;
    } catch {}

    const isStream = data.providerTransport ? data.providerTransport === 'WEBSOCKET_STREAM' : true;
    const adapter = isStream ? BINANCE_SPOT_PROVIDER_ADAPTER : BINANCE_REST_SPOT_PROVIDER_ADAPTER;
    const activeConn = isStream
      ? this.getCurrentProviderConnection('BINANCE_DIRECT', 'WEBSOCKET_STREAM')
      : this.getCurrentProviderConnection('BINANCE_REST', 'REST_POLLING');

    const canonicalTick = adapter.toCanonicalExecutionTick(
      {
        providerSymbol: sym === 'BTCUSDT_SPOT' ? 'BTCUSDT' : sym,
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

    const isHealthy =
      ticker.providerTransport === 'WEBSOCKET_STREAM'
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
    const streamState =
      ticker.providerTransport === 'WEBSOCKET_STREAM'
        ? this.streamRuntimeStateMap.get(normProviderId)
        : null;
    const reconnectedAt = streamState?.reconnectedAt ?? null;

    if (
      reconnectedAt !== null &&
      !this.isFreshSymbolPresent(
        ticker.providerTransport,
        ticker.providerId,
        ticker.providerConnectionId,
        key,
      )
    ) {
      return null;
    }

    return ticker;
  }

  public getValidatedTicker(symbol: string, maxAgeSeconds = 5): ILiveRealTicker {
    const rawSym = symbol.toUpperCase();
    const isBtc = rawSym === 'BTC' || rawSym === 'BTCUSDT' || rawSym === 'BTCUSDT_SPOT';
    const isGold = rawSym === 'XAUUSD' || rawSym === 'GOLD';
    const sym = isBtc ? 'BTCUSDT_SPOT' : rawSym;
    let ticker = this.tickers.get(sym);
    if (!ticker && isBtc) {
      ticker = this.tickers.get('BTCUSDT_SPOT') || this.tickers.get('BTCUSDT');
    }
    if (!ticker && isGold) {
      ticker = this.tickers.get('XAUUSD') || this.tickers.get('GOLD');
    }

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

    const isHealthy =
      ticker.providerTransport === 'WEBSOCKET_STREAM'
        ? this.isStreamExecutionHealthy(ticker.providerId)
        : this.isRestExecutionHealthy(ticker.providerId);

    if (!isHealthy) {
      const stateStr =
        ticker.providerTransport === 'WEBSOCKET_STREAM'
          ? this.streamRuntimeStateMap.get(normalizeCanonicalProviderId(ticker.providerId))
              ?.connectionState || 'DISCONNECTED'
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
    const streamState =
      ticker.providerTransport === 'WEBSOCKET_STREAM'
        ? this.streamRuntimeStateMap.get(normProviderId)
        : null;
    const reconnectedAt = streamState?.reconnectedAt ?? null;

    if (
      reconnectedAt !== null &&
      !this.isFreshSymbolPresent(
        ticker.providerTransport,
        ticker.providerId,
        ticker.providerConnectionId,
        sym,
      )
    ) {
      throw new MarketDataUnavailableError(
        sym,
        `Market quote for ${sym} is a cached tick from before provider reconnection. A fresh valid tick is required after reconnection.`,
      );
    }

    return ticker;
  }

  public getAuthoritativeSnapshot(symbol: string): {
    symbol: string;
    price: number;
    marketEventTime: string;
    observedAt: string;
    receivedAt: string;
    provenance: QuoteProvenance;
    providerId: string;
    providerTransport: string;
    isFresh: boolean;
  } {
    const rawSym = symbol.toUpperCase();
    const isBtc = rawSym === 'BTC' || rawSym === 'BTCUSDT' || rawSym === 'BTCUSDT_SPOT';
    const isGold = rawSym === 'XAUUSD' || rawSym === 'GOLD';
    const sym = isBtc ? 'BTCUSDT_SPOT' : rawSym;
    let ticker = isBtc
      ? (this.tickers.get('BTCUSDT_SPOT') || this.tickers.get('BTCUSDT'))
      : this.tickers.get(sym);
    if (!ticker && isGold) {
      ticker = this.tickers.get('XAUUSD') || this.tickers.get('GOLD');
    }

    if (!ticker || ticker.price <= 0 || ticker.provenance !== 'LIVE_PROVIDER') {
      throw new MarketDataUnavailableError(
        sym,
        `No fresh live market data available for ${sym}. Bootstrap or placeholder prices are strictly prohibited.`,
      );
    }

    const now = Date.now();
    const eventTime = ticker.marketEventTime || ticker.lastUpdated;
    const isFresh = Boolean(eventTime && now - eventTime <= 5000 && eventTime <= now + 5000);

    let providerId = ticker.providerId || 'BINANCE_SPOT';
    if (sym.endsWith('_PERP')) {
      providerId = 'BINANCE_FUTURES';
    } else if (sym === 'BTCUSDT_SPOT' || sym === 'BTCUSDT' || providerId === 'BINANCE_REST' || providerId === 'BINANCE_DIRECT') {
      providerId = 'BINANCE_SPOT';
    }

    return {
      symbol: sym === 'BTCUSDT' ? 'BTCUSDT_SPOT' : sym,
      price: ticker.price,
      marketEventTime: eventTime ? new Date(eventTime).toISOString() : new Date().toISOString(),
      observedAt: ticker.observedAt ? new Date(ticker.observedAt).toISOString() : new Date().toISOString(),
      receivedAt: ticker.receivedAt ? new Date(ticker.receivedAt).toISOString() : new Date().toISOString(),
      provenance: ticker.provenance,
      providerId,
      providerTransport: ticker.providerTransport || 'REST_POLLING',
      isFresh,
    };
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
    return this.publishCanonicalOptionQuote(
      this.createValidatedOptionProviderTickFromNseStream(params),
    );
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
    return this.publishCanonicalOptionQuote(
      this.createValidatedOptionProviderTickFromNseRest(params),
    );
  }

  private async publishCanonicalOptionQuote(
    providerTick: ValidatedCanonicalOptionProviderTick,
  ): Promise<ICanonicalOptionQuoteRecord | null> {
    if (!isValidatedCanonicalOptionProviderTick(providerTick)) {
      throw new Error(
        'Canonical option quote publication requires a validated provider-origin tick',
      );
    }

    const params = providerTick.toRecordInput();
    if (!this.isExecutionDataHealthy(params.providerTransport, params.providerId)) {
      this.logger.warn(
        `Cannot publish canonical option quote for ${params?.contractSymbol || 'unknown'}: provider is in '${this.getProviderState(params.providerId, params.providerTransport)}' state`,
      );
      return null;
    }

    if (!this.redis || typeof (this.redis as any).getClient !== 'function') return null;
    const redisClient = this.redis.getClient();
    if (!redisClient || redisClient.status !== 'ready') return null;

    // prettier-ignore
    const activeConnection = this.getCurrentOptionProviderConnection(params.providerId, params.providerTransport);
    if (
      params.connectionEpoch !== activeConnection.connectionEpoch ||
      params.providerInstanceId !== activeConnection.providerInstanceId ||
      params.providerConnectionId !== activeConnection.providerConnectionId
    ) {
      this.logger.warn(
        `Cannot publish canonical option quote for ${params.contractSymbol}: provider connection identity is not current`,
      );
      return null;
    }

    const canonicalRecord = createCanonicalOptionQuoteRecord(providerTick);

    const key = `option:ltp:${params.contractSymbol.toUpperCase()}`;
    await redisClient.set(key, JSON.stringify(canonicalRecord), 'EX', 60);

    const now = Date.now();
    const updatedTicker: ILiveRealTicker = {
      symbol: params.contractSymbol.toUpperCase(),
      price: params.price,
      open: params.open,
      high: params.high,
      low: params.low,
      close: params.close ?? params.price,
      volume: params.volume,
      prevClose: params.prevClose,
      changePercent: params.changePercent,
      changeAmount: params.changeAmount,
      tickSize: params.tickSize,
      volatility: params.volatility,
      lastUpdated: params.marketEventTime || now,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: params.marketEventTime || now,
      connectionEpoch: params.connectionEpoch,
      providerId: params.providerId,
      providerInstanceId: params.providerInstanceId,
      providerConnectionId: params.providerConnectionId,
      providerTransport: params.providerTransport,
      sequence: params.sequence,
      observedAt: params.observedAt ?? now,
      receivedAt: params.receivedAt ?? now,
    };
    this.optionTickers.set(params.contractSymbol.toUpperCase(), updatedTicker);

    return canonicalRecord;
  }

  getAllTickers() {
    return Array.from(this.tickers.values());
  }

  onModuleDestroy() {
    if (this.binanceTimer) clearInterval(this.binanceTimer);
    if (this.nseTimer) clearInterval(this.nseTimer);
    if (this.microTickTimer) clearInterval(this.microTickTimer);
    if (this.nseOptionTimer) clearInterval(this.nseOptionTimer);
  }
}
