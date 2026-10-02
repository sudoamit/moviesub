import { BlackScholesModel } from '@quant/trading-engine';
import { impliedVolatility, parseGrowwChain, summarizeOptionChain, ChainStrike } from '../option-chain-metrics';
import { parseRss, scoreHeadlines } from '../news-feed';
import { evaluateInput, newsSentimentSeries, spearman, MIN_SAMPLES } from '../observer-learning';
import { isNseSession } from '../market-observer.service';

describe('option-chain metrics', () => {
  const DAY = 86_400_000;
  const now = Date.UTC(2026, 9, 1, 6, 0);
  const expiry = now + 5 * DAY;
  const years = 5 / 365;
  const price = (k: number, type: 'CE' | 'PE', iv: number) => BlackScholesModel.calculate(25000, k, years, 0.065, iv, type).price;
  const chain: ChainStrike[] = [24600, 24800, 25000, 25200, 25400, 25600].map((k) => ({
    strike: k,
    call: { ltp: price(k, 'CE', 0.12), oi: k === 25400 ? 900 : 300, prevOi: 250, volume: 100 },
    put: { ltp: price(k, 'PE', k < 25000 ? 0.15 : 0.12), oi: k === 24800 ? 1200 : 400, prevOi: 300, volume: 150 },
  }));

  it('recovers the implied volatility used to price an option', () => {
    expect(impliedVolatility(price(25000, 'CE', 0.14), 25000, 25000, years, 'CE')!).toBeCloseTo(0.14, 2);
  });

  it('computes PCR, OI walls, max pain, ATM IV and put skew', () => {
    const m = summarizeOptionChain(chain, 25000, expiry, now)!;
    expect(m.pcrOi).toBeCloseTo((400 * 5 + 1200) / (300 * 5 + 900), 6);
    expect(m.callWall).toBe(25400);
    expect(m.putWall).toBe(24800);
    expect(m.atmStrike).toBe(25000);
    expect(m.atmIv!).toBeCloseTo(0.12, 2);
    expect(m.ivSkew!).toBeGreaterThan(0.02); // OTM puts priced at 15% vs calls at 12%
    expect(m.callOiChange).toBe(6 * 300 + 600 - 6 * 250);
    // Max pain is the strike where option holders' total intrinsic value is lowest
    const pain = (K: number) => chain.reduce((a, s) => a + s.call!.oi * Math.max(0, K - s.strike) + s.put!.oi * Math.max(0, s.strike - K), 0);
    const best = chain.map((s) => s.strike).reduce((a, k) => (pain(k) < pain(a) ? k : a));
    expect(m.maxPain).toBe(best);
  });

  it('parses Groww strikes quoted in paise', () => {
    const p = parseGrowwChain({ optionChain: { expiryDetailsDto: { currentExpiry: '2026-10-06' }, optionChains: [{ strikePrice: 2500000, callOption: { ltp: 10, openInterest: 5, prevOpenInterest: 4, volume: 1 } }] } });
    expect(p.expiry).toBe('2026-10-06');
    expect(p.strikes[0].strike).toBe(25000);
    expect(p.strikes[0].call).toEqual({ ltp: 10, oi: 5, prevOi: 4, volume: 1 });
  });
});

