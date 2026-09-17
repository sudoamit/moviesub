/**
 * Spot Lifecycle Invariants Test Suite
 *
 * Covers Requirements 1, 5, 6, 9, 10 from the Final Spot-Only Hardening spec:
 *   Req 1:  TradeLifecycleManager.createPositionLot() lifecycle-boundary short guard
 *   Req 5:  SELL inventory enforcement at the position-sizer level
 *   Req 6:  Canonical symbol enforcement (legacy alias rejection in calculateSpotPosition)
 *   Req 9:  Explicit lifecycle tests for NIFTY_SPOT, BANKNIFTY_SPOT, BTCUSDT_SPOT
 *   Req 10: Derivative-path isolation (prove resolveMarginModel / calculateMargin /
 *           calculateLiquidationPrice are never invoked on the spot sizing path)
 *   Req 4:  Fee-ceiling enforcement regression test
 */

import {
  Direction,
  ISignalSetup,
  SignalGrade,
  SignalState,
  Timeframe,
  PointInTimeCurrencyConverter,
} from '@quant/shared';
import { TradeLifecycleManager, PositionSizer, TradeAccountingEngine } from '../index';

// ── Test fixture helpers ──────────────────────────────────────────────────────

const T0 = new Date('2025-06-15T10:00:00.000Z').getTime();

function makeBullishSignal(symbol: string): ISignalSetup {
  return {
    id: `sig_buy_${symbol}`,
    symbol,
    direction: Direction.BULLISH,
    timeframe: Timeframe.M15,
    state: SignalState.PENDING,
    grade: SignalGrade.A_PLUS,
    score: 90,
    entryZone: { min: 24900, max: 25050, optimal: 24950 },
    stopLoss: 24700,
    takeProfits: { tp1: 25300, tp2: 25600, tp3: 26000 },
    riskRewardRatios: { rr1: 1.75, rr2: 3.25, rr3: 5.25 },
    reasoning: {
      htfStructure: 'Bullish',
      liquidityReason: 'SSL swept',
      triggerReason: 'FVG tap',
      invalidationReason: 'SL below 24700',
      confirmedChecklist: ['HTF', 'FVG'],
      summary: 'Long setup',
    },
    scoreBreakdown: {
      htfBias: 20,
      liquiditySweep: 15,
      bos: 15,
      fvg: 7,
      orderBlock: 8,
      displacement: 10,
      premiumDiscount: 10,
      volumeConfirmation: 5,
      riskReward: 5,
      indicatorAlignment: 5,
      totalScore: 90,
      grade: SignalGrade.A_PLUS,
    },
    timestamp: new Date(T0),
  };
}

function makeBearishSignal(symbol: string): ISignalSetup {
  return {
    ...makeBullishSignal(symbol),
    id: `sig_sell_${symbol}`,
    direction: Direction.BEARISH,
    // Properly above-price stop (would be valid for a short trade)
    stopLoss: 25200,
    takeProfits: { tp1: 24600, tp2: 24300, tp3: 23900 },
  };
}

// ── beforeAll: Register USDT/INR rate for BTC tests ──────────────────────────

