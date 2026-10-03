import {
  Bar, exitRulesOf, InstrumentProfile, maxDrawdown, openPosition, PerformanceSummary, PositionState, stepBar, StrategyGenome,
  summarizePerformance, tradeResult,
} from '@quant/strategy-lab';
import { PositionSizer } from '@quant/risk-engine';

/**
 * Pure lifecycle rules for lab strategies (no I/O), shared by the shadow and live runners.
 * They reproduce the backtester's semantics bar by bar so shadow results are comparable with the backtest.
 */

export interface OpenLabTrade {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  initialStop: number;
  currentStop: number;
  extremeClose: number;
  barsHeld: number;
}

export interface AdvanceResult {
  trade: OpenLabTrade;
  closed: null | { exitPrice: number; exitReason: 'STOP' | 'TARGET' | 'TIMEOUT'; exitTime: number };
}

/**
 * Advances an open trade over newly closed bars with the CANONICAL trade engine (@quant/strategy-lab
 * trade-engine.ts) - the same code the backtester runs, so shadow / live exits cannot diverge from the backtest.
 * The live runner executes MARKET entries only (see assertLiveRunnable).
 */
export function advanceTrade(
  trade: OpenLabTrade,
  newBars: Array<{ bar: Bar; atr: number }>,
  genome: StrategyGenome,
): AdvanceResult {
  const rules = exitRulesOf(genome);
  let pos: PositionState = {
    ...openPosition(trade.side, trade.entryPrice, trade.initialStop, rules),
    currentStop: trade.currentStop,
    extremeClose: trade.extremeClose,
    barsHeld: trade.barsHeld,
  };
  const toOpen = (p: PositionState): OpenLabTrade => ({
    side: p.side, entryPrice: p.entryPrice, initialStop: p.initialStop, currentStop: p.currentStop, extremeClose: p.extremeClose, barsHeld: p.barsHeld,
  });
  for (const { bar, atr } of newBars) {
    const step = stepBar(pos, bar, atr, rules);
    pos = step.state;
    if (step.exit) return { trade: toOpen(pos), closed: { exitPrice: step.exit.price, exitReason: step.exit.reason, exitTime: bar.t } };
  }
  return { trade: toOpen(pos), closed: null };
}

/**
 * The live / shadow runner fills entries at market. A LIMIT-entry genome would be traded differently from its
 * backtest (maker fill at a resting price), so it is refused rather than silently run as MARKET.
 */
export function assertLiveRunnable(genome: StrategyGenome): void {
  if (genome.entryMode === 'LIMIT') throw new Error('LIMIT_ENTRY_NOT_SUPPORTED_LIVE: the lab runner fills entries at market only');
}

/** Net R of a closed lab trade with the canonical cost model (market entry and market exit: taker + slippage). */
export function netR(trade: OpenLabTrade, exitPrice: number, profile: InstrumentProfile): { netR: number; costR: number } {
  const r = tradeResult(trade.side, trade.entryPrice, trade.initialStop, exitPrice, profile, 'TAKER', 'TAKER');
  return { netR: r.netR, costR: r.costR };
}

export interface BacktestReference {
  expectancyR: number;
  sdR: number;
  trades: number;
  maxDrawdownR: number;
}

/**
 * LIFECYCLE EVIDENCE (rules version LIFECYCLE_RULES_VERSION).
 *
 *   UNVALIDATED          development evidence missing / too thin / no golden-holdout pass: may shadow, never promote
 *   BACKTEST_VALIDATED   development + validation + golden evidence present, no shadow trades yet
 *   SHADOW_RUNNING       collecting shadow trades (fewer than minShadowTrades)
 *   SHADOW_NOT_DISPROVEN enough shadow trades, not clearly losing, but promotion checks not all met
 *   SHADOW_CONFIRMED     every promotion check met -> promoted to LIVE
 *   LIVE / RETIRED
 *
 * "Not statistically worse than the backtest" is NOT evidence that a strategy works, so promotion requires the
 * LOWER bootstrap confidence bound of shadow net expectancy (after costs) to clear minShadowCiLowR, plus economic
 * checks (drawdown, losing streak, degradation vs the out-of-sample validation period). Retirement is the safe
 * direction and stays quick. Results from other strategy versions are never counted (see versioning.ts).
 */
export const LIFECYCLE_RULES_VERSION = 'lifecycle/v2';

export type EvidenceState =
  | 'UNVALIDATED'
  | 'BACKTEST_VALIDATED'
  | 'SHADOW_RUNNING'
  | 'SHADOW_NOT_DISPROVEN'
  | 'SHADOW_CONFIRMED'
  | 'LIVE'
  | 'RETIRED';

