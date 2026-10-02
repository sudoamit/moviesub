import { backtestGenome, computeMetrics } from './backtest';
import { describeGenome, enumerateGenomes, genomeId, TRIGGER_FEATURES } from './genome';
import { computeFeatures, Features } from './primitives';
import { Bar, InstrumentProfile, PerformanceMetrics, StrategyGenome } from './types';

export interface SelectionCriteria {
  /** Share of bars used for in-sample screening; the rest is a hold-out the screen never sees. */
  inSampleFraction: number;
  minInSampleTrades: number;
  minInSampleTStat: number;
  minOutOfSampleTrades: number;
  minOutOfSampleExpectancyR: number;
  minOutOfSampleProfitFactor: number;
  /** Family-wise false-positive rate for the out-of-sample test (Bonferroni across screen survivors). */
  familyWiseAlpha: number;
  /** Market regime at entry: bull if the close is above the close this many days earlier, else bear. */
  regimeLookbackDays: number;
  /** Each regime with at least this many trades (in-sample + hold-out) must have positive expectancy. */
  minTradesPerRegime: number;
  /** Random-entry baselines (same filters, stop and exit; trigger replaced by random bars at the same rate). */
  baselineRuns: number;
  /** The hold-out expectancy must beat this share of the random baselines. */
  baselinePercentile: number;
}

export const DEFAULT_CRITERIA: SelectionCriteria = {
  inSampleFraction: 0.6,
  minInSampleTrades: 40,
  minInSampleTStat: 2.0,
  minOutOfSampleTrades: 30,
  minOutOfSampleExpectancyR: 0.05,
  minOutOfSampleProfitFactor: 1.15,
  familyWiseAlpha: 0.05,
  regimeLookbackDays: 90,
  minTradesPerRegime: 20,
  baselineRuns: 100,
  baselinePercentile: 0.95,
};

export interface StrategyEvaluation {
  id: string;
  description: string;
  genome: StrategyGenome;
  inSample: PerformanceMetrics;
  outOfSample: PerformanceMetrics | null;
  /** Total net R in each half of the out-of-sample period (stability check). */
  outOfSampleHalvesR: [number, number] | null;
  requiredOutOfSampleTStat: number | null;
  /** Expectancy (net R) of all trades by market regime at entry. */
  regimeExpectancy?: { bull: { trades: number; expectancyR: number }; bear: { trades: number; expectancyR: number } };
  /** Hold-out expectancy of random-entry baselines at the required percentile. */
  baselineThresholdR?: number;
  passed: boolean;
  rejectionReason?: string;
}

export interface SearchResult {
  symbol: string;
  bars: number;
  fromTime: number;
  toTime: number;
  splitTime: number;
  genomesTested: number;
  screenSurvivors: number;
  passed: StrategyEvaluation[];
  /** Best screen survivors that failed the hold-out, for transparency. */
  nearMisses: StrategyEvaluation[];
}

/** Inverse standard normal CDF (Acklam's approximation, |error| < 1.2e-9). */
export function normalQuantile(p: number): number {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) return -normalQuantile(1 - p);
  const q = p - 0.5, r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Searches the genome space on one instrument:
 * 1. screen every genome on the in-sample period;
 * 2. test only the survivors on the untouched hold-out, with a Bonferroni-adjusted significance bar
 *    (one-sided, across the number of survivors) and a stability check (both hold-out halves profitable).
 */
