import { backtestGenome, Bar, computeFeatures, InstrumentProfile, StrategyGenome } from '@quant/strategy-lab';
import { PositionSizer } from '@quant/risk-engine';
import { advanceTrade, assertLiveRunnable, assessLabEvidence, compoundedBalance, netR, sizeFromCoinBalance } from '../lab-lifecycle';

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

  it('the live runner refuses LIMIT-entry genomes instead of silently trading them at market', () => {
    expect(() => assertLiveRunnable({ ...genome, entryMode: 'LIMIT' })).toThrow(/LIMIT_ENTRY_NOT_SUPPORTED_LIVE/);
    expect(() => assertLiveRunnable(genome)).not.toThrow();
  });

  describe('evidence-based promotion and retirement (lifecycle/v2)', () => {
    // Development evidence as discovery stores it: reference stats + validation (holdOut) + golden holdout
    const validated = {
      expectancyR: 0.3, sdR: 1.6, trades: 400, maxDrawdownR: 14,
      evidence: { holdOut: { trades: 120, expectancyR: 0.25, tStat: 2.4 } },
      golden: { passed: true, trades: 60, expectancyR: 0.2, datasetVersion: 'BTCUSDT_PERP@2026-10-01#abcd1234' },
    };
    // 40 trades: 60% +2R winners, 40% -1R losers -> +0.8R expectancy, lower 95% CI bound clearly above 0
    const strong = Array.from({ length: 40 }, (_, i) => (i % 5 < 3 ? 2 : -1));

    it('REGRESSION: 8 shadow trades "consistent with the backtest" (old rule z >= -1.5) no longer promote', () => {
      const old8 = [2, -1, -1, 3, -1, 1.5, -1, 0.5];
      const a = assessLabEvidence('SHADOW', validated, old8);
      expect(a.action).toBe('NONE');
      expect(a.state).toBe('SHADOW_RUNNING');
    });

    it('UNVALIDATED: strong shadow results cannot promote without development + golden evidence', () => {
      const legacy = { expectancyR: 0.43, sdR: 2.2, trades: 191, maxDrawdownR: 10.3 }; // registered before golden holdouts
      const a = assessLabEvidence('SHADOW', legacy, strong);
      expect(a.state).toBe('UNVALIDATED');
      expect(a.action).toBe('NONE');
      expect(a.reason).toMatch(/validationTrades.*goldenHoldoutPassed/);
      expect(assessLabEvidence('SHADOW', { ...validated, golden: { ...validated.golden, passed: false } }, strong).state).toBe('UNVALIDATED');
    });

    it('state flow: BACKTEST_VALIDATED (no shadow trades) -> SHADOW_RUNNING -> SHADOW_CONFIRMED (promote)', () => {
      expect(assessLabEvidence('SHADOW', validated, []).state).toBe('BACKTEST_VALIDATED');
      expect(assessLabEvidence('SHADOW', validated, strong.slice(0, 12)).state).toBe('SHADOW_RUNNING');
      const a = assessLabEvidence('SHADOW', validated, strong);
      expect(a.state).toBe('SHADOW_CONFIRMED');
      expect(a.action).toBe('PROMOTE');
      expect(a.checks.every((c) => c.passed)).toBe(true);
      // the exact evidence relied on is part of the decision
      expect(a.rulesVersion).toBe('lifecycle/v2');
      expect(a.evidence.golden).toMatchObject({ passed: true, datasetVersion: 'BTCUSDT_PERP@2026-10-01#abcd1234' });
      expect(a.evidence.validation).toMatchObject({ trades: 120, expectancyR: 0.25 });
      expect(a.evidence.current.trades).toBe(40);
      expect(a.evidence.current.ciLowR).toBeGreaterThan(0);
    });

    it('SHADOW_NOT_DISPROVEN: positive but statistically weak shadow results do not promote', () => {
      const weak = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 2.2 : -1)); // mean +0.07R, wide CI
      const a = assessLabEvidence('SHADOW', validated, weak);
      expect(a.state).toBe('SHADOW_NOT_DISPROVEN');
      expect(a.action).toBe('NONE');
      expect(a.checks.find((c) => c.name === 'shadowExpectancyCiLow')!.passed).toBe(false);
    });

    it('economic checks block promotion: losing streak, drawdown, degradation vs validation, data quality', () => {
      const streak = [...Array(11).fill(-1), ...Array.from({ length: 40 }, (_, i) => (i % 5 < 3 ? 2.5 : -1))];
      expect(assessLabEvidence('SHADOW', validated, streak).checks.find((c) => c.name === 'losingStreak')!.passed).toBe(false);
      expect(assessLabEvidence('SHADOW', { ...validated, maxDrawdownR: 1 }, strong).checks.find((c) => c.name === 'shadowDrawdown')!.passed).toBe(false);
      const highValidation = { ...validated, evidence: { holdOut: { trades: 120, expectancyR: 2, tStat: 5 } } };
      expect(assessLabEvidence('SHADOW', highValidation, strong).checks.find((c) => c.name === 'noDegradationVsValidation')!.passed).toBe(false);
      const dq = assessLabEvidence('SHADOW', validated, strong, 1);
      expect(dq.action).toBe('NONE');
      expect(dq.checks.find((c) => c.name === 'noDataQualityViolations')!.passed).toBe(false);
    });

    it('retirement stays quick: clearly losing (upper CI < 0), far below backtest, or live drawdown', () => {
      const losing = Array(15).fill(-1);
      expect(assessLabEvidence('SHADOW', validated, losing)).toMatchObject({ action: 'RETIRE', state: 'RETIRED' });
      expect(assessLabEvidence('LIVE', validated, losing).action).toBe('RETIRE');
      const below = Array.from({ length: 20 }, (_, i) => (i % 2 ? 0.4 : -1.2)); // mean -0.4 vs backtest +0.3
      expect(assessLabEvidence('LIVE', validated, below).reason).toMatch(/clearly losing|far below backtest/);
      const ddLive = [3, 3, -10, -10, -10, 3];
      const r = assessLabEvidence('LIVE', validated, ddLive);
      expect(r.action).toBe('RETIRE');
      expect(r.reason).toMatch(/drawdown/);
      expect(assessLabEvidence('LIVE', validated, strong).state).toBe('LIVE');
    });
  });

  describe('per-instrument compounding capital', () => {

    it('risks 3% of the coin balance: Rs 50,000 and a 1,000 USDT stop distance on BTC -> 0.016 BTC', () => {
      const s = sizeFromCoinBalance({ symbol: 'BTCUSDT_PERP', balance: 50000, riskPct: 3, sizeMultiplier: 1, entry: 60000, stopDistance: 1000, fx: 92.5, leverage: 20 });
      // 1,500 / (1,000 x 92.5) = 0.0162 -> 0.016 (rounded down to the lot)
      expect(s.qty).toBe(0.016);
      expect(s.riskInr).toBeCloseTo(1480, 0);
      expect(s.marginInr).toBeLessThanOrEqual(50000);
    });

    it('never uses more margin than the coin balance (tight stop, low leverage)', () => {
      const s = sizeFromCoinBalance({ symbol: 'BTCUSDT_PERP', balance: 50000, riskPct: 3, sizeMultiplier: 1, entry: 60000, stopDistance: 10, fx: 92.5, leverage: 2 });
      expect(s.marginInr).toBeLessThanOrEqual(50000);
      expect(s.qty).toBe(0.018); // 50,000 x 2 / (60,000 x 92.5) = 0.018
    });

    it('does not trade a depleted balance', () => {
      expect(sizeFromCoinBalance({ symbol: 'SOLUSDT_PERP', balance: 0, riskPct: 3, sizeMultiplier: 1, entry: 100, stopDistance: 1, fx: 92.5, leverage: 10 }).qty).toBe(0);
    });

    it('uses the canonical server sizer: same quantity as PositionSizer for the same inputs (long and short)', () => {
      const fx = 92.5;
      const conv = { getRate: (f: any, t: any, ts: number) => ({ convertedAmount: fx, originalAmount: 1, fromCurrency: f, toCurrency: t, fxPair: 'USDT/INR', fxRate: fx, fxTimestamp: ts, fxSource: 't', fxVersion: 't', fxSnapshotHash: 't' }) };
      for (const [side, stop] of [['LONG', 59000], ['SHORT', 61000]] as const) {
        const lab = sizeFromCoinBalance({ symbol: 'BTCUSDT_PERP', side, balance: 80000, riskPct: 2, sizeMultiplier: 0.75, entry: 60000, stopDistance: 1000, fx, leverage: 10 });
        const canon = PositionSizer.calculatePosition({ accountBalance: 80000, availableMargin: 80000, riskPercentage: 1.5, entryPrice: 60000, stopLoss: stop, direction: side === 'LONG' ? 'BUY' : 'SELL', symbol: 'BTCUSDT_PERP', requestedLeverage: 10, currencyConverter: conv as any });
        expect(canon.isValid).toBe(true);
        expect(lab.qty).toBe(canon.roundedUnits);
      }
    });

    it('rejects (never clamps) a requested risk above the lab cap, and leverage above the instrument maximum', () => {
      expect(sizeFromCoinBalance({ symbol: 'BTCUSDT_PERP', balance: 50000, riskPct: 50, sizeMultiplier: 1, entry: 60000, stopDistance: 1000, fx: 92.5, leverage: 20 }).qty).toBe(0);
      const overLev = sizeFromCoinBalance({ symbol: 'BTCUSDT_PERP', balance: 50000, riskPct: 3, sizeMultiplier: 1, entry: 60000, stopDistance: 100, fx: 92.5, leverage: 125 });
      expect(overLev.qty).toBe(0);
      expect(overLev.rejectionReason).toMatch(/leverage/i);
      // spot can never be sized with leverage
      expect(sizeFromCoinBalance({ symbol: 'BTCUSDT_SPOT', balance: 50000, riskPct: 3, sizeMultiplier: 1, entry: 60000, stopDistance: 1000, fx: 92.5, leverage: 50 }).qty).toBe(0);
    });

    it('compounds the balance trade by trade', () => {
      // +3R at 3% -> x1.09, then -1R -> x0.97
      expect(compoundedBalance(50000, 3, [{ netR: 3 }, { netR: -1 }])).toBeCloseTo(50000 * 1.09 * 0.97, 6);
    });
  });
});
