import {
  fitQualityModel, MAX_QUALITY_SIZE_MULTIPLIER, MIN_QUALITY_SIZE_MULTIPLIER, predictQuality, QUALITY_FEATURES, QualityExample,
  qualityDecision, qualitySizeMultiplier, validateQualityModel,
} from '..';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function examples(n: number, seed: number, signal: boolean): QualityExample[] {
  const rnd = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  return Array.from({ length: n }, (_, i) => {
    const x = QUALITY_FEATURES.map((name) => (name === 'bias' ? 1 : gauss()));
    // With signal: trades aligned with the HTF trend (feature 0 > 0) average +0.8R, the rest -0.4R
    const mu = signal ? (x[0] > 0 ? 0.8 : -0.4) : 0.2;
    return { t: i, market: 'TEST', x, y: mu + 1.5 * gauss() };
  });
}

describe('trade-quality model', () => {
  it('learns a real relationship and validates out of sample (ACTIVE)', () => {
    const ex = examples(600, 1, true);
    const v = validateQualityModel(ex);
    expect(v.active).toBe(true);
    expect(v.liftR).toBeGreaterThan(0.5);
    const m = fitQualityModel(ex);
    const aligned = [...ex[0].x]; aligned[0] = 2;
    const against = [...ex[0].x]; against[0] = -2;
    expect(predictQuality(m, aligned)).toBeGreaterThan(predictQuality(m, against));
  });

  it('stays INACTIVE when outcomes are noise, and then never changes size or skips', () => {
    const v = validateQualityModel(examples(600, 2, false));
    expect(v.active).toBe(false);
    expect(qualityDecision(-3, 0.4, v)).toEqual({ skip: false, sizeMultiplier: 1 });
    expect(qualityDecision(5, 0.4, v)).toEqual({ skip: false, sizeMultiplier: 1 });
  });

  it('stays INACTIVE with too few examples', () => {
    expect(validateQualityModel(examples(60, 3, true)).active).toBe(false);
  });

  it('when active: never increases risk (max 1.0x), only reduces it, and skips only if the skip rule was validated', () => {
    const on = { active: true, skipRuleValidated: false };
    // REGRESSION: a strong prediction used to give 1.5x; it is now capped at 1.0x
    expect(qualityDecision(0.8, 0.4, on)).toEqual({ skip: false, sizeMultiplier: 1 });
    expect(qualityDecision(50, 0.4, on).sizeMultiplier).toBe(1); // very large prediction
    expect(qualityDecision(0, 0.4, on).sizeMultiplier).toBe(1); // neutral
    expect(qualityDecision(-0.25, 0.4, on).sizeMultiplier).toBeCloseTo(0.75, 12); // bad -> reduced
    expect(qualityDecision(-5, 0.4, on).sizeMultiplier).toBe(0.5); // floor
    expect(qualityDecision(-0.2, 0.4, on).skip).toBe(false);
    expect(qualityDecision(-0.2, 0.4, { active: true, skipRuleValidated: true }).skip).toBe(true);
    expect(qualityDecision(0.5, 0.4, { active: false, skipRuleValidated: false })).toEqual({ skip: false, sizeMultiplier: 1 });
  });

  it('the size mapping does not depend on the strategy mean (stable at mean = 0, ~0, negative)', () => {
    const on = { active: true, skipRuleValidated: false };
    for (const p of [-1, -0.3, -0.01, 0, 0.001, 0.3, 2]) {
      const sizes = [0, 1e-12, -1e-12, -0.2, 0.4, 5].map((mean) => qualityDecision(p, mean, on).sizeMultiplier);
      expect(new Set(sizes).size).toBe(1);
    }
  });

  it('the size mapping is bounded, monotonic, continuous and deterministic', () => {
    const grid = Array.from({ length: 4001 }, (_, i) => -2 + i * 0.001);
    const m = grid.map(qualitySizeMultiplier);
    expect(Math.min(...m)).toBe(MIN_QUALITY_SIZE_MULTIPLIER);
    expect(Math.max(...m)).toBe(MAX_QUALITY_SIZE_MULTIPLIER);
    for (let i = 1; i < m.length; i++) {
      expect(m[i]).toBeGreaterThanOrEqual(m[i - 1]); // monotonic
      expect(Math.abs(m[i] - m[i - 1])).toBeLessThanOrEqual(0.0011); // no jumps from tiny differences
    }
    expect(qualitySizeMultiplier(NaN)).toBe(MIN_QUALITY_SIZE_MULTIPLIER); // unusable prediction -> safe side
    expect(qualitySizeMultiplier(-0.1)).toBe(qualitySizeMultiplier(-0.1));
  });
});

