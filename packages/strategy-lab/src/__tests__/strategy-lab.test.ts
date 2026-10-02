import {
  backtestGenome,
  Bar,
  computeFeatures,
  computeMetrics,
  enumerateGenomes,
  Features,
  InstrumentProfile,
  normalQuantile,
  searchStrategies,
  StrategyGenome,
} from '..';

const M15 = 15 * 60 * 1000;
const profile: InstrumentProfile = {
  symbol: 'TEST',
  makerFeeRate: 0.0001,
  takerFeeRate: 0.0002,
  slippageRate: 0.00005,
  barMs: M15,
  killzones: [{ name: 'KZ', startHourUtc: 7, endHourUtc: 10 }],
  silverBullet: { name: 'SB', startHourUtc: 14, endHourUtc: 15 },
};

/** Deterministic random walk (mulberry32) - no exploitable structure by construction. */
function randomWalk(n: number, seed: number): Bar[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const bars: Bar[] = [];
  let price = 50000;
  for (let i = 0; i < n; i++) {
    const o = price;
    const c = o * (1 + 0.002 * gauss());
    const h = Math.max(o, c) * (1 + Math.abs(0.001 * gauss()));
    const l = Math.min(o, c) * (1 - Math.abs(0.001 * gauss()));
    bars.push({ t: Date.UTC(2025, 0, 1) + i * M15, o, h, l, c, v: 1 });
    price = c;
  }
  return bars;
}

