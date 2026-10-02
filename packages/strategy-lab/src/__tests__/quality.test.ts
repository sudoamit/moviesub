import { fitQualityModel, predictQuality, QUALITY_FEATURES, QualityExample, qualityDecision, validateQualityModel } from '..';

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

  it('when active: sizes 0.5x..1.5x by predicted R and skips only if the skip rule was validated', () => {
    expect(qualityDecision(0.8, 0.4, { active: true, skipRuleValidated: false })).toEqual({ skip: false, sizeMultiplier: 1.5 });
    expect(qualityDecision(0.1, 0.4, { active: true, skipRuleValidated: false })).toEqual({ skip: false, sizeMultiplier: 0.5 });
    expect(qualityDecision(-0.2, 0.4, { active: true, skipRuleValidated: false }).skip).toBe(false);
    expect(qualityDecision(-0.2, 0.4, { active: true, skipRuleValidated: true }).skip).toBe(true);
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
