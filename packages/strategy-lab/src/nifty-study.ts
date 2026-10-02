import { Bar } from './types';
import {
  describeIntraday,
  enumerateIntradayGenomes,
  IntradayExit,
  IntradayGenome,
  intradayGenomeId,
  IntradayInstrument,
  intradayStats,
  IntradayStats,
  IntradayStop,
  prepareSeries,
  simulateIntraday,
} from './nifty-intraday';

/** Upper-tail standard normal quantile (Acklam's approximation), for the multiple-testing threshold. */
export function upperZ(p: number): number {
  if (!(p > 0.5 && p < 1)) throw new Error('upperZ expects an upper-tail probability');
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -((((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1));
}

export interface NiftyStudyCandidate {
  id: string;
  description: string;
  genome: IntradayGenome;
  full: IntradayStats;
  search: IntradayStats;
  holdOut: IntradayStats;
  holdOutHalves: [number, number];
  passed: boolean;
}

export interface NiftyStudyResult {
  sessions: number;
  from: string;
  to: string;
  split: string;
  tested: number;
  screenSurvivors: number;
  requiredHoldOutT: number | null;
  instrument: IntradayInstrument;
  /** Learned option model used for pricing (null = the study's assumed model) */
  optionModel: { delta: number; thetaPerHour: number; cost: number } | null;
  passed: NiftyStudyCandidate[];
  /** Best distinct setups over the full period (unproven) to forward-test live */
  watchCandidates: NiftyStudyCandidate[];
}

export const STUDY_STOPS: IntradayStop[] = ['SIGNAL_BAR', 'ATR1', 'ATR2', 'PTS40', 'PTS60', 'PTS80', 'ATR_40_80'];
export const STUDY_EXITS: IntradayExit[] = ['EOD', 'R1_5', 'R2', 'R3', 'ST_FLIP'];

/**
 * Searches NIFTY intraday setups priced as `instrument`: screen on the first 60% of sessions (>= 40 trades,
 * positive, t >= 2), then the hold-out must be positive in both halves with t above a Bonferroni-adjusted level.
 */
export function runNiftyStudy(
  bars: Bar[],
  barMs: number,
  opts: {
    instrument?: IntradayInstrument;
    stops?: IntradayStop[];
    exits?: IntradayExit[];
    watchCount?: number;
    /** Option model learned from live trades; replaces the assumed model for `instrument` */
    model?: { delta: number; thetaPerHour: number; cost: number };
  } = {},
): NiftyStudyResult {
  const instrument = opts.instrument ?? 'ITM_OPTION';
  const s = prepareSeries(bars, barMs);
  const dates = s.sessions.map((x) => x.date);
  const split = dates[Math.floor(dates.length * 0.6)];
  const genomes = enumerateIntradayGenomes(barMs, opts.stops ?? STUDY_STOPS, opts.exits ?? STUDY_EXITS);

  const rows = genomes.map((g) => {
    const all = simulateIntraday(g, s);
    if (opts.model) {
      const m = opts.model;
      for (const t of all) t.pnl[instrument] = m.delta * t.indexPoints - m.thetaPerHour * t.hours - m.cost;
    }
    const searchTr = all.filter((t) => t.date < split);
    const holdTr = all.filter((t) => t.date >= split);
    const half = Math.floor(holdTr.length / 2);
    const sum = (v: typeof all) => v.reduce((a, t) => a + t.pnl[instrument], 0);
    return {
      // identical trade lists = the same strategy written differently (e.g. a filter that is always true)
      signature: all.map((t) => `${t.date}${t.side}`).join(','),
      id: intradayGenomeId(g),
      description: describeIntraday(g),
      genome: g,
      full: intradayStats(all, instrument),
      search: intradayStats(searchTr, instrument),
      holdOut: intradayStats(holdTr, instrument),
      holdOutHalves: [sum(holdTr.slice(0, half)), sum(holdTr.slice(half))] as [number, number],
      passed: false,
    };
  });
  const survivors = rows.filter((r) => r.search.trades >= 40 && r.search.mean > 0 && r.search.tStat >= 2);
  const needT = survivors.length ? upperZ(1 - 0.05 / survivors.length) : null;
  for (const r of survivors) {
    r.passed = needT !== null && r.holdOut.trades >= 25 && r.holdOut.mean > 0 && r.holdOut.tStat >= needT && r.holdOutHalves[0] > 0 && r.holdOutHalves[1] > 0;
  }
  // Watch candidates: best full-period t among setups with enough trades, one per trigger/filter family
  const seen = new Set<string>();
  const watchCandidates: NiftyStudyCandidate[] = [];
  for (const r of [...rows].filter((x) => x.full.trades >= 40 && x.full.mean > 0).sort((a, b) => b.full.tStat - a.full.tStat)) {
    const fam = `${r.genome.trigger}|${r.genome.dirFilter}|${r.genome.dayFilter}`;
    if (seen.has(fam) || seen.has(r.signature)) continue;
    seen.add(fam);
    seen.add(r.signature);
    const { signature: _sig, ...candidate } = r;
    watchCandidates.push(candidate);
    if (watchCandidates.length >= (opts.watchCount ?? 5)) break;
  }
  return {
    sessions: dates.length,
    from: dates[0],
    to: dates[dates.length - 1],
    split,
    tested: genomes.length,
    screenSurvivors: survivors.length,
    requiredHoldOutT: needT,
    instrument,
    passed: rows.filter((r) => r.passed).map(({ signature: _sig, ...r }) => r),
    optionModel: opts.model ?? null,
    watchCandidates,
  };
}
