import { Features } from './primitives';
import { FILTER_TYPES, FilterType, Side, StrategyGenome, TRIGGER_TYPES, TriggerType } from './types';

/** Stable identifier of a genome (used as the strategy id everywhere). */
export function genomeId(g: StrategyGenome): string {
  const filters = [...g.filters].sort().join('+') || 'NONE';
  return `${g.trigger}|${g.sides}|${filters}|${g.stop.type}${g.stop.type === 'ATR' ? g.stop.atrMult : ''}|${g.exit === 'TRAIL' ? 'TRAIL' : `RR${g.rewardRisk}`}|T${g.maxBarsInTrade}|${g.entryMode ?? 'MARKET'}`;
}

/** Human-readable description of a genome. */
export function describeGenome(g: StrategyGenome): string {
  const side = g.sides === 'BOTH' ? 'Long & short' : g.sides === 'LONG' ? 'Long' : 'Short';
  const filters = g.filters.length ? ` when ${g.filters.join(', ')}` : '';
  const stop = g.stop.type === 'STRUCTURE' ? 'structural stop' : `${g.stop.atrMult}x ATR stop`;
  const entry = g.entryMode === 'LIMIT' ? 'limit entry' : 'market entry';
  const exit = g.exit === 'TRAIL' ? `trailing ${g.stop.atrMult || 2.5}x ATR exit` : `target ${g.rewardRisk}R`;
  return `${side} on ${g.trigger}${filters}; ${entry}, ${stop}, ${exit}, max ${g.maxBarsInTrade} bars`;
}

function triggerFires(g: StrategyGenome, f: Features, i: number, side: Side): boolean {
  const L = side === 'LONG';
  switch (g.trigger) {
    case 'FVG_RETEST':
      return (L ? f.fvgRetestLong[i] : f.fvgRetestShort[i]) === 1;
    case 'OB_RETEST':
      return (L ? f.obRetestLong[i] : f.obRetestShort[i]) === 1;
    case 'SWEEP_REVERSAL':
      return (L ? f.sweepLong[i] : f.sweepShort[i]) === 1;
    case 'BOS_PULLBACK':
      return (L ? f.bosPullbackLong[i] : f.bosPullbackShort[i]) === 1;
    case 'OTE_ENTRY':
      return (L ? f.oteLong[i] : f.oteShort[i]) === 1;
    default: {
      const [lk, sk] = TRIGGER_FEATURES[g.trigger];
      return ((L ? f[lk] : f[sk]) as Uint8Array)[i] === 1;
    }
  }
}

/** Feature arrays (long, short) behind each trigger - also used to build random-entry baselines. */
export const TRIGGER_FEATURES: Record<TriggerType, [keyof Features, keyof Features]> = {
  FVG_RETEST: ['fvgRetestLong', 'fvgRetestShort'],
  OB_RETEST: ['obRetestLong', 'obRetestShort'],
  SWEEP_REVERSAL: ['sweepLong', 'sweepShort'],
  BOS_PULLBACK: ['bosPullbackLong', 'bosPullbackShort'],
  OTE_ENTRY: ['oteLong', 'oteShort'],
  BREAKOUT_20: ['breakout20Long', 'breakout20Short'],
  BREAKOUT_55: ['breakout55Long', 'breakout55Short'],
  EMA_CROSS: ['emaCrossLong', 'emaCrossShort'],
  SQUEEZE_BREAKOUT: ['squeezeBreakoutLong', 'squeezeBreakoutShort'],
  TREND_PULLBACK: ['trendPullbackLong', 'trendPullbackShort'],
};

function filterPasses(filter: FilterType, f: Features, i: number, side: Side): boolean {
  const dir = side === 'LONG' ? 1 : -1;
  switch (filter) {
    case 'HTF_TREND':
      return f.htfTrend[i] === dir;
    case 'STRUCTURE_TREND':
      return f.structureTrend[i] === dir;
    case 'PREMIUM_DISCOUNT':
      // Longs from discount, shorts from premium
      return f.rangePosition[i] === dir;
    case 'KILLZONE':
      return f.inKillzone[i] === 1;
    case 'SILVER_BULLET':
      return f.inSilverBullet[i] === 1;
    case 'RECENT_DISPLACEMENT':
      return (side === 'LONG' ? f.recentDisplacementUp[i] : f.recentDisplacementDown[i]) === 1;
    case 'RECENT_SWEEP':
      return (side === 'LONG' ? f.recentSweepLong[i] : f.recentSweepShort[i]) === 1;
  }
}

