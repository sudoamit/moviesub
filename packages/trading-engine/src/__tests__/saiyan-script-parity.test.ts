import { Direction, ICandle } from '@quant/shared';
import { SaiyanOCCEngine } from '../saiyan-occ-engine';

const M15 = 15 * 60 * 1000;
const candle = (t: number, o: number, c: number): ICandle =>
  ({ timestamp: new Date(t), open: o, high: Math.max(o, c) + 5, low: Math.min(o, c) - 5, close: c, volume: 1, isClosed: true }) as any;

describe('Saiyan OCC follows the TradingView script', () => {
  it('ALMA(2, 0.85, 5) weights the current bar ~90% and the previous ~10% (offset not floored)', () => {
    const [, v] = SaiyanOCCEngine.calculateALMA([100, 200], 2, 0.85, 5);
    // w_prev = exp(-0.85^2 / 0.32), w_cur = exp(-0.15^2 / 0.32)
    const wp = Math.exp(-(0.85 ** 2) / 0.32), wc = Math.exp(-(0.15 ** 2) / 0.32);
    expect(v).toBeCloseTo((100 * wp + 200 * wc) / (wp + wc), 6);
    expect(v).toBeGreaterThan(189);
  });

  it('builds closed 2h candles (8 x 15m), UTC-aligned, excluding the forming one', () => {
    const start = Date.UTC(2026, 9, 1, 0, 0);
    const cs = Array.from({ length: 20 }, (_, i) => candle(start + i * M15, 100 + i, 101 + i)); // 2.5 x 2h
    const htf = SaiyanOCCEngine.alternateResolutionCandles(cs, 8, 'BTCUSDT_PERP');
    expect(htf).toHaveLength(2);
    expect(htf[0]).toEqual({ open: 100, close: 108, lastIndex: 7 });
    expect(htf[1]).toEqual({ open: 108, close: 116, lastIndex: 15 });
  });

  it('aligns NSE 2h candles to the 09:15 IST open and closes the last one at 15:30', () => {
    const open = Date.UTC(2026, 9, 1, 3, 45); // 09:15 IST
    const cs = Array.from({ length: 25 }, (_, i) => candle(open + i * M15, 100, 100 + i)); // full session
    const htf = SaiyanOCCEngine.alternateResolutionCandles(cs, 8, 'NIFTY');
    // 09:15-11:15, 11:15-13:15, 13:15-15:15, 15:15-15:30 (closed at the session close)
    expect(htf.map((h) => h.lastIndex)).toEqual([7, 15, 23, 24]);
  });

  it('script exits: stop 0.5%, TP1 1%, TP2 1.5%, TP3 2% from the entry, for every instrument', () => {
    const start = Date.UTC(2026, 9, 1, 0, 0);
    // Falling 2h candles, then a rising one completes on the last bar -> fresh bullish crossover
    const cs: ICandle[] = [];
    for (let i = 0; i < 200; i++) cs.push(candle(start + i * M15, 30000 - i * 10, 30000 - i * 10 - 8));
    for (let i = 200; i < 208; i++) cs.push(candle(start + i * M15, 28000 + (i - 200) * 40, 28000 + (i - 199) * 40));
    for (const sym of ['BTCUSDT_PERP', 'XAUUSD']) {
      const a = SaiyanOCCEngine.analyze(cs, {}, sym);
      expect(a.direction).toBe(Direction.BULLISH);
      expect(a.isLongTrigger).toBe(true);
      const e = a.entryPrice;
      expect(e).toBe(cs[cs.length - 1].close);
      expect(a.stopLoss).toBeCloseTo(e * 0.995, 1);
      expect(a.tp1).toBeCloseTo(e * 1.01, 1);
      expect(a.tp2).toBeCloseTo(e * 1.015, 1);
      expect(a.tp3).toBeCloseTo(e * 1.02, 1);
    }
  });

  it('a crossover triggers only on the chart candle that closes the 2h candle (no intra-candle repainting)', () => {
    const start = Date.UTC(2026, 9, 1, 0, 0);
    const cs: ICandle[] = [];
    for (let i = 0; i < 200; i++) cs.push(candle(start + i * M15, 30000 - i * 10, 30000 - i * 10 - 8));
    for (let i = 200; i < 205; i++) cs.push(candle(start + i * M15, 28000 + (i - 200) * 40, 28000 + (i - 199) * 40));
    // The rising 2h candle is still forming: no trigger yet
    expect(SaiyanOCCEngine.analyze(cs, {}, 'BTCUSDT_PERP').isLongTrigger).toBe(false);
  });
});