describe('strategy-lab', () => {
  it('normalQuantile matches known values', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 8);
    expect(normalQuantile(1 - 0.05 / 1000)).toBeCloseTo(3.890592, 4);
  });

  it('features have no look-ahead: values at bar i do not change when future bars are added', () => {
    const bars = randomWalk(1200, 7);
    const full = computeFeatures(bars, profile);
    const cut = 900;
    const partial = computeFeatures(bars.slice(0, cut), profile);
    const keys = Object.keys(full).filter((k) => k !== 'n') as (keyof Features)[];
    for (const k of keys) {
      const a = Array.from(full[k] as ArrayLike<number>).slice(0, cut);
      const b = Array.from(partial[k] as ArrayLike<number>);
      expect({ k, equal: a.every((v, i) => (Number.isNaN(v) && Number.isNaN(b[i])) || v === b[i]) }).toEqual({ k, equal: true });
    }
  });

  describe('backtester execution model', () => {
    const genome: StrategyGenome = {
      trigger: 'SWEEP_REVERSAL', sides: 'LONG', filters: [], stop: { type: 'ATR', atrMult: 1 }, rewardRisk: 2, maxBarsInTrade: 5,
    };
    const flatBars = (n: number): Bar[] =>
      Array.from({ length: n }, (_, i) => ({ t: i * M15, o: 100, h: 100.5, l: 99.5, c: 100, v: 1 }));
    const featuresWithSignalAt = (n: number, i: number): Features => {
      const f = computeFeatures(flatBars(n), profile);
      f.sweepLong.fill(0);
      f.sweepLong[i] = 1;
      f.atr.fill(1);
      return f;
    };

    it('fills at the next bar open and assumes the stop first when a bar touches both stop and target', () => {
      const bars = flatBars(260);
      bars[221] = { t: 221 * M15, o: 100, h: 103, l: 98.5, c: 100, v: 1 }; // touches 102 target and 99 stop
      const trades = backtestGenome(genome, bars, featuresWithSignalAt(260, 220), profile);
      expect(trades).toHaveLength(1);
      expect(trades[0].entryIndex).toBe(221);
      expect(trades[0].entry).toBe(100);
      expect(trades[0].exitReason).toBe('STOP');
      // taker + slippage (0.025%) on the 100 entry and on the 99 stop exit
      expect(trades[0].netR).toBeCloseTo(-1 - (100 * 0.00025 + 99 * 0.00025), 6);
    });

    it('a gap through the stop fills at the open, not at the stop', () => {
      const bars = flatBars(260);
      bars[222] = { t: 222 * M15, o: 97, h: 97.5, l: 96.5, c: 97, v: 1 };
      const trades = backtestGenome(genome, bars, featuresWithSignalAt(260, 220), profile);
      expect(trades[0].exit).toBe(97);
      expect(trades[0].netR).toBeLessThan(-1);
    });

    it('trailing exit follows the best close and never loosens', () => {
      const trailGenome: StrategyGenome = { ...genome, exit: 'TRAIL', stop: { type: 'ATR', atrMult: 1 }, maxBarsInTrade: 50 };
      const bars = flatBars(260);
      // Rally after entry at 100: closes 101..105, then a drop to 102.5 low
      for (let k = 0; k < 5; k++) bars[221 + k] = { t: (221 + k) * M15, o: 100 + k, h: 101.2 + k, l: 99.8 + k, c: 101 + k, v: 1 };
      bars[226] = { t: 226 * M15, o: 104.6, h: 104.7, l: 102.5, c: 103, v: 1 };
      const trades = backtestGenome(trailGenome, bars, featuresWithSignalAt(260, 220), profile);
      expect(trades).toHaveLength(1);
      expect(trades[0].exitReason).toBe('STOP');
      // Best close 105, ATR 1 -> trail 104; the 104.6 open is above it, so the exit is at 104
      expect(trades[0].exit).toBe(104);
      expect(trades[0].exitIndex).toBe(226);
    });

    describe('limit entries', () => {
      const limitGenome: StrategyGenome = { ...genome, entryMode: 'LIMIT' };

      it('fills only if price trades through the limit; otherwise the order is cancelled', () => {
        const bars = flatBars(260);
        for (let j = 221; j <= 223; j++) bars[j] = { t: j * M15, o: 100.2, h: 100.6, l: 100, c: 100.3, v: 1 }; // touches, never through
        expect(backtestGenome(limitGenome, bars, featuresWithSignalAt(260, 220), profile)).toHaveLength(0);
      });

      it('fills at the limit on trade-through, ignores the target on the fill bar and charges maker fees on entry and target', () => {
        const bars = flatBars(260);
        bars[221] = { t: 221 * M15, o: 100.2, h: 103, l: 99.9, c: 100.1, v: 1 }; // fill bar also spikes past the target
        bars[223] = { t: 223 * M15, o: 101, h: 102.5, l: 100.8, c: 102, v: 1 }; // real target hit
        const trades = backtestGenome(limitGenome, bars, featuresWithSignalAt(260, 220), profile);
        expect(trades).toHaveLength(1);
        expect(trades[0].entry).toBe(100);
        expect(trades[0].entryIndex).toBe(221);
        expect(trades[0].exitIndex).toBe(223);
        expect(trades[0].exitReason).toBe('TARGET');
        expect(trades[0].netR).toBeCloseTo(2 - (100 * 0.0001 + 102 * 0.0001), 6);
      });
    });

    it('skips trades whose round-trip cost exceeds half the risk', () => {
      const expensive: InstrumentProfile = { ...profile, takerFeeRate: 0.005 }; // ~1.0 round trip on a 1.0 risk
      const trades = backtestGenome(genome, flatBars(260), featuresWithSignalAt(260, 220), expensive);
      expect(trades).toHaveLength(0);
    });
  });

  it('finds no strategy on a pure random walk (false discoveries are controlled)', () => {
    const bars = randomWalk(12000, 42);
    const res = searchStrategies(bars, profile, { genomes: enumerateGenomes({ maxFilters: 2 }) });
    expect(res.genomesTested).toBeGreaterThan(500);
    expect(res.passed).toHaveLength(0);
  });

  it('finds a planted edge: price drifts up after bullish liquidity sweeps', () => {
    // Random walk, except that after a bullish sweep (detected only from past bars) price drifts up for 8 bars.
    let seed = 99 >>> 0;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const bars: Bar[] = [];
    let price = 50000, driftLeft = 0;
    for (let i = 0; i < 12000; i++) {
      const drift = driftLeft > 0 ? 0.0012 : 0;
      if (driftLeft > 0) driftLeft--;
      const o = price;
      const c = o * (1 + drift + 0.002 * gauss());
      const h = Math.max(o, c) * (1 + Math.abs(0.001 * gauss()));
      const l = Math.min(o, c) * (1 - Math.abs(0.001 * gauss()));
      bars.push({ t: Date.UTC(2025, 0, 1) + i * M15, o, h, l, c, v: 1 });
      price = c;
      if (i > 60) {
        const w = computeFeatures(bars.slice(-60), profile);
        if (w.sweepLong[w.n - 1] === 1) driftLeft = 8;
      }
    }
    const res = searchStrategies(bars, profile, { genomes: enumerateGenomes({ maxFilters: 1 }) });
    expect(res.passed.length).toBeGreaterThan(0);
    expect(res.passed[0].genome.trigger).toBe('SWEEP_REVERSAL');
    expect(res.passed[0].genome.sides).not.toBe('SHORT');
  });

  it('computeMetrics reports expectancy, profit factor and drawdown', () => {
    const m = computeMetrics([
      { netR: 2 }, { netR: -1 }, { netR: -1 }, { netR: 3 },
    ] as any);
    expect(m.trades).toBe(4);
    expect(m.expectancyR).toBeCloseTo(0.75, 10);
    expect(m.profitFactor).toBeCloseTo(2.5, 10);
    expect(m.maxDrawdownR).toBeCloseTo(2, 10);
  });
});