export interface PromotionRules {
  /** Development-period backtest trades (reference statistics) */
  minBacktestTrades: number;
  /** Trades in the search's out-of-sample validation period */
  minValidationTrades: number;
  /** Shadow trades of the current strategy version before promotion is considered */
  minShadowTrades: number;
  /** Lower bound of the 95% bootstrap CI of shadow expectancy (net R) must exceed this */
  minShadowCiLowR: number;
  /** Shadow max drawdown may not exceed this multiple of the backtest's worst drawdown */
  maxShadowDrawdownMultiple: number;
  /** Longest run of consecutive shadow losses allowed */
  maxLosingStreak: number;
  /** Shadow expectancy must be at least this share of the validation-period expectancy */
  minShareOfValidationExpectancy: number;
  /** Retirement: considered once this many trades exist in the current mode */
  minTradesForRetirement: number;
  /** Retire when the UPPER CI bound of expectancy is below this (clearly losing) */
  retireCiHighR: number;
  /** Retire when the mean is this many standard errors (backtest SD) below the backtest mean */
  retireZ: number;
  /** Retire a LIVE strategy whose drawdown exceeds this multiple of the backtest's worst */
  retireDrawdownMultiple: number;
}

export const DEFAULT_PROMOTION_RULES: PromotionRules = {
  minBacktestTrades: Number(process.env.LAB_MIN_BACKTEST_TRADES || 100),
  minValidationTrades: Number(process.env.LAB_MIN_VALIDATION_TRADES || 30),
  minShadowTrades: Number(process.env.LAB_MIN_SHADOW_TRADES || 30),
  minShadowCiLowR: Number(process.env.LAB_MIN_SHADOW_CI_LOW_R || 0),
  maxShadowDrawdownMultiple: Number(process.env.LAB_MAX_SHADOW_DD_MULTIPLE || 1),
  maxLosingStreak: Number(process.env.LAB_MAX_LOSING_STREAK || 10),
  minShareOfValidationExpectancy: Number(process.env.LAB_MIN_SHARE_OF_VALIDATION || 0.5),
  minTradesForRetirement: 15,
  retireCiHighR: 0,
  retireZ: -2,
  retireDrawdownMultiple: 2,
};

/** z-score of the observed mean against the backtest mean using the backtest SD. A RETIREMENT signal only. */
export function zVsBacktest(ref: BacktestReference, results: number[]): number {
  if (results.length === 0 || !(ref.sdR > 0)) return 0;
  const mean = results.reduce((a, b) => a + b, 0) / results.length;
  return (mean - ref.expectancyR) / (ref.sdR / Math.sqrt(results.length));
}

export function drawdownR(results: number[]): number {
  return maxDrawdown(results);
}

export interface EvidenceCheck { name: string; passed: boolean; value: number | string | null; required: string }

export interface EvidenceAssessment {
  state: EvidenceState;
  action: 'NONE' | 'PROMOTE' | 'RETIRE';
  reason: string;
  rulesVersion: string;
  checks: EvidenceCheck[];
  evidence: {
    backtest: { trades: number; expectancyR: number; maxDrawdownR: number } | null;
    validation: { trades: number; expectancyR: number; tStat: number | null } | null;
    golden: { passed: boolean; trades: number; expectancyR: number; datasetVersion: string | null } | null;
    current: PerformanceSummary;
    dataQualityViolations: number;
  };
}

/** Reference statistics + discovery evidence stored on a lab strategy (backtestJson). */
export interface StrategyReference extends BacktestReference {
  evidence?: { holdOut?: { trades?: number; expectancyR?: number; tStat?: number } | null } | null;
  golden?: { passed?: boolean; trades?: number; expectancyR?: number; datasetVersion?: string } | null;
}

