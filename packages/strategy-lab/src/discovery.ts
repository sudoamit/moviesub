import { backtestGenome, computeMetrics } from './backtest';
import { enumerateGenomes, genomeId, describeGenome } from './genome';
import { aggregateBars, computeFeatures } from './primitives';
import { INSTRUMENT_PROFILES } from './profiles';
import { normalQuantile, searchStrategies, StrategyEvaluation } from './search';
import { Bar, InstrumentProfile, SimulatedTrade, StrategyGenome } from './types';
import { GoldenClearance, ResearchDataset } from './dataset';

export type LabTimeframe = '15m' | '1h' | '4h';
const FACTOR: Record<LabTimeframe, number> = { '15m': 1, '1h': 4, '4h': 16 };

/** Full-history reference statistics of a strategy (what live / shadow results are compared against). */
export interface ReferenceStats {
  expectancyR: number;
  sdR: number;
  trades: number;
  tradesPerYear: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownR: number;
  tStat: number;
  bullExpectancyR: number;
  bearExpectancyR: number;
  bullTrades: number;
  bearTrades: number;
  /** Median stop distance as a fraction of the entry price (used to choose a safe leverage). */
  medianStopPct: number;
  from: string;
  to: string;
}

export interface DiscoveryCandidate {
  id: string;
  symbol: string;
  timeframe: LabTimeframe;
  genome: StrategyGenome;
  description: string;
  /** STRICT: passed every search test. CROSS_MARKET: strong near-miss confirmed on an unseen sibling market. */
  path: 'STRICT' | 'CROSS_MARKET';
  reference: ReferenceStats;
  evidence: Record<string, unknown>;
}

export interface DiscoveryTarget {
  symbol: string;
  timeframes: LabTimeframe[];
  /** Market never used for selection, used to confirm near-misses (e.g. BTC <-> ETH). */
  sibling?: string;
}

export interface DiscoveryOptions {
  maxNewStrategies: number;
  /** Near-miss requirements on the search market's hold-out. */
  minHoldOutExpectancyR: number;
  minHoldOutTStat: number;
  /** Requirements on the sibling market (full history). */
  minSiblingTrades: number;
  minSiblingExpectancyR: number;
  siblingFamilyWiseAlpha: number;
  /** Strategy ids already registered: not proposed again. */
  existingIds?: Set<string>;
  genomes?: StrategyGenome[];
}

export const DEFAULT_DISCOVERY_OPTIONS: DiscoveryOptions = {
  maxNewStrategies: 3,
  minHoldOutExpectancyR: 0.1,
  minHoldOutTStat: 1.5,
  minSiblingTrades: 50,
  minSiblingExpectancyR: 0.1,
  siblingFamilyWiseAlpha: 0.05,
};

export function strategyId(symbol: string, timeframe: string, genome: StrategyGenome): string {
  return `${symbol}:${timeframe}:${genomeId(genome)}`;
}

function prepare(bars15: Bar[], symbol: string, tf: LabTimeframe) {
  const base = INSTRUMENT_PROFILES[symbol];
  if (!base) throw new Error(`no profile for ${symbol}`);
  const bars = FACTOR[tf] > 1 ? aggregateBars(bars15, FACTOR[tf], base.barMs) : bars15;
  const profile: InstrumentProfile = { ...base, barMs: base.barMs * FACTOR[tf] };
  return { bars, profile, features: computeFeatures(bars, profile) };
}

function regimeSplit(trades: SimulatedTrade[], bars: Bar[], profile: InstrumentProfile, lookbackDays = 90) {
  const lookback = Math.round((lookbackDays * 86_400_000) / profile.barMs);
  const bull: number[] = [], bear: number[] = [];
  for (const t of trades) {
    const i = t.signalIndex;
    (i >= lookback && bars[i].c > bars[i - lookback].c ? bull : bear).push(t.netR);
  }
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return { bull: { trades: bull.length, expectancyR: mean(bull) }, bear: { trades: bear.length, expectancyR: mean(bear) } };
}

