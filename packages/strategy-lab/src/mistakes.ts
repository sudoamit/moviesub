import { IntradayGenome } from './nifty-intraday';
import { StrategyGenome } from './types';

/**
 * Learning from mistakes: closed trades are reviewed once the market has shown what happened next, losses are
 * labelled with the mistake(s) that explain them, and a mistake that keeps repeating turns into a proposed fix
 * (a rule change) that must prove itself on history before it is tried live.
 */

export type Mistake =
  /** Stopped out, then price reached the planned profit anyway: the stop sat inside normal noise */
  | 'STOPPED_BY_NOISE'
  /** Was at least +1R in profit and still closed at a loss: no profit protection */
  | 'GAVE_BACK_PROFIT'
  /** Never got going (< +0.5R) and price kept going against the trade after the exit: wrong signal */
  | 'WRONG_DIRECTION'
  /** Entered far (> 2.5 ATR) from the 20 EMA: chased an extended move */
  | 'CHASED_ENTRY'
  /** Traded against the higher-timeframe trend */
  | 'AGAINST_BIG_TREND'
  /** Entered in a high-volatility period */
  | 'HIGH_VOLATILITY'
  /** NIFTY weekly expiry day */
  | 'EXPIRY_DAY';

export const MISTAKE_TEXT: Record<Mistake, string> = {
  STOPPED_BY_NOISE: 'stopped out by noise, then price went to the target',
  GAVE_BACK_PROFIT: 'was in profit (+1R) but gave it all back',
  WRONG_DIRECTION: 'wrong direction from the start',
  CHASED_ENTRY: 'chased an extended move',
  AGAINST_BIG_TREND: 'traded against the bigger trend',
  HIGH_VOLATILITY: 'entered in a high-volatility period',
  EXPIRY_DAY: 'traded on expiry day',
};

export interface TradeReviewInput {
  side: 1 | -1;
  entry: number;
  /** Initial stop (defines 1R) */
  stop: number;
  exit: number;
  /** STOP | TARGET | EOD | TRAIL | TIMEOUT ... */
  exitReason: string;
  /** Planned profit target, if the strategy had one */
  target: number | null;
  /** Highs / lows from entry to exit (inclusive) */
  during: Array<{ h: number; l: number }>;
  /** Highs / lows after the exit, over the review horizon */
  after: Array<{ h: number; l: number }>;
  context: {
    emaDistanceAtr?: number;
    bigTrend?: number;
    highVolatility?: boolean;
    isExpiry?: boolean;
  };
}

export interface TradeReview {
  outcome: 'WIN' | 'LOSS';
  resultR: number;
  /** Best open profit during the trade, in R */
  maxFavourableR: number;
  mistakes: Mistake[];
}

export function reviewTrade(t: TradeReviewInput): TradeReview {
  const risk = Math.abs(t.entry - t.stop) || 1e-9;
  const r = (px: number) => (t.side * (px - t.entry)) / risk;
  const resultR = r(t.exit);
  const mfe = t.during.length ? Math.max(...t.during.map((b) => r(t.side > 0 ? b.h : b.l))) : Math.max(0, resultR);
  const afterBest = t.after.length ? Math.max(...t.after.map((b) => r(t.side > 0 ? b.h : b.l))) : -Infinity;
  const afterWorst = t.after.length ? Math.min(...t.after.map((b) => r(t.side > 0 ? b.l : b.h))) : Infinity;
  const mistakes: Mistake[] = [];
  if (resultR < 0) {
    const goal = t.target !== null ? r(t.target) : 1;
    if (t.exitReason === 'STOP' && afterBest >= goal) mistakes.push('STOPPED_BY_NOISE');
    if (mfe >= 1) mistakes.push('GAVE_BACK_PROFIT');
    if (mfe < 0.5 && afterWorst <= resultR - 1) mistakes.push('WRONG_DIRECTION');
    if ((t.context.emaDistanceAtr ?? 0) * t.side > 2.5) mistakes.push('CHASED_ENTRY');
    if (t.context.bigTrend !== undefined && t.context.bigTrend !== 0 && t.context.bigTrend !== t.side) mistakes.push('AGAINST_BIG_TREND');
    if (t.context.highVolatility) mistakes.push('HIGH_VOLATILITY');
    if (t.context.isExpiry) mistakes.push('EXPIRY_DAY');
  }
  return { outcome: resultR >= 0 ? 'WIN' : 'LOSS', resultR, maxFavourableR: mfe, mistakes };
}

export interface RepeatedMistake {
  mistake: Mistake;
  count: number;
  losses: number;
  share: number;
}

export const MIN_REPEATS = 3;
export const MIN_SHARE_OF_LOSSES = 0.4;

/** Mistakes that keep repeating in a strategy's losses (not one-off bad luck). */
export function repeatedMistakes(reviews: TradeReview[]): RepeatedMistake[] {
  const losses = reviews.filter((r) => r.outcome === 'LOSS');
  const counts = new Map<Mistake, number>();
  for (const l of losses) for (const m of l.mistakes) counts.set(m, (counts.get(m) ?? 0) + 1);
  return [...counts.entries()]
    .map(([mistake, count]) => ({ mistake, count, losses: losses.length, share: losses.length ? count / losses.length : 0 }))
    .filter((x) => x.count >= MIN_REPEATS && x.share >= MIN_SHARE_OF_LOSSES)
    .sort((a, b) => b.share - a.share);
}

