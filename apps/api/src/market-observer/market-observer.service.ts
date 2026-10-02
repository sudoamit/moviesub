import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PaperTradingService } from '../paper-trading/paper-trading.service';
import { parseGrowwChain, summarizeOptionChain } from './option-chain-metrics';
import { NEWS_ASSETS, NEWS_FEEDS, NEWS_SCORE_MODEL, parseRss, scoreHeadlines } from './news-feed';
import { evaluateInput, FeaturePoint, Insight, newsSentimentSeries, PricePoint } from './observer-learning';

const MIN = 60_000;
/** Observed assets and the symbol their live price comes from. */
const PRICE_SYMBOLS: Record<string, string> = {
  NIFTY: 'NIFTY',
  BANKNIFTY: 'BANKNIFTY',
  BTC: 'BTCUSDT_PERP',
  ETH: 'ETHUSDT_PERP',
  GOLD: 'XAUUSD',
};
const OPTION_CHAINS = [
  { asset: 'NIFTY', slug: 'nifty' },
  { asset: 'BANKNIFTY', slug: 'nifty-bank' },
];
const OPTION_INPUTS = ['pcrOi', 'pcrVolume', 'oiChangeTilt', 'maxPainDistPct', 'callWallDistPct', 'putWallDistPct', 'atmIv', 'ivSkew'];
const VOL_INPUTS = ['dvol', 'fundingRate'];
const NEWS_MAX_AGE_MS = 3 * 86_400_000;

/** NSE cash session (09:15-15:30 IST), Monday-Friday. */
export function isNseSession(nowMs: number): boolean {
  const d = new Date(nowMs);
  const day = d.getUTCDay();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return day >= 1 && day <= 5 && mins >= 3 * 60 + 45 && mins <= 10 * 60;
}

/**
 * Market observer: records what the market shows besides price - option chains (NIFTY / BANKNIFTY open interest,
 * put/call ratio, max pain, implied volatility), crypto implied volatility (Deribit DVOL) and funding, and news
 * headlines scored by Claude - and measures which of these have predicted price moves (see observer-learning).
 */
