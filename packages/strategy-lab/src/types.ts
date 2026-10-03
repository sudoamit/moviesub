/** One OHLCV bar. `t` is the bar OPEN time in epoch ms (UTC). */
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Side = 'LONG' | 'SHORT';

/** Session windows (UTC hours, [start, end)) used as ICT killzones for an instrument. */
export interface SessionWindow {
  name: string;
  startHourUtc: number;
  endHourUtc: number;
}

/** Per-instrument execution assumptions used by the backtester. */
export interface InstrumentProfile {
  symbol: string;
  /** Fee per side for a resting (maker) limit order, as a fraction of notional. */
  makerFeeRate: number;
  /** Fee per side for a market (taker) order, as a fraction of notional. */
  takerFeeRate: number;
  /** Adverse slippage per market fill (spread + impact), as a fraction of notional. */
  slippageRate: number;
  /** SCHEDULE: fee rates from the shared execution schedule; INDEX_PROXY: research-only approximation */
  costBasis?: 'SCHEDULE' | 'INDEX_PROXY';
  /** Bar duration in ms. */
  barMs: number;
  killzones: SessionWindow[];
  /** ICT Silver Bullet style window (UTC), if the instrument trades then. */
  silverBullet?: SessionWindow;
}

export type TriggerType =
  // SMC / ICT
  | 'FVG_RETEST'
  | 'OB_RETEST'
  | 'SWEEP_REVERSAL'
  | 'BOS_PULLBACK'
  | 'OTE_ENTRY'
  // Trend / momentum / breakout
  | 'BREAKOUT_20'
  | 'BREAKOUT_55'
  | 'EMA_CROSS'
  | 'SQUEEZE_BREAKOUT'
  | 'TREND_PULLBACK';

export const SMC_ICT_TRIGGERS: readonly TriggerType[] = ['FVG_RETEST', 'OB_RETEST', 'SWEEP_REVERSAL', 'BOS_PULLBACK', 'OTE_ENTRY'];
export const TREND_TRIGGERS: readonly TriggerType[] = ['BREAKOUT_20', 'BREAKOUT_55', 'EMA_CROSS', 'SQUEEZE_BREAKOUT', 'TREND_PULLBACK'];
export const TRIGGER_TYPES: readonly TriggerType[] = [...SMC_ICT_TRIGGERS, ...TREND_TRIGGERS];

export type FilterType =
  | 'HTF_TREND'
  | 'STRUCTURE_TREND'
  | 'PREMIUM_DISCOUNT'
  | 'KILLZONE'
  | 'SILVER_BULLET'
  | 'RECENT_DISPLACEMENT'
  | 'RECENT_SWEEP';

export const FILTER_TYPES: readonly FilterType[] = [
  'HTF_TREND',
  'STRUCTURE_TREND',
  'PREMIUM_DISCOUNT',
  'KILLZONE',
  'SILVER_BULLET',
  'RECENT_DISPLACEMENT',
  'RECENT_SWEEP',
];

/**
 * A strategy is a genome: one entry trigger, a set of confirming filters, a stop rule and an exit rule.
 * Strategies are discovered by searching over genomes and validating them out of sample.
 */
export interface StrategyGenome {
  trigger: TriggerType;
  sides: 'LONG' | 'SHORT' | 'BOTH';
  filters: FilterType[];
  stop: { type: 'STRUCTURE' | 'ATR'; atrMult: number };
  rewardRisk: number;
  /** Exit at the close of this many bars after entry if neither stop nor target was hit. */
  maxBarsInTrade: number;
  /**
   * MARKET: fill at the next bar's open (taker), exits at market (taker) - what the live paper engine does today.
   * LIMIT: resting limit at the signal close for LIMIT_ENTRY_BARS bars, filled only if price trades through it
   * (maker), target as a resting limit (maker), stop/timeout at market (taker). Requires resting-order support.
   */
  entryMode?: 'MARKET' | 'LIMIT';
  /**
   * FIXED: exit at the rewardRisk target or the stop. TRAIL: no target; a chandelier stop trails the highest
   * (lowest) close since entry by stop.atrMult x ATR (never loosens), starting from the initial stop.
   */
  exit?: 'FIXED' | 'TRAIL';
}

export const LIMIT_ENTRY_BARS = 3;

export interface SimulatedTrade {
  side: Side;
  signalIndex: number;
  entryIndex: number;
  exitIndex: number;
  entry: number;
  stop: number;
  target: number;
  exit: number;
  exitReason: 'STOP' | 'TARGET' | 'TIMEOUT' | 'END_OF_DATA';
  /** Net R after round-trip costs. */
  netR: number;
  costR: number;
}

export interface PerformanceMetrics {
  trades: number;
  winRate: number;
  expectancyR: number;
  totalR: number;
  profitFactor: number;
  maxDrawdownR: number;
  /** t-statistic of the mean net R (mean / stdev * sqrt(n)). */
  tStat: number;
}
