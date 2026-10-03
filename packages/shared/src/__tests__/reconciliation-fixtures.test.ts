import { TransactionCostScheduleManager } from '../instrument/transaction-cost-schedule-manager';
import {
  buildCanonicalOptionTradeSetup,
  calculateOptionBuyPnL,
  calculateOptionRiskAndOutlay,
} from '../instrument/canonical-r-calculator';

/**
 * Numerical reconciliation fixtures: exact expected values, computed by hand, checked against the canonical code.
 */
describe('reconciliation fixture: BTCUSDT_SPOT long', () => {
  const schedule = TransactionCostScheduleManager.getInstance();
  const entry = 84190.98;
  const exit = 84333.08;
  const qty = 0.05;
  // Fixture inputs not given by the trade itself: USDT/INR rate and the planned stop (for R).
  const fx = 92.5;
  const stop = 84090.98;

  it('gross P&L = +7.105 USDT', () => {
    expect((exit - entry) * qty).toBeCloseTo(7.105, 9);
  });

  it('fees: 0.1% spot taker on each side, in quote and account currency', () => {
    const entryCost = schedule.calculateCostForSymbol(entry * qty, 'BTCUSDT_SPOT', fx, Date.now(), 'ENTRY', 'BUY');
    const exitCost = schedule.calculateCostForSymbol(exit * qty, 'BTCUSDT_SPOT', fx, Date.now(), 'EXIT', 'SELL');
    // entry notional 4,209.549 USDT -> fee 4.209549, booked 4.2095 USDT (4 dp) / Rs 389.38 (389.383 at 92.5)
    // exit notional 4,216.654 USDT -> fee 4.216654, booked 4.2167 USDT / Rs 390.04 (390.0405 at 92.5)
    expect(entryCost.totalChargesQuote).toBe(4.2095);
    expect(exitCost.totalChargesQuote).toBe(4.2167);
    expect(entryCost.totalChargesAccount).toBe(389.38);
    expect(exitCost.totalChargesAccount).toBe(390.04);
    // INR charges come from the exact quote fee x fx (not from the rounded quote figure)
    expect(entryCost.totalChargesAccount).toBe(Number((entry * qty * 0.001 * fx).toFixed(2)));

    // net = gross - each fee exactly once: 7.105 - 8.4262 = -1.3212 USDT (a winning price move, losing trade)
    const net = (exit - entry) * qty - entryCost.totalChargesQuote - exitCost.totalChargesQuote;
    expect(net).toBeCloseTo(-1.3212, 9);
    // INR: gross 657.2125 - charges 779.42 = -122.2075
    expect((exit - entry) * qty * fx - entryCost.totalChargesAccount - exitCost.totalChargesAccount).toBeCloseTo(-122.2075, 9);
  });

  it('R: risk = |entry - stop| x qty; gross +1.421R, net -0.26424R', () => {
    const risk = Math.abs(entry - stop) * qty; // 5 USDT
    expect(risk).toBeCloseTo(5, 9);
    expect(((exit - entry) * qty) / risk).toBeCloseTo(1.421, 9);
    expect(-1.3212 / risk).toBeCloseTo(-0.26424, 9);
  });
});

describe('reconciliation fixture: NIFTY option buy', () => {
  const entryPremium = 56.63;
  const stopPremium = 36.81;
  const qty = 65; // one lot

  it('risk per unit 19.82, planned risk Rs 1,288.30, premium outlay Rs 3,680.95', () => {
    const r = calculateOptionRiskAndOutlay(entryPremium, stopPremium, qty);
    expect(r.riskPerUnit).toBe(19.82);
    expect(r.plannedRisk).toBe(1288.3);
    expect(r.premiumOutlay).toBe(3680.95);
    expect(r.maxPremiumLoss).toBe(3680.95); // an option buyer can lose at most the premium paid
  });

  it('TP ladder 1.5R / 2.5R / 4R = 86.36 / 106.18 / 135.91', () => {
    const setup = buildCanonicalOptionTradeSetup({
      underlyingSymbol: 'NIFTY', underlyingTriggerPrice: 25000, strike: 24900, optionType: 'CE', expiry: '2026-10-06',
      lotSize: 65, entryPremium, stopPremium, quantity: qty, ratios: { rr1: 1.5, rr2: 2.5, rr3: 4 },
    });
    expect(setup.lots).toBe(1);
    expect(setup.plannedRisk).toBe(1288.3);
    expect(setup.targets.map((t) => t.price)).toEqual([86.36, 106.18, 135.91]);
    expect(setup.targets.map((t) => t.rMultiple)).toEqual([1.5, 2.5, 4]);
  });

  it('P&L at each level reconciles with R x planned risk (no leverage on option premium)', () => {
    expect(calculateOptionBuyPnL(entryPremium, stopPremium, qty)).toBe(-1288.3); // -1R
    expect(calculateOptionBuyPnL(entryPremium, 86.36, qty)).toBe(1932.45); // 1.5R = 1,932.45
    expect(calculateOptionBuyPnL(entryPremium, 106.18, qty)).toBe(3220.75); // 2.5R
    expect(calculateOptionBuyPnL(entryPremium, 135.91, qty)).toBe(5153.2); // 4R
  });

  it('rejects a fractional lot', () => {
    expect(() =>
      buildCanonicalOptionTradeSetup({
        underlyingSymbol: 'NIFTY', underlyingTriggerPrice: 25000, strike: 24900, optionType: 'CE', expiry: '2026-10-06',
        lotSize: 65, entryPremium, stopPremium, quantity: 100,
      }),
    ).toThrow(/integer multiple of lot size/);
  });
});