describe('quality model temporal validation', () => {
  // Synthetic examples where x0 predicts y. Long-running trades: label time 50 steps after the feature time.
  const make = (n: number, market = 'BTCUSDT_PERP', offset = 0) => {
    let s = 7;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
    return Array.from({ length: n }, (_, i): QualityExample => {
      const x = QUALITY_FEATURES.map((name) => (name === 'bias' ? 1 : rnd()));
      return { t: (i + offset) * 1000, labelTime: (i + offset + 50) * 1000, market, x, y: x[0] * 2 + rnd() * 0.5 };
    });
  };

  it('purges training trades whose outcome was only known after the test fold began', () => {
    const v = validateQualityModel(make(500));
    // each of the 4 test folds starts after ~50 earlier examples whose labels fall inside it
    expect(v.purgedExamples).toBeGreaterThanOrEqual(4 * 49);
    expect(v.featureVersion).toBe('quality-features/v2');
    expect(v.validationPeriod).toEqual({ from: 100 * 1000, to: 499 * 1000 });
  });

  it('with pooled markets, a lift that reverses on the unseen market is not activated', () => {
    const own = make(400, 'BTCUSDT_PERP');
    // sibling market where the relationship is reversed
    const sib = make(400, 'ETHUSDT_PERP', 0).map((e) => ({ ...e, y: -e.y }));
    const pooled = [...own, ...sib].sort((a, b) => a.t - b.t);
    const v = validateQualityModel(pooled, { primaryMarket: 'BTCUSDT_PERP' });
    expect(v.unseenMarket).not.toBeNull();
    expect(v.unseenMarket!.liftR).toBeLessThan(0);
    expect(v.active).toBe(false);
  });
});

describe('liquidity (PVSRA) inputs', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { qualityFeaturesAt, computeFeatures, INSTRUMENT_PROFILES } = require('..');
  const H1 = 3_600_000;
  const iZone = QUALITY_FEATURES.indexOf('oppositeLiquidityZoneAhead');
  const iVec = QUALITY_FEATURES.indexOf('liquidityCandleAligned');
  const base = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ t: i * H1, o: 100, h: 100.5, l: 99.5, c: 100.2, v: 10 }));

  it('flags an uncleared bearish liquidity zone just above a long entry, and not for a short', () => {
    const bars = base(300);
    // High-volume red candle with its body 100.6-101.0, above the later closes (never traded back through)
    bars[250] = { t: 250 * H1, o: 101.0, h: 101.1, l: 100.5, c: 100.6, v: 100 };
    const f = computeFeatures(bars, { ...INSTRUMENT_PROFILES.BTCUSDT_PERP, barMs: H1 });
    expect(qualityFeaturesAt(bars, f, 299, 'LONG')[iZone]).toBe(1);
    expect(qualityFeaturesAt(bars, f, 299, 'SHORT')[iZone]).toBe(0);
    // Once price trades up through the zone top it is cleared
    bars[270] = { t: 270 * H1, o: 100.2, h: 101.2, l: 100.1, c: 100.3, v: 10 };
    expect(qualityFeaturesAt(bars, computeFeatures(bars, { ...INSTRUMENT_PROFILES.BTCUSDT_PERP, barMs: H1 }), 299, 'LONG')[iZone]).toBe(0);
  });

  it('marks a liquidity candle on the signal bar as with (+1) or against (-1) the trade', () => {
    const bars = base(300);
    bars[299] = { t: 299 * H1, o: 100, h: 101.5, l: 99.9, c: 101.4, v: 100 }; // bullish, 10x volume
    const f = computeFeatures(bars, { ...INSTRUMENT_PROFILES.BTCUSDT_PERP, barMs: H1 });
    expect(qualityFeaturesAt(bars, f, 299, 'LONG')[iVec]).toBe(1);
    expect(qualityFeaturesAt(bars, f, 299, 'SHORT')[iVec]).toBe(-1);
  });

  it('a model trained on the older feature list still predicts (inputs matched by name)', () => {
    const old = QUALITY_FEATURES.filter((n) => n !== 'oppositeLiquidityZoneAhead' && n !== 'liquidityCandleAligned');
    const model = { featureNames: [...old], means: old.map(() => 0), sds: old.map(() => 1), weights: old.map((n) => (n === 'bias' ? 0.2 : n === 'isLong' ? 0.5 : 0)), lambda: 10, trainedOn: 1 };
    const x = QUALITY_FEATURES.map((n) => (n === 'isLong' ? 1 : n === 'bias' ? 1 : 7));
    expect(predictQuality(model, x)).toBeCloseTo(0.7, 9);
  });
});