@Injectable()
export class MarketObserverService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketObserverService.name);
  private timers: NodeJS.Timeout[] = [];
  private busy = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly paper: PaperTradingService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.OBSERVER_ENABLED === 'false') return;
    const every = (name: string, ms: number, fn: () => Promise<unknown>) => {
      const run = () => this.once(name, fn);
      this.timers.push(setInterval(run, ms));
      setTimeout(run, 20_000);
    };
    every('prices', 5 * MIN, () => this.recordPrices());
    every('options', 5 * MIN, () => this.recordOptionChains());
    every('volatility', 15 * MIN, () => this.recordCryptoVolatility());
    every('news', 10 * MIN, async () => { await this.pollNews(); await this.scoreNews(); });
  }

  onModuleDestroy() {
    this.timers.forEach(clearInterval);
  }

  private async once(name: string, fn: () => Promise<unknown>) {
    if (this.busy.has(name)) return;
    this.busy.add(name);
    try {
      await fn();
    } catch (e: any) {
      this.logger.warn(`[OBSERVER] ${name}: ${e.message}`);
    } finally {
      this.busy.delete(name);
    }
  }

  private async livePrice(asset: string): Promise<number | null> {
    try {
      const q = await this.paper.getValidatedMarketPrice(PRICE_SYMBOLS[asset], 60);
      return q.price > 0 ? q.price : null;
    } catch {
      return null; // stale / closed market: no observation
    }
  }

  async recordPrices(): Promise<number> {
    const nse = isNseSession(Date.now());
    let n = 0;
    for (const asset of Object.keys(PRICE_SYMBOLS)) {
      if ((asset === 'NIFTY' || asset === 'BANKNIFTY') && !nse) continue;
      const price = await this.livePrice(asset);
      if (!price) continue;
      await this.prisma.marketObservation.create({ data: { asset, kind: 'PRICE', price, metrics: {} } });
      n++;
    }
    return n;
  }

  async recordOptionChains(): Promise<number> {
    if (!isNseSession(Date.now())) return 0;
    let n = 0;
    for (const { asset, slug } of OPTION_CHAINS) {
      const spot = await this.livePrice(asset);
      if (!spot) continue;
      const res = await fetch(`https://groww.in/v1/api/option_chain_service/v1/option_chain/${slug}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', Accept: 'application/json' },
      });
      if (!res.ok) continue;
      const { expiry, strikes } = parseGrowwChain(await res.json());
      if (!expiry) continue;
      const [y, m, d] = expiry.split('-').map(Number);
      const metrics = summarizeOptionChain(strikes, spot, Date.UTC(y, m - 1, d, 10, 0), Date.now());
      if (!metrics) continue;
      const totalOi = metrics.totalCallOi + metrics.totalPutOi;
      await this.prisma.marketObservation.create({
        data: {
          asset,
          kind: 'OPTION_CHAIN',
          price: spot,
          // oiChangeTilt > 0: put writers adding more than call writers (usually read as support building)
          metrics: { ...metrics, expiry, oiChangeTilt: totalOi > 0 ? (metrics.putOiChange - metrics.callOiChange) / totalOi : 0 } as any,
        },
      });
      n++;
    }
    return n;
  }

  async recordCryptoVolatility(): Promise<number> {
    let n = 0;
    for (const [asset, currency, venue] of [['BTC', 'BTC', 'BTCUSDT'], ['ETH', 'ETH', 'ETHUSDT']] as const) {
      const price = await this.livePrice(asset);
      if (!price) continue;
      const now = Date.now();
      const dv = await fetch(
        `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${currency}&resolution=60&start_timestamp=${now - 2 * 3_600_000}&end_timestamp=${now}`,
      ).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const rows: any[] = dv?.result?.data || [];
      const dvol = rows.length ? Number(rows[rows.length - 1][4]) : NaN; // [t, open, high, low, close]
      const prem = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${venue}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const fundingRate = Number(prem?.lastFundingRate);
      if (!Number.isFinite(dvol) && !Number.isFinite(fundingRate)) continue;
      await this.prisma.marketObservation.create({
        data: {
          asset,
          kind: 'VOLATILITY',
          price,
          metrics: { dvol: Number.isFinite(dvol) ? dvol : null, fundingRate: Number.isFinite(fundingRate) ? fundingRate : null },
        },
      });
      n++;
    }
    return n;
  }

  async pollNews(): Promise<number> {
    let added = 0;
    for (const feed of NEWS_FEEDS) {
      try {
        const res = await fetch(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) continue;
        const items = parseRss(await res.text(), feed.source).filter((it) => Date.now() - it.publishedAt.getTime() < NEWS_MAX_AGE_MS);
        if (!items.length) continue;
        const r = await this.prisma.newsItem.createMany({ data: items, skipDuplicates: true });
        added += r.count;
      } catch (e: any) {
        this.logger.debug(`[OBSERVER] feed ${feed.source}: ${e.message}`);
      }
    }
    return added;
  }

  /** Scores unscored recent headlines with Claude (needs ANTHROPIC_API_KEY; without it headlines are only stored). */
  async scoreNews(maxBatches = 4): Promise<number> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return 0;
    let scored = 0;
    for (let b = 0; b < maxBatches; b++) {
      const batch = await this.prisma.newsItem.findMany({
        where: { scoredAt: null, publishedAt: { gte: new Date(Date.now() - NEWS_MAX_AGE_MS) } },
        orderBy: { publishedAt: 'desc' },
        take: 25,
      });
      if (!batch.length) break;
      const scores = await scoreHeadlines(batch.map((x) => ({ id: x.id, title: x.title, summary: x.summary })), apiKey);
      for (const item of batch) {
        await this.prisma.newsItem.update({
          where: { id: item.id },
          data: { scores: (scores[item.id] ?? {}) as any, scoredAt: new Date(), scoreModel: NEWS_SCORE_MODEL },
        });
        scored++;
      }
    }
    return scored;
  }

  /** Runs every collector once now. */
  async runAll() {
    const prices = await this.recordPrices();
    const optionChains = await this.recordOptionChains();
    const volatility = await this.recordCryptoVolatility();
    const news = await this.pollNews();
    const scored = await this.scoreNews();
    return { prices, optionChains, volatility, news, scored };
  }

  async status() {
    const latest = async (asset: string, kind: string) =>
      this.prisma.marketObservation.findFirst({ where: { asset, kind }, orderBy: { takenAt: 'desc' } });
    const counts = await this.prisma.marketObservation.groupBy({ by: ['asset', 'kind'], _count: true });
    const news = await this.prisma.newsItem.findMany({ orderBy: { publishedAt: 'desc' }, take: 30 });
    return {
      newsScoring: process.env.ANTHROPIC_API_KEY ? `ON (${NEWS_SCORE_MODEL})` : 'OFF - add ANTHROPIC_API_KEY to .env to score headlines',
      nseSessionOpen: isNseSession(Date.now()),
      counts: counts.map((c) => ({ asset: c.asset, kind: c.kind, count: c._count })),
      optionChains: { NIFTY: await latest('NIFTY', 'OPTION_CHAIN'), BANKNIFTY: await latest('BANKNIFTY', 'OPTION_CHAIN') },
      volatility: { BTC: await latest('BTC', 'VOLATILITY'), ETH: await latest('ETH', 'VOLATILITY') },
      newsTotal: await this.prisma.newsItem.count(),
      newsScored: await this.prisma.newsItem.count({ where: { scoredAt: { not: null } } }),
      news,
    };
  }

  /** What has (and has not) predicted price moves so far. */
  async insights(): Promise<Insight[]> {
    const since = new Date(Date.now() - 365 * 86_400_000);
    const obs = await this.prisma.marketObservation.findMany({ where: { takenAt: { gte: since } }, orderBy: { takenAt: 'asc' } });
    const news = await this.prisma.newsItem.findMany({ where: { scoredAt: { not: null }, publishedAt: { gte: since } } });
    const out: Insight[] = [];
    for (const asset of Object.keys(PRICE_SYMBOLS)) {
      const prices: PricePoint[] = obs.filter((o) => o.asset === asset).map((o) => ({ t: o.takenAt.getTime(), price: o.price }));
      const series = (kind: string, key: string): FeaturePoint[] =>
        obs
          .filter((o) => o.asset === asset && o.kind === kind)
          .map((o) => ({ t: o.takenAt.getTime(), x: Number((o.metrics as any)?.[key]) }))
          .filter((p) => Number.isFinite(p.x));
      const inputs: Array<[string, FeaturePoint[]]> = [];
      if (asset === 'NIFTY' || asset === 'BANKNIFTY') for (const k of OPTION_INPUTS) inputs.push([k, series('OPTION_CHAIN', k)]);
      if (asset === 'BTC' || asset === 'ETH') for (const k of VOL_INPUTS) inputs.push([k, series('VOLATILITY', k)]);
      if ((NEWS_ASSETS as readonly string[]).includes(asset)) {
        const hourly = prices.filter((p, i) => i === 0 || Math.floor(p.t / 3_600_000) !== Math.floor(prices[i - 1].t / 3_600_000)).map((p) => p.t);
        inputs.push([
          'newsSentiment6h',
          newsSentimentSeries(news.map((n) => ({ t: n.publishedAt.getTime(), scores: n.scores as any })), asset, hourly),
        ]);
      }
      for (const [feature, points] of inputs) {
        for (const h of ['1h', '1d'] as const) out.push(evaluateInput(asset, feature, h, points, prices));
      }
    }
    return out;
  }
}