/** Decides the evidence state and automatic action from the current strategy version's closed results. */
export function assessLabEvidence(
  status: 'SHADOW' | 'LIVE' | 'RETIRED',
  ref: StrategyReference,
  results: number[],
  dataQualityViolations = 0,
  rules: PromotionRules = DEFAULT_PROMOTION_RULES,
): EvidenceAssessment {
  const current = summarizePerformance(results);
  const v = ref?.evidence?.holdOut ?? null;
  const g = ref?.golden ?? null;
  const evidence: EvidenceAssessment['evidence'] = {
    backtest: ref && Number.isFinite(ref.trades) ? { trades: ref.trades, expectancyR: ref.expectancyR, maxDrawdownR: ref.maxDrawdownR } : null,
    validation: v && Number.isFinite(Number(v.trades)) ? { trades: Number(v.trades), expectancyR: Number(v.expectancyR), tStat: v.tStat ?? null } : null,
    golden: g ? { passed: g.passed === true, trades: Number(g.trades ?? 0), expectancyR: Number(g.expectancyR ?? 0), datasetVersion: g.datasetVersion ?? null } : null,
    current,
    dataQualityViolations,
  };
  const base = { rulesVersion: LIFECYCLE_RULES_VERSION, evidence };
  if (status === 'RETIRED') return { ...base, state: 'RETIRED', action: 'NONE', reason: 'retired', checks: [] };

  // Retirement (shadow or live): clearly losing, far below the backtest, or (live) an excessive drawdown
  const n = current.trades;
  const z = zVsBacktest(ref, results);
  if (n >= rules.minTradesForRetirement && current.ciHighR < rules.retireCiHighR) {
    return { ...base, state: 'RETIRED', action: 'RETIRE', checks: [], reason: `clearly losing: 95% CI of expectancy [${current.ciLowR.toFixed(3)}, ${current.ciHighR.toFixed(3)}]R over ${n} trades` };
  }
  if (n >= rules.minTradesForRetirement && z < rules.retireZ) {
    return { ...base, state: 'RETIRED', action: 'RETIRE', checks: [], reason: `${status.toLowerCase()} results far below backtest (z ${z.toFixed(2)} over ${n} trades)` };
  }
  if (status === 'LIVE' && ref.maxDrawdownR > 0 && current.maxDrawdownR > rules.retireDrawdownMultiple * ref.maxDrawdownR) {
    return { ...base, state: 'RETIRED', action: 'RETIRE', checks: [], reason: `drawdown ${current.maxDrawdownR.toFixed(1)}R exceeds ${rules.retireDrawdownMultiple}x backtest worst ${ref.maxDrawdownR.toFixed(1)}R` };
  }
  if (status === 'LIVE') return { ...base, state: 'LIVE', action: 'NONE', checks: [], reason: `live: ${n} trades, ${current.totalR.toFixed(2)}R` };

  // Development evidence (needed before shadow results can ever promote)
  const dev: EvidenceCheck[] = [
    { name: 'backtestTrades', passed: (evidence.backtest?.trades ?? 0) >= rules.minBacktestTrades, value: evidence.backtest?.trades ?? null, required: `>= ${rules.minBacktestTrades}` },
    { name: 'validationTrades', passed: (evidence.validation?.trades ?? 0) >= rules.minValidationTrades, value: evidence.validation?.trades ?? null, required: `>= ${rules.minValidationTrades}` },
    { name: 'goldenHoldoutPassed', passed: evidence.golden?.passed === true, value: evidence.golden ? String(evidence.golden.passed) : null, required: 'passed' },
  ];
  // Shadow evidence
  const validationR = evidence.validation?.expectancyR ?? NaN;
  const shadow: EvidenceCheck[] = [
    { name: 'shadowTrades', passed: n >= rules.minShadowTrades, value: n, required: `>= ${rules.minShadowTrades}` },
    { name: 'shadowExpectancyCiLow', passed: n > 1 && current.ciLowR > rules.minShadowCiLowR, value: Number.isFinite(current.ciLowR) ? current.ciLowR : null, required: `> ${rules.minShadowCiLowR}R` },
    { name: 'shadowDrawdown', passed: ref.maxDrawdownR > 0 && current.maxDrawdownR <= rules.maxShadowDrawdownMultiple * ref.maxDrawdownR, value: current.maxDrawdownR, required: `<= ${rules.maxShadowDrawdownMultiple} x ${ref.maxDrawdownR?.toFixed?.(1)}R` },
    { name: 'losingStreak', passed: current.longestLosingStreak <= rules.maxLosingStreak, value: current.longestLosingStreak, required: `<= ${rules.maxLosingStreak}` },
    { name: 'noDegradationVsValidation', passed: Number.isFinite(validationR) && validationR > 0 && current.meanR >= rules.minShareOfValidationExpectancy * validationR, value: current.meanR, required: `>= ${rules.minShareOfValidationExpectancy} x validation ${Number.isFinite(validationR) ? validationR.toFixed(3) : 'n/a'}R` },
    { name: 'noDataQualityViolations', passed: dataQualityViolations === 0, value: dataQualityViolations, required: '0' },
  ];
  const checks = [...dev, ...shadow];
  const failedDev = dev.filter((c) => !c.passed).map((c) => c.name);
  if (failedDev.length) {
    return { ...base, state: 'UNVALIDATED', action: 'NONE', checks, reason: `not promotable: development evidence missing (${failedDev.join(', ')}); shadow results are recorded but cannot promote` };
  }
  if (n === 0) return { ...base, state: 'BACKTEST_VALIDATED', action: 'NONE', checks, reason: 'validated in development and golden holdout; waiting for shadow trades' };
  if (n < rules.minShadowTrades) return { ...base, state: 'SHADOW_RUNNING', action: 'NONE', checks, reason: `${n}/${rules.minShadowTrades} shadow trades` };
  const failed = shadow.filter((c) => !c.passed).map((c) => c.name);
  if (failed.length) return { ...base, state: 'SHADOW_NOT_DISPROVEN', action: 'NONE', checks, reason: `promotion checks not met: ${failed.join(', ')}` };
  return {
    ...base, state: 'SHADOW_CONFIRMED', action: 'PROMOTE', checks,
    reason: `shadow confirmed: ${n} trades, expectancy ${current.meanR.toFixed(3)}R (95% CI ${current.ciLowR.toFixed(3)} to ${current.ciHighR.toFixed(3)}), drawdown ${current.maxDrawdownR.toFixed(1)}R`,
  };
}

