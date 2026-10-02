import { Bar, computeFeatures, discoverStrategies, enumerateGenomes, INSTRUMENT_PROFILES } from '..';

const M15 = 15 * 60 * 1000;
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Random walk; with `edge`, price drifts up for 8 bars after each bullish liquidity sweep (past bars only). */
function series(n: number, seed: number, edge: boolean): Bar[] {
  const rnd = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const bars: Bar[] = [];
  let p = 50000, drift = 0;
  for (let i = 0; i < n; i++) {
    const d = drift > 0 ? 0.0012 : 0;
    if (drift > 0) drift--;
    const o = p, c = o * (1 + d + 0.002 * gauss());
    bars.push({ t: Date.UTC(2024, 0, 1) + i * M15, o, h: Math.max(o, c) * (1 + Math.abs(0.001 * gauss())), l: Math.min(o, c) * (1 - Math.abs(0.001 * gauss())), c, v: 1 });
    p = c;
    if (edge && i > 60) {
      const w = computeFeatures(bars.slice(-60), INSTRUMENT_PROFILES.BTCUSDT_PERP);
      if (w.sweepLong[w.n - 1] === 1) drift = 8;
    }
  }
  return bars;
}

describe('discoverStrategies', () => {
  const genomes = enumerateGenomes({ maxFilters: 1, entryModes: ['MARKET'], trailMaxBars: null })
    .filter((g) => (g.trigger === 'SWEEP_REVERSAL' || g.trigger === 'BREAKOUT_20') && g.stop.type === 'ATR' && g.rewardRisk === 2);
  const targets = [{ symbol: 'BTCUSDT_PERP', timeframes: ['15m' as const], sibling: 'ETHUSDT_PERP' }];

  it('registers nothing when both markets are noise', () => {
    const res = discoverStrategies({ BTCUSDT_PERP: series(12000, 1, false), ETHUSDT_PERP: series(12000, 2, false) }, targets, { genomes });
    expect(res.candidates).toHaveLength(0);
  });

  jest.setTimeout(120_000);

  it('discovers a genuine edge and never re-registers an existing strategy family', () => {
    const data = { BTCUSDT_PERP: series(9000, 3, true), ETHUSDT_PERP: series(9000, 4, true) };
    const first = discoverStrategies(data, targets, { genomes });
    expect(first.candidates.length).toBeGreaterThan(0);
    const top = first.candidates[0];
    expect(top.genome.trigger).toBe('SWEEP_REVERSAL');
    expect(top.reference.trades).toBeGreaterThan(0);
    expect(top.reference.expectancyR).toBeGreaterThan(0);

    const again = discoverStrategies(data, targets, { genomes, existingIds: new Set(first.candidates.map((c) => c.id)) });
    expect(again.candidates.find((c) => c.genome.trigger === 'SWEEP_REVERSAL' && c.genome.sides === top.genome.sides)).toBeUndefined();
  });
});