/** Returns the side this genome signals at bar i (decided on bar i's close), or null. */
export function signalAt(g: StrategyGenome, f: Features, i: number): Side | null {
  const sides: Side[] = g.sides === 'BOTH' ? ['LONG', 'SHORT'] : [g.sides];
  for (const side of sides) {
    if (!triggerFires(g, f, i, side)) continue;
    if (g.filters.every((flt) => filterPasses(flt, f, i, side))) return side;
  }
  return null;
}

/** Stop price for a signal at bar i, before entry. */
export function stopFor(g: StrategyGenome, f: Features, i: number, side: Side, refPrice: number): number {
  const a = f.atr[i];
  if (g.stop.type === 'ATR') {
    return side === 'LONG' ? refPrice - g.stop.atrMult * a : refPrice + g.stop.atrMult * a;
  }
  return side === 'LONG' ? f.recentLow[i] - 0.1 * a : f.recentHigh[i] + 0.1 * a;
}

/**
 * The search space: every trigger, side mode and stop/exit rule, with filter sets of up to `maxFilters`
 * filters (SILVER_BULLET implies a session filter, so it is never combined with KILLZONE).
 */
export function enumerateGenomes(options?: {
  maxFilters?: number;
  rewardRisks?: number[];
  atrMults?: number[];
  maxBars?: number[];
  entryModes?: Array<'MARKET' | 'LIMIT'>;
  triggers?: readonly TriggerType[];
  /** Also generate trailing-stop variants (no fixed target) with this max holding period in bars. */
  trailMaxBars?: number | null;
}): StrategyGenome[] {
  const maxFilters = options?.maxFilters ?? 3;
  const rrs = options?.rewardRisks ?? [1.5, 2, 3];
  const atrMults = options?.atrMults ?? [1.5, 2.5];
  const maxBars = options?.maxBars ?? [32];
  const entryModes = options?.entryModes ?? ['MARKET'];
  const triggers = options?.triggers ?? TRIGGER_TYPES;
  const trailMaxBars = options?.trailMaxBars === undefined ? 160 : options.trailMaxBars;

  const filterSets: FilterType[][] = [];
  const total = 1 << FILTER_TYPES.length;
  for (let mask = 0; mask < total; mask++) {
    const set = FILTER_TYPES.filter((_, b) => mask & (1 << b));
    if (set.length > maxFilters) continue;
    if (set.includes('KILLZONE') && set.includes('SILVER_BULLET')) continue;
    filterSets.push(set);
  }

  const stops: StrategyGenome['stop'][] = [
    { type: 'STRUCTURE', atrMult: 0 },
    ...atrMults.map((m) => ({ type: 'ATR' as const, atrMult: m })),
  ];
  const out: StrategyGenome[] = [];
  for (const trigger of triggers) {
    for (const sides of ['LONG', 'SHORT', 'BOTH'] as const) {
      for (const filters of filterSets) {
        for (const stop of stops) {
          for (const entryMode of entryModes) {
            for (const rewardRisk of rrs) {
              for (const maxBarsInTrade of maxBars) {
                out.push({ trigger, sides, filters, stop, rewardRisk, maxBarsInTrade, entryMode, exit: 'FIXED' });
              }
            }
            // Trailing exits only with ATR stops (the trail distance is the stop's ATR multiple)
            if (trailMaxBars && stop.type === 'ATR') {
              out.push({ trigger, sides, filters, stop, rewardRisk: 0, maxBarsInTrade: trailMaxBars, entryMode, exit: 'TRAIL' });
            }
          }
        }
      }
    }
  }
  return out;
}