/** Full-history reference statistics of one genome on one market. */
export function referenceStats(genome: StrategyGenome, bars15: Bar[], symbol: string, tf: LabTimeframe): ReferenceStats {
  const { bars, profile, features } = prepare(bars15, symbol, tf);
  const trades = backtestGenome(genome, bars, features, profile);
  const m = computeMetrics(trades);
  const sdR = Math.sqrt(trades.reduce((a, t) => a + (t.netR - m.expectancyR) ** 2, 0) / Math.max(1, trades.length - 1));
  const years = bars.length > 1 ? (bars[bars.length - 1].t - bars[0].t) / (365.25 * 86_400_000) : 1;
  const reg = regimeSplit(trades, bars, profile);
  const stopPcts = trades.map((t) => Math.abs(t.entry - t.stop) / t.entry).sort((a, b) => a - b);
  const medianStopPct = stopPcts.length ? stopPcts[Math.floor(stopPcts.length / 2)] : 0;
  return {
    expectancyR: m.expectancyR, sdR, trades: m.trades, tradesPerYear: m.trades / years, winRate: m.winRate,
    profitFactor: m.profitFactor, maxDrawdownR: m.maxDrawdownR, tStat: m.tStat,
    bullExpectancyR: reg.bull.expectancyR, bearExpectancyR: reg.bear.expectancyR, bullTrades: reg.bull.trades, bearTrades: reg.bear.trades,
    medianStopPct,
    from: new Date(bars[0]?.t ?? 0).toISOString(), to: new Date(bars[bars.length - 1]?.t ?? 0).toISOString(),
  };
}

function regimesOk(r: { bull: { trades: number; expectancyR: number }; bear: { trades: number; expectancyR: number } }, minTrades = 20): boolean {
  return (['bull', 'bear'] as const).every((k) => r[k].trades < minTrades || r[k].expectancyR > 0);
}

/**
 * One discovery pass: search each target market/timeframe, then
 * - STRICT: every search pass;
 * - CROSS_MARKET: near-misses with a positive, reasonably strong hold-out, profitable in bull and bear markets
 *   on the search market, then confirmed on the sibling market's FULL history (never used for selection) with a
 *   Bonferroni-adjusted t-stat across all candidates sent to the sibling.
 * Near-duplicates (same market, timeframe, trigger and sides) are collapsed and at most maxNewStrategies are returned.
 */
