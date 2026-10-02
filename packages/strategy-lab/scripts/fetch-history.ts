/**
 * Downloads 15m history for the traded instruments into data/strategy-lab/<SYMBOL>_15m.json (repo root).
 * - BTCUSDT_PERP: Binance USDⓈ-M futures klines (paged, 1500 per request)
 * - XAUUSD: Binance PAXGUSDT spot klines (the live gold feed's source)
 * - NIFTY: Yahoo ^NSEI 15m (Yahoo serves at most ~60 days of 15m history)
 * Usage: npx ts-node --transpile-only scripts/fetch-history.ts [days=730]
 */
import * as fs from 'fs';
import * as path from 'path';
import { Bar } from '../src/types';

const OUT_DIR = path.resolve(__dirname, '../../../data/strategy-lab');
const M15 = 15 * 60 * 1000;

async function binanceKlines(base: string, symbol: string, limit: number, days: number): Promise<Bar[]> {
  const bars: Bar[] = [];
  let start = Date.now() - days * 86_400_000;
  while (start < Date.now() - M15) {
    const url = `${base}/klines?symbol=${symbol}&interval=15m&limit=${limit}&startTime=${start}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${symbol} ${res.status} ${await res.text()}`);
    const rows: any[] = await res.json();
    if (rows.length === 0) break;
    for (const k of rows) {
      // Only closed candles: the close time must be in the past.
      if (Number(k[6]) >= Date.now()) continue;
      bars.push({ t: Number(k[0]), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
    }
    start = Number(rows[rows.length - 1][0]) + M15;
    await new Promise((r) => setTimeout(r, 150));
  }
  return bars;
}

async function yahoo15m(symbol: string): Promise<Bar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=15m&range=60d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j: any = await res.json();
  const r = j?.chart?.result?.[0];
  const ts: number[] = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0] ?? {};
  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const [o, h, l, c] = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]];
    if ([o, h, l, c].some((x) => x === null || x === undefined)) continue;
    const t = ts[i] * 1000;
    if (t + M15 > Date.now()) continue; // forming bar
    bars.push({ t, o, h, l, c, v: q.volume?.[i] ?? 0 });
  }
  return bars;
}

async function main() {
  const days = Number(process.argv[2] ?? 730);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const only = process.argv.slice(3);
  const all: Array<[string, () => Promise<Bar[]>]> = [
    ['BTCUSDT_PERP', () => binanceKlines('https://fapi.binance.com/fapi/v1', 'BTCUSDT', 1500, days)],
    ['XAUUSD', () => binanceKlines('https://api.binance.com/api/v3', 'PAXGUSDT', 1000, days)],
    ['NIFTY', () => yahoo15m('^NSEI')],
    // Confirmation market only (not traded): tests BTC-found strategies on an unseen instrument.
    ['ETHUSDT_PERP', () => binanceKlines('https://fapi.binance.com/fapi/v1', 'ETHUSDT', 1500, days)],
  ];
  const jobs = only.length ? all.filter(([s]) => only.includes(s)) : all;
  for (const [sym, fn] of jobs) {
    const bars = await fn();
    const file = path.join(OUT_DIR, `${sym}_15m.json`);
    fs.writeFileSync(file, JSON.stringify(bars));
    const span = bars.length ? `${new Date(bars[0].t).toISOString().slice(0, 10)} .. ${new Date(bars[bars.length - 1].t).toISOString().slice(0, 10)}` : 'none';
    console.log(`${sym}: ${bars.length} bars (${span}) -> ${path.relative(process.cwd(), file)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
