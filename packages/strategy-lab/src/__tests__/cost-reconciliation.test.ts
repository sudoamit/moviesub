import {
  CANONICAL_FEE_RATES, CostDataUnavailableError, estimatedSlippageRate, feeRateForSymbol, plannedCostToRisk,
  TransactionCostScheduleManager, getAuthoritativeDescriptor,
} from '@quant/shared';
import { INSTRUMENT_PROFILES } from '../profiles';
import { tradeResult } from '../trade-engine';

const schedule = TransactionCostScheduleManager.getInstance();

describe('one canonical cost model across research, gates and accounting', () => {
  it('lab profiles take their fee rates from the execution schedule (no restated numbers)', () => {
    for (const sym of ['BTCUSDT_PERP', 'ETHUSDT_PERP', 'SOLUSDT_PERP', 'XAUUSD']) {
      expect(INSTRUMENT_PROFILES[sym].takerFeeRate).toBe(feeRateForSymbol(sym, 'TAKER'));
      expect(INSTRUMENT_PROFILES[sym].makerFeeRate).toBe(feeRateForSymbol(sym, 'MAKER'));
      expect(INSTRUMENT_PROFILES[sym].slippageRate).toBe(estimatedSlippageRate(sym));
      expect(INSTRUMENT_PROFILES[sym].costBasis).toBe('SCHEDULE');
    }
    expect(INSTRUMENT_PROFILES.NIFTY.costBasis).toBe('INDEX_PROXY'); // research-only approximation, labelled
  });

  it('BTC perp reconciliation: entry 84,190.98, exit 84,333.08, qty 0.05 -> backtest fees == accounting fees', () => {
    const entry = 84190.98, exit = 84333.08, qty = 0.05;
    const gross = (exit - entry) * qty;
    expect(gross).toBeCloseTo(7.105, 9); // +7.105 USDT
    // accounting: schedule charges on entry and exit notional (quote currency USDT, fx = 1 to compare in quote)
    const entryFee = schedule.calculateCostForSymbol(entry * qty, 'BTCUSDT_PERP', 1, Date.now(), 'ENTRY', 'BUY').totalChargesQuote;
    const exitFee = schedule.calculateCostForSymbol(exit * qty, 'BTCUSDT_PERP', 1, Date.now(), 'EXIT', 'SELL').totalChargesQuote;
    expect(entryFee).toBeCloseTo(entry * qty * 0.0005, 4); // 2.1048 USDT
    expect(exitFee).toBeCloseTo(exit * qty * 0.0005, 4); // 2.1083 USDT
    // backtest: canonical tradeResult with the same fee rates and NO slippage (the fills are the actual prices)
    const noSlip = { ...INSTRUMENT_PROFILES.BTCUSDT_PERP, slippageRate: 0 };
    const stop = entry - 100;
    const r = tradeResult('LONG', entry, stop, exit, noSlip, 'TAKER', 'TAKER');
    expect(r.roundTripCostPerUnit * qty).toBeCloseTo(entryFee + exitFee, 3);
    // net P&L and R: gross minus each fee exactly once
    const net = gross - entryFee - exitFee;
    expect(net).toBeCloseTo(7.105 - (entryFee + exitFee), 9);
    expect(r.netR).toBeCloseTo((gross - r.roundTripCostPerUnit * qty) / (100 * qty), 9);
    expect(r.grossR).toBeCloseTo(142.1 / 100, 9);
  });

  it('XAUUSD reconciliation: backtest fees == accounting fees', () => {
    const entry = 2650.4, exit = 2671.9, qty = 3;
    const fees = schedule.calculateCostForSymbol(entry * qty, 'XAUUSD', 1).totalChargesQuote + schedule.calculateCostForSymbol(exit * qty, 'XAUUSD', 1, Date.now(), 'EXIT', 'SELL').totalChargesQuote;
    const r = tradeResult('LONG', entry, entry - 10, exit, { ...INSTRUMENT_PROFILES.XAUUSD, slippageRate: 0 }, 'TAKER', 'TAKER');
    expect(r.roundTripCostPerUnit * qty).toBeCloseTo(fees, 3);
  });

  it('the backtest cost gate and the pre-trade gate use the same definition (entry + exit at the stop + slippage)', () => {
    const p = INSTRUMENT_PROFILES.BTCUSDT_PERP;
    const entry = 83000, stop = 83000 * 0.997;
    const canonical = plannedCostToRisk({ entry, stop, quantity: 1, entryFeeRate: p.takerFeeRate, exitFeeRate: p.takerFeeRate, slippageRate: p.slippageRate });
    // pre-trade gate formula (trade-decision.service.ts): schedule fees at entry + at stop, plus estimated slippage
    const qty = 0.2, fx = 1;
    const fees = schedule.calculateCostForSymbol(entry * qty, 'BTCUSDT_PERP', fx).totalChargesAccount + schedule.calculateCostForSymbol(stop * qty, 'BTCUSDT_PERP', fx, Date.now(), 'EXIT', 'SELL').totalChargesAccount;
    const slippage = (entry + stop) * qty * estimatedSlippageRate('BTCUSDT_PERP') * fx;
    const gateCostInR = (fees + slippage) / ((entry - stop) * qty * fx);
    expect(gateCostInR).toBeCloseTo(canonical.costInR, 3);
  });
});