describe('news feed', () => {
  it('parses RSS items with CDATA, entities and HTML in descriptions', () => {
    const xml = `<rss><channel>
      <item><title><![CDATA[Sensex jumps 500 pts &amp; Nifty tops 25,000]]></title><link>https://ex.com/a</link>
        <pubDate>Thu, 01 Oct 2026 06:00:00 GMT</pubDate><description><![CDATA[<p>Banks <b>lead</b> gains</p>]]></description></item>
      <item><title>No link</title></item>
    </channel></rss>`;
    const items = parseRss(xml, 'Test');
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Sensex jumps 500 pts & Nifty tops 25,000');
    expect(items[0].summary).toBe('Banks lead gains');
    expect(items[0].publishedAt.toISOString()).toBe('2026-10-01T06:00:00.000Z');
  });

  it('keeps only valid, clamped scores from the model reply (headlines are untrusted)', async () => {
    const reply = 'Here you go: {"1": {"NIFTY": {"sentiment": 2.5, "importance": 0.8}, "FOO": {"sentiment": 1, "importance": 1}}, "2": {"BTC": {"sentiment": "x"}}}';
    const fakeFetch: any = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ content: [{ type: 'text', text: reply }] }) });
    const out = await scoreHeadlines([{ id: 'a', title: 'Nifty rallies', summary: null }, { id: 'b', title: 'Bitcoin', summary: null }], 'key', fakeFetch);
    expect(out.a).toEqual({ NIFTY: { sentiment: 1, importance: 0.8 } });
    expect(out.b).toEqual({});
    const req = fakeFetch.mock.calls[0][1];
    expect(req.headers['x-api-key']).toBe('key');
    expect(JSON.parse(req.body).model).toBe('claude-haiku-4-5-20251001');
  });
});

describe('observer learning', () => {
  const H = 3_600_000;
  // Deterministic pseudo-random noise
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;

  const build = (n: number, link: number) => {
    const prices: { t: number; price: number }[] = [];
    const points: { t: number; x: number }[] = [];
    let p = 100;
    for (let i = 0; i < n; i++) {
      const t = i * H;
      const x = rnd();
      prices.push({ t, price: p });
      points.push({ t, x });
      p *= 1 + link * x * 0.01 + rnd() * 0.002; // next hour's move depends on x when link > 0
    }
    prices.push({ t: n * H, price: p });
    return { prices, points };
  };

  it('LEARNS a real relationship with enough non-overlapping samples', () => {
    const { prices, points } = build(200, 1);
    const ins = evaluateInput('BTC', 'x', '1h', points, prices);
    expect(ins.status).toBe('LEARNED');
    expect(ins.ic).toBeGreaterThan(0.5);
    expect(ins.meaning).toMatch(/higher x has been followed by higher BTC/);
  });

  it('reports NO_RELATIONSHIP for noise and COLLECTING with too few samples', () => {
    const noise = build(300, 0);
    expect(evaluateInput('BTC', 'x', '1h', noise.points, noise.prices).status).toBe('NO_RELATIONSHIP');
    const few = build(MIN_SAMPLES - 10, 1);
    expect(evaluateInput('BTC', 'x', '1h', few.points, few.prices).status).toBe('COLLECTING');
  });

  it('uses non-overlapping windows (5-minute snapshots give one 1h sample per hour)', () => {
    const prices = Array.from({ length: 12 * 10 + 1 }, (_, i) => ({ t: i * 5 * 60_000, price: 100 + i }));
    const points = prices.map((p) => ({ t: p.t, x: p.price }));
    expect(evaluateInput('NIFTY', 'x', '1h', points, prices).samples).toBe(10); // starts at 0h..9h (each has a price 1h later)
  });

  it('averages news sentiment by importance over the trailing window', () => {
    const news: Array<{ t: number; scores: Record<string, { sentiment: number; importance: number }> }> = [
      { t: 0, scores: { BTC: { sentiment: 1, importance: 1 } } },
      { t: H, scores: { BTC: { sentiment: -1, importance: 0.5 }, NIFTY: { sentiment: 1, importance: 1 } } },
    ];
    expect(newsSentimentSeries(news, 'BTC', [2 * H])[0].x).toBeCloseTo((1 - 0.5) / 1.5, 9);
    expect(newsSentimentSeries(news, 'BTC', [20 * H])).toEqual([]); // outside the 6h window
    expect(spearman([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 9);
  });

  it('knows the NSE session (09:15-15:30 IST, weekdays)', () => {
    expect(isNseSession(Date.UTC(2026, 9, 5, 4, 0))).toBe(true); // Monday 09:30 IST
    expect(isNseSession(Date.UTC(2026, 9, 5, 11, 0))).toBe(false); // 16:30 IST
    expect(isNseSession(Date.UTC(2026, 9, 3, 5, 0))).toBe(false); // Saturday
  });
});
