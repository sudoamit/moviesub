import * as fs from 'fs';
import * as path from 'path';
import { Bar } from './types';

const M15 = 15 * 60 * 1000;

/** Where each instrument's 15m history comes from. */
export const HISTORY_SOURCES: Record<string, { kind: 'BINANCE'; base: string; symbol: string; limit: number } | { kind: 'YAHOO'; symbol: string }> = {
  BTCUSDT_PERP: { kind: 'BINANCE', base: 'https://fapi.binance.com/fapi/v1', symbol: 'BTCUSDT', limit: 1500 },
  ETHUSDT_PERP: { kind: 'BINANCE', base: 'https://fapi.binance.com/fapi/v1', symbol: 'ETHUSDT', limit: 1500 },
  SOLUSDT_PERP: { kind: 'BINANCE', base: 'https://fapi.binance.com/fapi/v1', symbol: 'SOLUSDT', limit: 1500 },
  XRPUSDT_PERP: { kind: 'BINANCE', base: 'https://fapi.binance.com/fapi/v1', symbol: 'XRPUSDT', limit: 1500 },
  DOGEUSDT_PERP: { kind: 'BINANCE', base: 'https://fapi.binance.com/fapi/v1', symbol: 'DOGEUSDT', limit: 1500 },
  BNBUSDT_PERP: { kind: 'BINANCE', base: 'https://fapi.binance.com/fapi/v1', symbol: 'BNBUSDT', limit: 1500 },
  ADAUSDT_PERP: { kind: 'BINANCE', base: 'https://fapi.binance.com/fapi/v1', symbol: 'ADAUSDT', limit: 1500 },
  LINKUSDT_PERP: { kind: 'BINANCE', base: 'https://fapi.binance.com/fapi/v1', symbol: 'LINKUSDT', limit: 1500 },
  AVAXUSDT_PERP: { kind: 'BINANCE', base: 'https://fapi.binance.com/fapi/v1', symbol: 'AVAXUSDT', limit: 1500 },
  // Gold is traded on the PAXG feed (same as the live gold price)
  XAUUSD: { kind: 'BINANCE', base: 'https://api.binance.com/api/v3', symbol: 'PAXGUSDT', limit: 1000 },
  // Yahoo serves at most ~60 days of 15m history
  NIFTY: { kind: 'YAHOO', symbol: '^NSEI' },
};

/** Closed 15m Binance klines from `startMs` until now. */
export async function fetchBinanceKlines(base: string, symbol: string, limit: number, startMs: number): Promise<Bar[]> {
  const bars: Bar[] = [];
  let start = startMs;
  while (start < Date.now() - M15) {
    const res = await fetch(`${base}/klines?symbol=${symbol}&interval=15m&limit=${limit}&startTime=${start}`);
    if (!res.ok) throw new Error(`${symbol} klines ${res.status}`);
    const rows: any[] = await res.json();
    if (rows.length === 0) break;
    for (const k of rows) {
      if (Number(k[6]) >= Date.now()) continue; // forming candle
      bars.push({ t: Number(k[0]), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
    }
    start = Number(rows[rows.length - 1][0]) + M15;
    await new Promise((r) => setTimeout(r, 150));
  }
  return bars;
}

/** Closed 15m Yahoo bars (last ~60 days). */
export async function fetchYahoo15m(symbol: string): Promise<Bar[]> {
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
    if (t + M15 > Date.now()) continue;
    bars.push({ t, o, h, l, c, v: q.volume?.[i] ?? 0 });
  }
  return bars;
}

export function historyFile(dir: string, symbol: string): string {
  return path.join(dir, `${symbol}_15m.json`);
}

export function loadHistory(dir: string, symbol: string): Bar[] {
  const file = historyFile(dir, symbol);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
}

/**
 * Brings the cached 15m history up to date (appends new closed bars; Yahoo history is merged, keeping old bars
 * so it grows beyond Yahoo's 60-day window over time). `initialDays` is used when there is no cache yet.
 */
export async function updateHistory(dir: string, symbol: string, initialDays = 2600): Promise<{ added: number; total: number }> {
  const src = HISTORY_SOURCES[symbol];
  if (!src) throw new Error(`no history source for ${symbol}`);
  fs.mkdirSync(dir, { recursive: true });
  const existing = loadHistory(dir, symbol);
  const lastT = existing.length ? existing[existing.length - 1].t : 0;
  const fresh =
    src.kind === 'BINANCE'
      ? await fetchBinanceKlines(src.base, src.symbol, src.limit, lastT ? lastT + M15 : Date.now() - initialDays * 86_400_000)
      : await fetchYahoo15m(src.symbol);
  const byT = new Map<number, Bar>();
  for (const b of existing) byT.set(b.t, b);
  let added = 0;
  for (const b of fresh) {
    if (!byT.has(b.t)) added++;
    byT.set(b.t, b);
  }
  const merged = [...byT.values()].sort((a, b) => a.t - b.t);
  fs.writeFileSync(historyFile(dir, symbol), JSON.stringify(merged));
  return { added, total: merged.length };
}