export interface ProposedFix<G> {
  mistake: Mistake;
  description: string;
  genome: G;
}

/** Rule change that addresses a mistake for a swing (lab) strategy; null when the rules cannot express one. */
export function fixLabGenome(g: StrategyGenome, m: Mistake): ProposedFix<StrategyGenome> | null {
  const withFilter = (f: string) => (g.filters.includes(f as any) ? null : { ...g, filters: [...g.filters, f as any].sort() as any });
  switch (m) {
    case 'STOPPED_BY_NOISE':
      return g.stop.type === 'ATR' ? { mistake: m, description: `wider stop: ${g.stop.atrMult} -> ${g.stop.atrMult * 1.5} x ATR`, genome: { ...g, stop: { ...g.stop, atrMult: g.stop.atrMult * 1.5 } } } : null;
    case 'GAVE_BACK_PROFIT':
      if (g.exit === 'FIXED' && g.rewardRisk > 1.5) return { mistake: m, description: `take profit earlier: ${g.rewardRisk}R -> ${g.rewardRisk - 1}R`, genome: { ...g, rewardRisk: g.rewardRisk - 1 } };
      if (g.exit === 'FIXED') return { mistake: m, description: 'trail the stop instead of a fixed target', genome: { ...g, exit: 'TRAIL', rewardRisk: 0 } };
      return null;
    case 'WRONG_DIRECTION': {
      const ng = withFilter('STRUCTURE_TREND');
      return ng ? { mistake: m, description: 'only trade with the market structure (add structure-trend filter)', genome: ng } : null;
    }
    case 'AGAINST_BIG_TREND': {
      const ng = withFilter('HTF_TREND');
      return ng ? { mistake: m, description: 'only trade with the higher-timeframe trend', genome: ng } : null;
    }
    default:
      return null;
  }
}

const WIDER_STOP: Record<string, string> = { PTS40: 'PTS60', PTS60: 'PTS80', ATR1: 'ATR2', SIGNAL_BAR: 'ATR1', ATR_40_80: 'PTS80', PTS30: 'PTS40' };

/** Rule change that addresses a mistake for a NIFTY intraday strategy; null when none applies. */
export function fixIntradayGenome(g: IntradayGenome, m: Mistake): ProposedFix<IntradayGenome> | null {
  switch (m) {
    case 'STOPPED_BY_NOISE':
      return WIDER_STOP[g.stop] ? { mistake: m, description: `wider stop: ${g.stop} -> ${WIDER_STOP[g.stop]}`, genome: { ...g, stop: WIDER_STOP[g.stop] as any } } : null;
    case 'GAVE_BACK_PROFIT':
      return g.exit === 'EOD' || g.exit === 'R3'
        ? { mistake: m, description: `take profit earlier: ${g.exit} -> R1_5`, genome: { ...g, exit: 'R1_5' } }
        : null;
    case 'WRONG_DIRECTION':
    case 'AGAINST_BIG_TREND':
      return g.dirFilter === 'NONE' ? { mistake: m, description: 'only trade with the daily trend', genome: { ...g, dirFilter: 'DAILY_TREND' } } : null;
    case 'EXPIRY_DAY':
      return g.dayFilter === 'ALL' ? { mistake: m, description: 'skip expiry days', genome: { ...g, dayFilter: 'NO_EXPIRY' } } : null;
    case 'CHASED_ENTRY':
      return g.lastEntryMin > 11 * 60 + 30 ? { mistake: m, description: 'enter only in the morning (until 11:30)', genome: { ...g, lastEntryMin: 11 * 60 + 30 } } : null;
    default:
      return null;
  }
}

export interface FixTest {
  adopt: boolean;
  reason: string;
  parent: { trades: number; mean: number; total: number; recentMean: number };
  fix: { trades: number; mean: number; total: number; recentMean: number };
}

/**
 * A fix is adopted only if, on the strategy's full history, it improves the average trade overall AND on the most
 * recent 40% of history, without cutting total profit by more than 10% (a "fix" that just trades less is not one).
 */
export function judgeFix(parentResults: number[], fixResults: number[]): FixTest {
  const stats = (v: number[]) => {
    const n = v.length, total = v.reduce((a, b) => a + b, 0);
    const recent = v.slice(Math.floor(n * 0.6));
    return { trades: n, mean: n ? total / n : 0, total, recentMean: recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0 };
  };
  const p = stats(parentResults), f = stats(fixResults);
  let adopt = false, reason: string;
  if (f.trades < 30) reason = `too few historical trades with the fix (${f.trades})`;
  else if (f.mean <= p.mean) reason = `history says no: average ${f.mean.toFixed(3)} vs ${p.mean.toFixed(3)} without the fix (the losses were bad luck, not this mistake)`;
  else if (f.recentMean <= p.recentMean) reason = `helps on older history only (recent ${f.recentMean.toFixed(3)} vs ${p.recentMean.toFixed(3)})`;
  else if (f.total < p.total * 0.9 && p.total > 0) reason = `improves the average but cuts total profit (${f.total.toFixed(1)} vs ${p.total.toFixed(1)})`;
  else { adopt = true; reason = `history confirms: average ${f.mean.toFixed(3)} vs ${p.mean.toFixed(3)}, recent ${f.recentMean.toFixed(3)} vs ${p.recentMean.toFixed(3)}`; }
  return { adopt, reason, parent: p, fix: f };
}