/** Starting capital allocated to each instrument (LAB_CAPITAL_PER_INSTRUMENT, INR). */
export const CAPITAL_PER_INSTRUMENT = Number(process.env.LAB_CAPITAL_PER_INSTRUMENT || 50_000);

/** Highest risk per trade the lab may request (LAB_MAX_RISK_PERCENT); the account risk limit in placeOrder still applies. */
export const LAB_MAX_RISK_PERCENT = Number(process.env.LAB_MAX_RISK_PERCENT || 5);

/**
 * Position size from the instrument's own (compounding) balance, computed by the canonical server-side sizer
 * (PositionSizer - the same one the trade-decision pipeline uses):
 * risk = balance x riskPct x sizeMultiplier; quantity = risk / stop distance (in INR per unit), rounded down to
 * the instrument lot; the margin (notional / leverage) may never exceed the balance - the size is reduced to fit.
 * The FX rate is the caller's point-in-time USDT/INR rate, so sizing and the logged risk use the same rate.
 */
export function sizeFromCoinBalance(a: {
  symbol: string; balance: number; riskPct: number; sizeMultiplier: number; entry: number; stopDistance: number;
  fx: number; leverage: number; side?: 'LONG' | 'SHORT';
}): { qty: number; riskInr: number; marginInr: number; rejectionReason?: string } {
  if (!(a.balance > 0) || !(a.stopDistance > 0) || !(a.entry > 0) || !(a.fx > 0)) return { qty: 0, riskInr: 0, marginInr: 0 };
  const side = a.side ?? 'LONG';
  const fx = a.fx;
  const sizing = PositionSizer.calculatePosition({
    accountBalance: a.balance,
    availableMargin: a.balance,
    riskPercentage: a.riskPct * a.sizeMultiplier,
    maxRiskPercentage: LAB_MAX_RISK_PERCENT,
    entryPrice: a.entry,
    stopLoss: side === 'LONG' ? a.entry - a.stopDistance : a.entry + a.stopDistance,
    direction: side === 'LONG' ? 'BUY' : 'SELL',
    symbol: a.symbol,
    requestedLeverage: a.leverage,
    currencyConverter: {
      getRate: (from: any, to: any, ts: number) => ({
        convertedAmount: fx, originalAmount: 1, fromCurrency: from, toCurrency: to, fxPair: `${from}/${to}`, fxRate: fx,
        fxTimestamp: ts, fxSource: 'LAB_POINT_IN_TIME', fxVersion: 'lab', fxSnapshotHash: `lab:${fx}`,
      }),
    } as any,
  } as any);
  const qty = sizing.isValid ? Number(sizing.roundedUnits) : 0;
  if (!(qty > 0)) return { qty: 0, riskInr: 0, marginInr: 0, rejectionReason: sizing.rejectionReason };
  return {
    qty,
    riskInr: Number((qty * a.stopDistance * fx).toFixed(2)),
    marginInr: Number(((qty * a.entry * fx) / a.leverage).toFixed(2)),
  };
}

/** Shadow balance: the starting capital compounded by each closed shadow trade's R at the given risk. */
export function compoundedBalance(start: number, riskPct: number, results: Array<{ netR: number; sizeMultiplier?: number | null }>): number {
  return results.reduce((bal, r) => bal * (1 + (riskPct / 100) * r.netR * (r.sizeMultiplier ?? 1)), start);
}
