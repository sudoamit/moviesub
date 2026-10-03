import { CostScheduleId, getAuthoritativeDescriptor } from './instrument-descriptor';

/**
 * CANONICAL COST MODEL (single source of every percentage fee rate and every slippage estimate).
 *
 * - Fee rates (ACTUAL schedule): charged by TransactionCostScheduleManager on execution (paper trading, journal)
 *   and used by the strategy lab's instrument profiles. Execution sends market orders, which pay the TAKER rate.
 * - Slippage (ESTIMATED): research and pre-trade estimates only. Executed trades carry their real fill prices,
 *   so accounting never adds an estimated slippage on top of a fill.
 *
 * Cost-vs-risk (the same definition in the backtester and the pre-trade gate):
 *   entry cost = entry notional x (entry fee rate + slippage)
 *   exit cost  = notional at the STOP x (taker fee rate + slippage)        (the worst planned exit)
 *   cost in R  = (entry cost + exit cost) / planned risk  must not exceed MAX_COST_TO_RISK
 */
export const COST_MODEL_VERSION = 'costs/v2';

export type Liquidity = 'MAKER' | 'TAKER';

/** Percentage fee schedules (fraction of notional per side, in the quote currency). */
export const CANONICAL_FEE_RATES: Partial<Record<CostScheduleId, { maker: number; taker: number }>> = {
  BINANCE_CRYPTO_SPOT: { maker: 0.001, taker: 0.001 },
  BINANCE_USDM_FUTURES: { maker: 0.0002, taker: 0.0005 },
  COMEX_COMMODITY_SPOT: { maker: 0.0002, taker: 0.0002 },
};

/** ESTIMATED slippage per market fill (fraction of price), by instrument. */
export const ESTIMATED_SLIPPAGE_RATES: Record<string, number> = {
  BTCUSDT_PERP: 0.0001,
  ETHUSDT_PERP: 0.0001,
  BTCUSDT_SPOT: 0.0001,
  XAUUSD: 0.0001,
  SOLUSDT_PERP: 0.0002,
  XRPUSDT_PERP: 0.0002,
  DOGEUSDT_PERP: 0.0002,
  BNBUSDT_PERP: 0.0002,
  ADAUSDT_PERP: 0.0002,
  LINKUSDT_PERP: 0.0002,
  AVAXUSDT_PERP: 0.0002,
};

export const MAX_COST_TO_RISK = 0.5;

export class CostDataUnavailableError extends Error {
  readonly code = 'COST_DATA_UNAVAILABLE';
  constructor(message: string) {
    super(`COST_DATA_UNAVAILABLE: ${message}`);
  }
}

/** Fee rate per side for a symbol; throws CostDataUnavailableError when it has no percentage schedule. */
export function feeRateForSymbol(symbol: string, liquidity: Liquidity): number {
  let id: CostScheduleId;
  try {
    id = getAuthoritativeDescriptor(symbol).costScheduleId;
  } catch (e: any) {
    throw new CostDataUnavailableError(`no instrument descriptor for ${symbol} (${e?.message})`);
  }
  const rates = CANONICAL_FEE_RATES[id];
  if (!rates) throw new CostDataUnavailableError(`${symbol} uses schedule ${id}, which is not a percentage fee schedule`);
  return liquidity === 'MAKER' ? rates.maker : rates.taker;
}

/** Fee rate of a percentage schedule by id (research markets that share an executable venue's schedule). */
export function feeRateForSchedule(scheduleId: CostScheduleId, liquidity: Liquidity): number {
  const rates = CANONICAL_FEE_RATES[scheduleId];
  if (!rates) throw new CostDataUnavailableError(`schedule ${scheduleId} is not a percentage fee schedule`);
  return liquidity === 'MAKER' ? rates.maker : rates.taker;
}

export function estimatedSlippageRate(symbol: string): number {
  const r = ESTIMATED_SLIPPAGE_RATES[symbol.toUpperCase()];
  if (r === undefined) throw new CostDataUnavailableError(`no slippage estimate for ${symbol}`);
  return r;
}

/**
 * Cost-vs-risk of a planned trade with the canonical definition (see module doc). All prices in the quote
 * currency; quantity in units of the underlying (contract size already applied). Throws on invalid inputs.
 */
export function plannedCostToRisk(a: {
  entry: number;
  stop: number;
  quantity: number;
  entryFeeRate: number;
  exitFeeRate: number;
  slippageRate: number;
}): { entryCost: number; exitCost: number; risk: number; costInR: number } {
  const vals = [a.entry, a.stop, a.quantity, a.entryFeeRate, a.exitFeeRate, a.slippageRate];
  if (vals.some((v) => !Number.isFinite(v)) || !(a.entry > 0) || !(a.stop > 0) || !(a.quantity > 0) || a.entryFeeRate < 0 || a.exitFeeRate < 0 || a.slippageRate < 0) {
    throw new CostDataUnavailableError('invalid cost inputs');
  }
  const risk = Math.abs(a.entry - a.stop) * a.quantity;
  if (!(risk > 0)) throw new CostDataUnavailableError('planned risk is zero');
  const entryCost = a.entry * a.quantity * (a.entryFeeRate + a.slippageRate);
  const exitCost = a.stop * a.quantity * (a.exitFeeRate + a.slippageRate);
  return { entryCost, exitCost, risk, costInR: (entryCost + exitCost) / risk };
}