describe('cost data fails closed', () => {
  it('an unknown cost schedule throws instead of being charged as another instrument', () => {
    const d = getAuthoritativeDescriptor('BTCUSDT_SPOT');
    expect(() => schedule.calculateCost({ descriptor: { ...d, costScheduleId: 'NOT_A_SCHEDULE' as any }, turnoverQuote: 1000 })).toThrow(/COST_DATA_UNAVAILABLE.*unknown cost schedule/);
  });

  it('invalid turnover (NaN, negative, infinite) throws', () => {
    for (const t of [NaN, -1, Infinity]) expect(() => schedule.calculateCostForSymbol(t, 'BTCUSDT_PERP', 1)).toThrow(CostDataUnavailableError);
  });

  it('missing fee or slippage data for a symbol throws', () => {
    expect(() => feeRateForSymbol('NOPE', 'TAKER')).toThrow(/COST_DATA_UNAVAILABLE/);
    expect(() => feeRateForSymbol('NIFTY 25000 CE', 'TAKER')).toThrow(/not a percentage fee schedule/);
    expect(() => estimatedSlippageRate('NOPE')).toThrow(/no slippage estimate/);
    expect(() => plannedCostToRisk({ entry: 100, stop: 100, quantity: 1, entryFeeRate: 0.001, exitFeeRate: 0.001, slippageRate: 0 })).toThrow(/risk is zero/);
    expect(() => plannedCostToRisk({ entry: NaN, stop: 99, quantity: 1, entryFeeRate: 0.001, exitFeeRate: 0.001, slippageRate: 0 })).toThrow(/invalid cost inputs/);
  });

  it('the schedule manager charges the canonical rates', () => {
    expect(schedule.calculateCostForSymbol(10000, 'BTCUSDT_PERP', 1).totalChargesQuote).toBeCloseTo(10000 * CANONICAL_FEE_RATES.BINANCE_USDM_FUTURES!.taker, 6);
    expect(schedule.calculateCostForSymbol(10000, 'BTCUSDT_SPOT', 1).totalChargesQuote).toBeCloseTo(10000 * CANONICAL_FEE_RATES.BINANCE_CRYPTO_SPOT!.taker, 6);
    expect(schedule.calculateCostForSymbol(10000, 'XAUUSD', 1).totalChargesQuote).toBeCloseTo(10000 * CANONICAL_FEE_RATES.COMEX_COMMODITY_SPOT!.taker, 6);
  });
});