export function searchStrategies(
  bars: Bar[],
  profile: InstrumentProfile,
  options?: { criteria?: Partial<SelectionCriteria>; genomes?: StrategyGenome[]; features?: Features },
): SearchResult {
  const criteria = { ...DEFAULT_CRITERIA, ...(options?.criteria ?? {}) };
  const genomes = options?.genomes ?? enumerateGenomes();
  const f = options?.features ?? computeFeatures(bars, profile);
  const split = Math.floor(bars.length * criteria.inSampleFraction);
  const oosMid = split + Math.floor((bars.length - split) / 2);

  const survivors: StrategyEvaluation[] = [];
  for (const g of genomes) {
    const is = computeMetrics(backtestGenome(g, bars, f, profile, { from: 0, to: split }));
    if (is.trades >= criteria.minInSampleTrades && is.expectancyR > 0 && is.tStat >= criteria.minInSampleTStat) {
      survivors.push({
        id: genomeId(g), description: describeGenome(g), genome: g, inSample: is,
        outOfSample: null, outOfSampleHalvesR: null, requiredOutOfSampleTStat: null, passed: false,
      });
    }
  }

  const requiredT = survivors.length > 0 ? normalQuantile(1 - criteria.familyWiseAlpha / survivors.length) : null;
  for (const s of survivors) {
    const oosTrades = backtestGenome(s.genome, bars, f, profile, { from: split, to: bars.length });
    const oos = computeMetrics(oosTrades);
    const h1 = oosTrades.filter((t) => t.signalIndex < oosMid).reduce((a, t) => a + t.netR, 0);
    const h2 = oosTrades.filter((t) => t.signalIndex >= oosMid).reduce((a, t) => a + t.netR, 0);
    s.outOfSample = oos;
    s.outOfSampleHalvesR = [h1, h2];
    s.requiredOutOfSampleTStat = requiredT;
    if (oos.trades < criteria.minOutOfSampleTrades) s.rejectionReason = `hold-out trades ${oos.trades} < ${criteria.minOutOfSampleTrades}`;
    else if (oos.expectancyR < criteria.minOutOfSampleExpectancyR) s.rejectionReason = `hold-out expectancy ${oos.expectancyR.toFixed(3)}R`;
    else if (oos.profitFactor < criteria.minOutOfSampleProfitFactor) s.rejectionReason = `hold-out profit factor ${oos.profitFactor.toFixed(2)}`;
    else if (requiredT !== null && oos.tStat < requiredT) s.rejectionReason = `hold-out t ${oos.tStat.toFixed(2)} < ${requiredT.toFixed(2)} (multiple-testing adjusted)`;
    else if (h1 <= 0 || h2 <= 0) s.rejectionReason = 'hold-out not profitable in both halves';
    else {
      // Bull and bear markets: every regime with enough trades must be profitable.
      const all = backtestGenome(s.genome, bars, f, profile);
      const lookback = Math.round((criteria.regimeLookbackDays * 86_400_000) / profile.barMs);
      const regimeOf = (i: number) => (i >= lookback && bars[i].c > bars[i - lookback].c ? 'bull' : 'bear');
      const agg = { bull: { trades: 0, sum: 0 }, bear: { trades: 0, sum: 0 } };
      for (const t of all) { const r = regimeOf(t.signalIndex); agg[r].trades++; agg[r].sum += t.netR; }
      s.regimeExpectancy = {
        bull: { trades: agg.bull.trades, expectancyR: agg.bull.trades ? agg.bull.sum / agg.bull.trades : 0 },
        bear: { trades: agg.bear.trades, expectancyR: agg.bear.trades ? agg.bear.sum / agg.bear.trades : 0 },
      };
      const failing = (['bull', 'bear'] as const).filter(
        (r) => s.regimeExpectancy![r].trades >= criteria.minTradesPerRegime && s.regimeExpectancy![r].expectancyR <= 0,
      );
      if (failing.length > 0) {
        s.rejectionReason = `loses in ${failing.join(' and ')} markets`;
      } else {
        // The entry trigger must add value beyond its filters, stop and exit: beat random entries.
        s.baselineThresholdR = randomEntryBaseline(s.genome, bars, f, profile, split, criteria);
        if (oos.expectancyR <= s.baselineThresholdR) {
          s.rejectionReason = `does not beat random entries (hold-out ${oos.expectancyR.toFixed(3)}R <= ${(criteria.baselinePercentile * 100).toFixed(0)}th percentile ${s.baselineThresholdR.toFixed(3)}R)`;
        } else s.passed = true;
      }
    }
  }

  const byOos = (a: StrategyEvaluation, b: StrategyEvaluation) =>
    (b.outOfSample?.tStat ?? -Infinity) - (a.outOfSample?.tStat ?? -Infinity);
  return {
    symbol: profile.symbol,
    bars: bars.length,
    fromTime: bars[0]?.t ?? 0,
    toTime: bars[bars.length - 1]?.t ?? 0,
    splitTime: bars[split]?.t ?? 0,
    genomesTested: genomes.length,
    screenSurvivors: survivors.length,
    passed: survivors.filter((s) => s.passed).sort(byOos),
    nearMisses: survivors.filter((s) => !s.passed).sort(byOos).slice(0, 25),
  };
}

/**
 * Hold-out expectancy of the genome with its trigger replaced by random bars firing at the trigger's own
 * hold-out rate (per side); returns the `baselinePercentile` quantile over `baselineRuns` seeded runs.
 */
export function randomEntryBaseline(
  g: StrategyGenome,
  bars: Bar[],
  f: Features,
  profile: InstrumentProfile,
  split: number,
  criteria: SelectionCriteria,
): number {
  const [lk, sk] = TRIGGER_FEATURES[g.trigger];
  const longArr = f[lk] as Uint8Array, shortArr = f[sk] as Uint8Array;
  const span = Math.max(1, bars.length - split);
  let longFires = 0, shortFires = 0;
  for (let i = split; i < bars.length; i++) { longFires += longArr[i]; shortFires += shortArr[i]; }
  const pLong = longFires / span, pShort = shortFires / span;
  const results: number[] = [];
  for (let run = 1; run <= criteria.baselineRuns; run++) {
    let seed = (run * 2654435761) >>> 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const rl = new Uint8Array(f.n), rs = new Uint8Array(f.n);
    for (let i = split; i < f.n; i++) { rl[i] = rnd() < pLong ? 1 : 0; rs[i] = rnd() < pShort ? 1 : 0; }
    const rf = { ...f, [lk]: rl, [sk]: rs } as Features;
    results.push(computeMetrics(backtestGenome(g, bars, rf, profile, { from: split, to: bars.length })).expectancyR);
  }
  results.sort((a, b) => a - b);
  return results[Math.min(results.length - 1, Math.floor(criteria.baselinePercentile * results.length))];
}