export function discoverStrategies(
  datasets: Record<string, Bar[]>,
  targets: DiscoveryTarget[],
  options: Partial<DiscoveryOptions> = {},
): { candidates: DiscoveryCandidate[]; runs: Array<Record<string, unknown>> } {
  const opt = { ...DEFAULT_DISCOVERY_OPTIONS, ...options };
  const genomes = opt.genomes ?? enumerateGenomes({ entryModes: ['MARKET'] }); // live engine executes market orders
  const runs: Array<Record<string, unknown>> = [];
  const strict: DiscoveryCandidate[] = [];
  const pending: Array<{ symbol: string; tf: LabTimeframe; sibling: string; ev: StrategyEvaluation }> = [];

  for (const target of targets) {
    const bars15 = datasets[target.symbol];
    if (!bars15 || bars15.length < 2000) {
      runs.push({ symbol: target.symbol, skipped: `insufficient history (${bars15?.length ?? 0} bars)` });
      continue;
    }
    for (const tf of target.timeframes) {
      const { bars, profile, features } = prepare(bars15, target.symbol, tf);
      const res = searchStrategies(bars, profile, { genomes, features });
      // Search metadata: the best of many tested genomes is selection-biased; these counts make that visible
      runs.push({
        symbol: target.symbol, timeframe: tf, bars: res.bars, from: new Date(res.fromTime).toISOString(), to: new Date(res.toTime).toISOString(),
        validationFrom: new Date(res.splitTime).toISOString(), tested: res.genomesTested, screenSurvivors: res.screenSurvivors,
        rejectedAtScreen: res.genomesTested - res.screenSurvivors, rejectedAtValidation: res.screenSurvivors - res.passed.length,
        passed: res.passed.length,
      });
      for (const p of res.passed) {
        strict.push({
          id: strategyId(target.symbol, tf, p.genome), symbol: target.symbol, timeframe: tf, genome: p.genome,
          description: p.description, path: 'STRICT', reference: referenceStats(p.genome, bars15, target.symbol, tf),
          evidence: { holdOut: p.outOfSample, regimes: p.regimeExpectancy, randomBaselineR: p.baselineThresholdR },
        });
      }
      if (!target.sibling) continue;
      for (const nm of res.nearMisses) {
        const o = nm.outOfSample;
        if (!o || o.expectancyR < opt.minHoldOutExpectancyR || o.tStat < opt.minHoldOutTStat) continue;
        if (!nm.outOfSampleHalvesR || nm.outOfSampleHalvesR[0] <= 0 || nm.outOfSampleHalvesR[1] <= 0) continue;
        const reg = regimeSplit(backtestGenome(nm.genome, bars, features, profile), bars, profile);
        if (!regimesOk(reg)) continue;
        pending.push({ symbol: target.symbol, tf, sibling: target.sibling, ev: nm });
      }
    }
  }

  // Cross-market confirmation, adjusted for the number of candidates tested on siblings
  const crossMarket: DiscoveryCandidate[] = [];
  const requiredT = pending.length ? normalQuantile(1 - opt.siblingFamilyWiseAlpha / pending.length) : Infinity;
  const siblingCache = new Map<string, ReturnType<typeof prepare>>();
  for (const p of pending) {
    const sibBars = datasets[p.sibling];
    if (!sibBars || sibBars.length < 2000) continue;
    const key = `${p.sibling}:${p.tf}`;
    if (!siblingCache.has(key)) siblingCache.set(key, prepare(sibBars, p.sibling, p.tf));
    const sib = siblingCache.get(key)!;
    const trades = backtestGenome(p.ev.genome, sib.bars, sib.features, sib.profile);
    const m = computeMetrics(trades);
    const reg = regimeSplit(trades, sib.bars, sib.profile);
    const confirmed =
      m.trades >= opt.minSiblingTrades && m.expectancyR >= opt.minSiblingExpectancyR && m.tStat >= requiredT && regimesOk(reg);
    runs.push({ crossMarketCheck: p.ev.id, symbol: p.symbol, timeframe: p.tf, sibling: p.sibling, siblingTrades: m.trades, siblingExpectancyR: m.expectancyR, siblingT: m.tStat, requiredT, confirmed });
    if (!confirmed) continue;
    const bars15 = datasets[p.symbol];
    crossMarket.push({
      id: strategyId(p.symbol, p.tf, p.ev.genome), symbol: p.symbol, timeframe: p.tf, genome: p.ev.genome,
      description: describeGenome(p.ev.genome), path: 'CROSS_MARKET', reference: referenceStats(p.ev.genome, bars15, p.symbol, p.tf),
      evidence: { holdOut: p.ev.outOfSample, sibling: { symbol: p.sibling, trades: m.trades, expectancyR: m.expectancyR, tStat: m.tStat, requiredT, regimes: reg } },
    });
  }

  // Collapse near-duplicates; prefer STRICT, then the strongest evidence
  const strength = (c: DiscoveryCandidate) =>
    (c.path === 'STRICT' ? 1000 : 0) + Number((c.evidence as any)?.sibling?.tStat ?? (c.evidence as any)?.holdOut?.tStat ?? 0);
  // Existing strategies block their own family (same market, timeframe, trigger and sides) from re-registration.
  const familyOf = (id: string) => {
    const [sym, tf, rest = ''] = id.split(':');
    const [trigger, sides] = rest.split('|');
    return `${sym}|${tf}|${trigger}|${sides}`;
  };
  const existingFamilies = new Set([...(opt.existingIds ?? [])].map(familyOf));
  const best = new Map<string, DiscoveryCandidate>();
  for (const c of [...strict, ...crossMarket]) {
    const k = `${c.symbol}|${c.timeframe}|${c.genome.trigger}|${c.genome.sides}`;
    if (opt.existingIds?.has(c.id) || existingFamilies.has(k)) continue;
    const cur = best.get(k);
    if (!cur || strength(c) > strength(cur)) best.set(k, c);
  }
  const candidates = [...best.values()].sort((a, b) => strength(b) - strength(a)).slice(0, opt.maxNewStrategies);
  return { candidates, runs };
}

