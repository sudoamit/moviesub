import { backtestGenome, Bar, computeFeatures, InstrumentProfile, StrategyGenome } from '@quant/strategy-lab';
import { advanceTrade, decideLifecycle, netR } from '../lab-lifecycle';

const H4 = 4 * 3_600_000;
const profile: InstrumentProfile = {
  symbol: 'TEST', makerFeeRate: 0.0002, takerFeeRate: 0.0005, slippageRate: 0.0001, barMs: H4, killzones: [],
};

function walk(n: number, seed: number): Bar[] {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const bars: Bar[] = [];
  let p = 60000;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = o * (1 + (rnd() - 0.48) * 0.02);
    bars.push({ t: i * H4, o, h: Math.max(o, c) * (1 + rnd() * 0.006), l: Math.min(o, c) * (1 - rnd() * 0.006), c, v: 1 });
    p = c;
  }
  return bars;
}

describe('lab strategy lifecycle', () => {
  const genome: StrategyGenome = {
    trigger: 'BREAKOUT_20', sides: 'BOTH', filters: [], stop: { type: 'ATR', atrMult: 2.5 },
    rewardRisk: 0, maxBarsInTrade: 160, entryMode: 'MARKET', exit: 'TRAIL',
  };

  it('advancing trades bar by bar reproduces the backtester exits (same stops, trail and prices)', () => {
    const bars = walk(3000, 11);
    const f = computeFeatures(bars, profile);
    const trades = backtestGenome(genome, bars, f, profile);
    expect(trades.length).toBeGreaterThan(10);
    for (const bt of trades.slice(0, 25)) {
      let open = { side: bt.side, entryPrice: bt.entry, initialStop: bt.stop, currentStop: bt.stop, extremeClose: bt.entry, barsHeld: 0 };
      let closed: any = null;
      // Feed bars one at a time, as the runner does at each bar close
      for (let j = bt.entryIndex; j < bars.length && !closed; j++) {
        const res = advanceTrade(open, [{ bar: bars[j], atr: f.atr[j] }], genome);
        open = res.trade;
        closed = res.closed;
      }
      expect(closed).not.toBeNull();
      expect(closed.exitPrice).toBeCloseTo(bt.exit, 6);
      expect(netR(open, closed.exitPrice, profile).netR).toBeCloseTo(bt.netR, 6);
    }
  });

  it('fixed-target strategies: bar-by-bar exits match the backtester (target, stop and timeout)', () => {
    const fixed: StrategyGenome = { ...genome, exit: 'FIXED', rewardRisk: 3, maxBarsInTrade: 32, stop: { type: 'ATR', atrMult: 2 } };
    const bars = walk(3000, 23);
    const f = computeFeatures(bars, profile);
    const trades = backtestGenome(fixed, bars, f, profile);
    expect(trades.some((t) => t.exitReason === 'TARGET')).toBe(true);
    for (const bt of trades.slice(0, 40)) {
      let open = { side: bt.side, entryPrice: bt.entry, initialStop: bt.stop, currentStop: bt.stop, extremeClose: bt.entry, barsHeld: 0 };
      let closed: any = null;
      for (let j = bt.entryIndex; j < bars.length && !closed; j++) {
        const res = advanceTrade(open, [{ bar: bars[j], atr: f.atr[j] }], fixed);
        open = res.trade;
        closed = res.closed;
      }
      expect(closed.exitReason).toBe(bt.exitReason);
      expect(closed.exitPrice).toBeCloseTo(bt.exit, 6);
    }
  });

  describe('automatic promotion and retirement', () => {
    const ref = { expectancyR: 0.43, sdR: 2.2, trades: 191, maxDrawdownR: 10.3 };

    it('waits for enough shadow trades', () => {
      expect(decideLifecycle('SHADOW', ref, [1, 2, -1]).action).toBe('NONE');
    });

    it('promotes a shadow record consistent with the backtest', () => {
      expect(decideLifecycle('SHADOW', ref, [2, -1, -1, 3, -1, 1.5, -1, 0.5]).action).toBe('PROMOTE');
    });

    it('does not promote a shadow record far below the backtest', () => {
      expect(decideLifecycle('SHADOW', ref, [-1, -1, -1, -1, -1, -1, -1, -1]).action).toBe('NONE');
    });

    it('retires a strategy whose results are significantly below the backtest', () => {
      expect(decideLifecycle('SHADOW', ref, Array(12).fill(-1)).action).toBe('RETIRE');
      expect(decideLifecycle('LIVE', ref, Array(12).fill(-1)).action).toBe('RETIRE');
    });

    it('retires a live strategy whose drawdown exceeds twice the backtest worst', () => {
      const res = decideLifecycle('LIVE', ref, [5, 5, -7, -7, -7, 2]);
      expect(res.action).toBe('RETIRE');
      expect(res.reason).toMatch(/drawdown/);
    });
  });

  describe('per-instrument compounding capital', () => {
    const { sizeFromCoinBalance, compoundedBalance } = require('../lab-lifecycle');

    it('risks 3% of the coin balance: Rs 50,000 and a 1,000 USDT stop distance on BTC -> 0.016 BTC', () => {
      const s = sizeFromCoinBalance({ balance: 50000, riskPct: 3, sizeMultiplier: 1, entry: 60000, stopDistance: 1000, fx: 92.5, leverage: 20, lot: 0.001, precision: 3 });
      // 1,500 / (1,000 x 92.5) = 0.0162 -> 0.016 (rounded down to the lot)
      expect(s.qty).toBe(0.016);
      expect(s.riskInr).toBeCloseTo(1480, 0);
      expect(s.marginInr).toBeLessThanOrEqual(50000);
    });

    it('never uses more margin than the coin balance (tight stop, low leverage)', () => {
      const s = sizeFromCoinBalance({ balance: 50000, riskPct: 3, sizeMultiplier: 1, entry: 60000, stopDistance: 10, fx: 92.5, leverage: 2, lot: 0.001, precision: 3 });
      expect(s.marginInr).toBeLessThanOrEqual(50000);
      expect(s.qty).toBe(0.018); // 50,000 x 2 / (60,000 x 92.5) = 0.018
    });

    it('does not trade a depleted balance', () => {
      expect(sizeFromCoinBalance({ balance: 0, riskPct: 3, sizeMultiplier: 1, entry: 100, stopDistance: 1, fx: 92.5, leverage: 10, lot: 0.01, precision: 2 }).qty).toBe(0);
    });

    it('compounds the balance trade by trade', () => {
      // +3R at 3% -> x1.09, then -1R -> x0.97
      expect(compoundedBalance(50000, 3, [{ netR: 3 }, { netR: -1 }])).toBeCloseTo(50000 * 1.09 * 0.97, 6);
    });
  });
});