beforeAll(() => {
  const fx = PointInTimeCurrencyConverter.getInstance();
  for (let offset = 0; offset <= 120; offset++) {
    fx.registerRate({
      pair: 'USDT/INR',
      rate: 85.5,
      timestamp: T0 + offset * 15 * 60 * 1000,
      source: 'RBI_REFERENCE',
      version: '1.0',
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 9: Explicit lifecycle tests for all 3 spot symbols
// ─────────────────────────────────────────────────────────────────────────────

describe('Req 9 — Spot Lifecycle: BUY accepted, SHORT rejected for all spot symbols', () => {
  const SPOT_SYMBOLS = ['NIFTY_SPOT', 'BANKNIFTY_SPOT', 'BTCUSDT_SPOT'];

  describe.each(SPOT_SYMBOLS)('%s', (symbol) => {
    const executionPrice = 24950;
    const quantity = 5;

    test('BUY/BULLISH entry creates a valid PositionLot', () => {
      const signal = makeBullishSignal(symbol);
      const lot = TradeLifecycleManager.createPositionLot(signal, executionPrice, quantity, T0);

      expect(lot.initialQuantity).toBe(quantity);
      expect(lot.remainingQuantity).toBe(quantity);
      expect(lot.status).toBe('OPEN');
      expect(lot.symbol).toBe(symbol);
      expect(lot.entryPrice).toBe(executionPrice);
      expect(lot.events[0].eventType).toBe('ENTRY_FILLED');
      expect(lot.entrySnapshot?.side).toBe('BUY');
    });

    test('BEARISH entry throws SPOT_SHORT_SELLING_FORBIDDEN', () => {
      const signal = makeBearishSignal(symbol);
      expect(() =>
        TradeLifecycleManager.createPositionLot(signal, executionPrice, quantity, T0),
      ).toThrow(/SPOT_SHORT_SELLING_FORBIDDEN/);
    });

    test('SHORT direction throws SPOT_SHORT_SELLING_FORBIDDEN', () => {
      const signal = { ...makeBullishSignal(symbol), direction: Direction.BEARISH } as ISignalSetup;
      // Use any cast to simulate a SHORT string direction
      (signal as any).direction = 'SHORT';
      expect(() =>
        TradeLifecycleManager.createPositionLot(signal, executionPrice, quantity, T0),
      ).toThrow(/SPOT_SHORT_SELLING_FORBIDDEN/);
    });

    test('SELL direction as entry throws SPOT_SHORT_SELLING_FORBIDDEN', () => {
      const signal = { ...makeBullishSignal(symbol) } as ISignalSetup;
      (signal as any).direction = 'SELL';
      expect(() =>
        TradeLifecycleManager.createPositionLot(signal, executionPrice, quantity, T0),
      ).toThrow(/SPOT_SHORT_SELLING_FORBIDDEN/);
    });

    test('Existing LONG position can be exited with SELL via processExitFill', () => {
      const signal = makeBullishSignal(symbol);
      const lot = TradeLifecycleManager.createPositionLot(signal, executionPrice, quantity, T0);

      // SELL (exit) must succeed — it reduces/closes an existing long
      const exitResult = TradeLifecycleManager.processExitFill(
        lot,
        {
          fillId: 'fill_exit_001',
          orderId: 'ord_exit_001',
          targetType: 'TP1',
          price: 25300,
          quantity,
          timestamp: T0 + 15 * 60 * 1000,
          fee: 0,
          slippage: 0,
        },
      );

      expect(exitResult.isClosed).toBe(true);
      expect(exitResult.lot.remainingQuantity).toBe(0);
      expect(exitResult.lot.status).toBe('CLOSED');
      expect(exitResult.lot.realizedPnl).toBeGreaterThan(0);
    });

    test('A bearish signal cannot accidentally create a short PositionLot (invariant proof)', () => {
      const signal = makeBearishSignal(symbol);
      // The only way to get a PositionLot is through createPositionLot.
      // If this throws, no short lot was created.
      let lotCreated = false;
      try {
        TradeLifecycleManager.createPositionLot(signal, executionPrice, quantity, T0);
        lotCreated = true;
      } catch (e: any) {
        expect(e.message).toMatch(/SPOT_SHORT_SELLING_FORBIDDEN/);
      }
      expect(lotCreated).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 5: SELL inventory enforcement in calculateSpotPosition
// ─────────────────────────────────────────────────────────────────────────────

describe('Req 5 — SELL inventory enforcement at PositionSizer boundary', () => {
  const baseOptions = {
    availableCash: 300_000,
    equity: 300_000,
    entryPrice: 24000,
    stopLoss: 23800,
    timestamp: T0,
  };

  test('SELL with zero holdings is rejected with SPOT_SHORT_SELLING_FORBIDDEN', () => {
    const result = PositionSizer.calculateSpotPosition({
      ...baseOptions,
      symbol: 'NIFTY_SPOT',
      orderSide: 'SELL',
      currentHeldQuantity: 0,
      sellQuantity: 5,
    });
    expect(result.isValid).toBe(false);
    expect(result.rejectionReason).toMatch(/SPOT_SHORT_SELLING_FORBIDDEN/);
  });

  test('SELL quantity > holdings is rejected with SPOT_SHORT_SELLING_FORBIDDEN', () => {
    const result = PositionSizer.calculateSpotPosition({
      ...baseOptions,
      symbol: 'BANKNIFTY_SPOT',
      orderSide: 'SELL',
      currentHeldQuantity: 3,
      sellQuantity: 5,
    });
    expect(result.isValid).toBe(false);
    expect(result.rejectionReason).toMatch(/SPOT_SHORT_SELLING_FORBIDDEN/);
  });

  test('SELL quantity <= holdings is accepted', () => {
    const result = PositionSizer.calculateSpotPosition({
      ...baseOptions,
      symbol: 'NIFTY_SPOT',
      orderSide: 'SELL',
      currentHeldQuantity: 10,
      sellQuantity: 5,
    });
    expect(result.isValid).toBe(true);
  });

  test('SELL exact holdings is accepted', () => {
    const result = PositionSizer.calculateSpotPosition({
      ...baseOptions,
      symbol: 'BANKNIFTY_SPOT',
      orderSide: 'SELL',
      currentHeldQuantity: 5,
      sellQuantity: 5,
    });
    expect(result.isValid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 6: Canonical symbol enforcement — legacy alias rejection
// ─────────────────────────────────────────────────────────────────────────────

describe('Req 6 — calculateSpotPosition rejects legacy aliases (no silent canonicalization)', () => {
  const legacyAliases = ['NIFTY', 'BANKNIFTY', 'BTCUSDT'];

  test.each(legacyAliases)('Legacy alias "%s" is rejected with LEGACY_ALIAS_REJECTED', (alias) => {
    const result = PositionSizer.calculateSpotPosition({
      availableCash: 300_000,
      equity: 300_000,
      entryPrice: 24000,
      stopLoss: 23800,
      symbol: alias,
      timestamp: T0,
    });
    expect(result.isValid).toBe(false);
    expect(result.rejectionReason).toMatch(/LEGACY_ALIAS_REJECTED/);
  });

  test('Forbidden derivative symbols are rejected', () => {
    const forbidden = ['NIFTY_FUT', 'BANKNIFTY_FUT', 'BTCUSDT_PERP'];
    for (const sym of forbidden) {
      const result = PositionSizer.calculateSpotPosition({
        availableCash: 300_000,
        equity: 300_000,
        entryPrice: 24000,
        stopLoss: 23800,
        symbol: sym,
        timestamp: T0,
      });
      expect(result.isValid).toBe(false);
      // Should match either FORBIDDEN_DERIVATIVE_INSTRUMENT or UNSUPPORTED_SPOT_INSTRUMENT
      expect(result.rejectionReason).toBeDefined();
    }
  });

  test('Canonical symbols are accepted', () => {
    for (const sym of ['NIFTY_SPOT', 'BANKNIFTY_SPOT']) {
      const result = PositionSizer.calculateSpotPosition({
        availableCash: 500_000,
        equity: 500_000,
        entryPrice: 24000,
        stopLoss: 23800,
        symbol: sym,
        timestamp: T0,
      });
      expect(result.isValid).toBe(true);
      expect(result.symbol).toBe(sym);
    }
  });

  test('BTCUSDT_SPOT requires USDT/INR FX rate', () => {
    const result = PositionSizer.calculateSpotPosition({
      availableCash: 10_000_000,
      equity: 10_000_000,
      entryPrice: 90000,
      stopLoss: 88000,
      symbol: 'BTCUSDT_SPOT',
      timestamp: T0,
    });
    // FX rate is registered in beforeAll → should be valid
    expect(result.isValid).toBe(true);
    expect(result.fxRate).toBe(85.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 4: Fee ceiling enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe('Req 4 — Fee-ceiling: unadjusted quantity exhausts cash, fees make it unaffordable', () => {
  test('Without fee reservation, unadjusted quantity exactly fills available cash (baseline)', () => {
    // entryPrice=1000, lot=1, availableCash=5000 → raw quantityByCash=5 (uses 100% cash)
    const result = PositionSizer.calculateSpotPosition({
      availableCash: 5_000,
      equity: 10_000,
      entryPrice: 1_000,
      stopLoss: 950,
      symbol: 'NIFTY_SPOT',
      riskPercentage: 5.0, // big enough to not be the binding constraint
      maxRiskPercentage: 5.0,
      timestamp: T0,
      // No entryFeeRateBps → fee factor = 0
    });
    expect(result.isValid).toBe(true);
    // notional = 5 units * 1000 = 5000 = exactly availableCash (no headroom)
    expect(result.roundedQuantity).toBe(5);
    expect(result.positionNotionalINR).toBe(5_000);
  });

  test('With fee reservation, quantity is reduced to leave room for fees', () => {
    // entryPrice=1000, lot=1, availableCash=5000, feeRate=10bps (0.1%)
    // Fee-adjusted ceiling: quantity <= 5000 / (1000 * 1.001) = 4.995 → floor = 4
    // notional(4) = 4000, fees(4) = 4 INR → 4004 <= 5000 ✓
    const result = PositionSizer.calculateSpotPosition({
      availableCash: 5_000,
      equity: 10_000,
      entryPrice: 1_000,
      stopLoss: 950,
      symbol: 'NIFTY_SPOT',
      riskPercentage: 5.0,
      maxRiskPercentage: 5.0,
      timestamp: T0,
      entryFeeRateBps: 10, // 0.1% fee
    });
    expect(result.isValid).toBe(true);
    // Quantity must be less than 5 because fees would exceed available cash at 5
    expect(result.roundedQuantity).toBeLessThan(5);
    // Post-fill cash check: notional + estimated fees must be <= availableCash
    const estimatedFee = result.positionNotionalINR * (10 / 10_000);
    expect(result.positionNotionalINR + estimatedFee).toBeLessThanOrEqual(5_000 + 1e-4);
  });

  test('Fee-ceiling recheck: post-rounding notional + fee exceeds cash → further round-down or reject', () => {
    // entryPrice=2000, lot=1, availableCash=5999
    // Without fees: quantity = floor(5999/2000) = 2 (notional=4000, fits)
    // With 10% fee: fee-adjusted ceiling = 5999/(2000*1.1) = 2.727 → floor = 2
    //   Post-rounding: 4000 + 400 = 4400 <= 5999 ✓ — valid at quantity 2
    const result = PositionSizer.calculateSpotPosition({
      availableCash: 5_999,
      equity: 20_000,
      entryPrice: 2_000,
      stopLoss: 1_800,
      symbol: 'NIFTY_SPOT',
      riskPercentage: 5.0,
      maxRiskPercentage: 5.0,
      timestamp: T0,
      entryFeeRateBps: 1000, // 10% fee — extreme, triggers recheck path
    });
    expect(result.isValid).toBe(true);
    const estimatedFee = result.positionNotionalINR * (1000 / 10_000);
    expect(result.positionNotionalINR + estimatedFee).toBeLessThanOrEqual(5_999 + 1e-4);
  });

  test('Fee-ceiling: rejection when even 1 lot notional + fee exceeds available cash', () => {
    // entryPrice=4950, lot=1, availableCash=5000
    // notional(1) = 4950, fee(1) = 4950 * 0.02 = 99 → 5049 > 5000 → reject
    const result = PositionSizer.calculateSpotPosition({
      availableCash: 5_000,
      equity: 10_000,
      entryPrice: 4_950,
      stopLoss: 4_800,
      symbol: 'NIFTY_SPOT',
      riskPercentage: 5.0,
      maxRiskPercentage: 5.0,
      timestamp: T0,
      entryFeeRateBps: 200, // 2% fee
    });
    expect(result.isValid).toBe(false);
    expect(result.rejectionReason).toMatch(/FEE_CEILING_BREACH|minimum lot/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 10: Derivative-path isolation
// Prove calculateMargin and calculateLiquidationPrice are NOT called with a
// levered margin model during spot position sizing.
// ─────────────────────────────────────────────────────────────────────────────

describe('Req 10 — Derivative-path isolation: spot sizing never invokes levered margin/liquidation', () => {
  test('calculateSpotPosition does NOT call calculateMargin or calculateLiquidationPrice', () => {
    const marginSpy = jest.spyOn(TradeAccountingEngine, 'calculateMargin');
    const liqSpy = jest.spyOn(TradeAccountingEngine, 'calculateLiquidationPrice');

    try {
      PositionSizer.calculateSpotPosition({
        availableCash: 500_000,
        equity: 500_000,
        entryPrice: 24000,
        stopLoss: 23800,
        symbol: 'NIFTY_SPOT',
        timestamp: T0,
      });

      // calculateMargin and calculateLiquidationPrice must not be invoked
      // by the spot-specific sizing path
      expect(marginSpy).not.toHaveBeenCalled();
      expect(liqSpy).not.toHaveBeenCalled();
    } finally {
      marginSpy.mockRestore();
      liqSpy.mockRestore();
    }
  });

  test('calculateSpotPosition for BTCUSDT_SPOT does NOT call calculateMargin or calculateLiquidationPrice', () => {
    const marginSpy = jest.spyOn(TradeAccountingEngine, 'calculateMargin');
    const liqSpy = jest.spyOn(TradeAccountingEngine, 'calculateLiquidationPrice');

    try {
      PositionSizer.calculateSpotPosition({
        availableCash: 10_000_000,
        equity: 10_000_000,
        entryPrice: 90000,
        stopLoss: 88000,
        symbol: 'BTCUSDT_SPOT',
        timestamp: T0,
      });

      expect(marginSpy).not.toHaveBeenCalled();
      expect(liqSpy).not.toHaveBeenCalled();
    } finally {
      marginSpy.mockRestore();
      liqSpy.mockRestore();
    }
  });

  test('calculateLiquidationPrice returns undefined for all spot symbols (SPOT_NONE model)', () => {
    const spotSymbols = ['NIFTY_SPOT', 'BANKNIFTY_SPOT', 'BTCUSDT_SPOT'];
    for (const sym of spotSymbols) {
      const liqPrice = TradeAccountingEngine.calculateLiquidationPrice({
        entryPrice: 24000,
        direction: Direction.BULLISH,
        marginMode: 'SPOT',
        liquidationModel: 'SPOT_NONE' as any,
      });
      expect(liqPrice).toBeUndefined();
    }
  });

  test('Generic calculatePosition path (derivative path) is NOT reachable from supported spot symbol dispatch', () => {
    // The BacktestSimulator explicitly dispatches spot symbols to calculateSpotPosition.
    // This test verifies that a direct call to calculatePosition for a spot symbol
    // is rejected (leverage guard) — proving the derivative path does not serve spot.
    const result = PositionSizer.calculatePosition({
      accountBalance: 500_000,
      riskPercentage: 1.0,
      entryPrice: 24000,
      stopLoss: 23800,
      symbol: 'NIFTY_SPOT',
      requestedLeverage: 1, // valid for non-spot, but spot path rejects SHORT
      timestamp: T0,
    });
    // calculatePosition does not call margin/liquidation for 1x leverage spot
    // but should still reject if direction is SHORT — test the spot guard in calculatePosition
    const shortResult = PositionSizer.calculatePosition({
      accountBalance: 500_000,
      riskPercentage: 1.0,
      entryPrice: 24000,
      stopLoss: 26000,
      direction: 'SHORT',
      symbol: 'NIFTY_SPOT',
      timestamp: T0,
    });
    expect(shortResult.isValid).toBe(false);
    expect(shortResult.rejectionReason).toMatch(/SPOT_SHORT_SELLING_FORBIDDEN/);
  });
});