/**
 * Leverage that keeps the isolated-margin liquidation about twice as far away as the strategy's typical stop
 * (liquidation distance ~ 1/L - MMR), capped at `max`. Spot-like instruments should simply use 1.
 */
export function safeLeverage(medianStopPct: number, maintenanceMarginRate = 0.004, max = 20): number {
  if (!(medianStopPct > 0)) return 1;
  const lev = Math.floor(1 / (2 * medianStopPct + maintenanceMarginRate));
  return Math.max(1, Math.min(max, lev));
}

/**
 * GOLDEN HOLDOUT GATE (evaluated once per candidate, only after it passed every development gate).
 * Pass = enough golden trades, positive expectancy after costs, and no collapse versus the validation period.
 */
export const GOLDEN_CRITERIA = {
  minTrades: 20,
  minExpectancyR: 0,
  /** Golden expectancy must be at least this share of the validation expectancy */
  minShareOfValidationExpectancy: 0.25,
};

export interface GoldenEvaluation {
  datasetVersion: string;
  from: string;
  to: string;
  trades: number;
  expectancyR: number;
  totalR: number;
  tStat: number;
  maxDrawdownR: number;
  validationExpectancyR: number | null;
  passed: boolean;
  reason: string;
}

/** Evaluates a cleared candidate on the golden holdout of its dataset (logged by the dataset). */
export function evaluateGolden(
  genome: StrategyGenome,
  dataset: ResearchDataset,
  clearance: GoldenClearance,
  symbol: string,
  tf: LabTimeframe,
  validationExpectancyR: number | null,
  criteria = GOLDEN_CRITERIA,
): GoldenEvaluation {
  const factor = FACTOR[tf];
  // Warm-up: enough development bars for every indicator (long EMA / percentile windows) at this timeframe
  const g = dataset.goldenBarsWithWarmup(clearance, factor * 600);
  const { bars, profile, features } = prepare(g.bars, symbol, tf);
  const goldenStartT = dataset.manifest.goldenStart;
  const trades = backtestGenome(genome, bars, features, profile).filter((t) => bars[t.signalIndex].t >= goldenStartT);
  const m = computeMetrics(trades);
  let passed = false, reason: string;
  if (m.trades < criteria.minTrades) reason = `only ${m.trades} golden trades (need ${criteria.minTrades})`;
  else if (m.expectancyR <= criteria.minExpectancyR) reason = `golden expectancy ${m.expectancyR.toFixed(3)}R after costs`;
  else if (validationExpectancyR !== null && validationExpectancyR > 0 && m.expectancyR < criteria.minShareOfValidationExpectancy * validationExpectancyR) {
    reason = `golden ${m.expectancyR.toFixed(3)}R collapsed vs validation ${validationExpectancyR.toFixed(3)}R`;
  } else { passed = true; reason = `golden ${m.expectancyR.toFixed(3)}R over ${m.trades} trades (t ${m.tStat.toFixed(2)})`; }
  g.record(m.trades, passed);
  return {
    datasetVersion: dataset.manifest.datasetVersion,
    from: new Date(goldenStartT).toISOString(),
    to: new Date(dataset.manifest.goldenEnd).toISOString(),
    trades: m.trades, expectancyR: m.expectancyR, totalR: m.totalR, tStat: m.tStat, maxDrawdownR: m.maxDrawdownR,
    validationExpectancyR, passed, reason,
  };
}

/** Defence in depth: research functions must never be handed bars from a dataset's golden window. */
export function assertDevelopmentOnly(bars: Bar[], dataset: { manifest: { goldenStart: number; datasetVersion: string } }): void {
  if (bars.length && bars[bars.length - 1].t >= dataset.manifest.goldenStart) {
    throw new Error(`GOLDEN_CONTAMINATION: bars reach into the golden holdout of ${dataset.manifest.datasetVersion}`);
  }
}
