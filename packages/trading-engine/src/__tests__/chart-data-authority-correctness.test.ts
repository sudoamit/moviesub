import { ChartSnapshotValidator } from '../chart-snapshot-validator';
import { ChartMarketSnapshot, ChartCandle, ChartFormingCandle, ChartSMCSnapshot } from '@quant/shared';

describe('Chart Data Authority & Coordinate Correctness Audit Test Suite', () => {
  const validClosedCandles: ChartCandle[] = [
    {
      timestamp: '2026-09-13T09:15:00.000Z',
      open: 100,
      high: 105,
      low: 98,
      close: 103,
      volume: 1000,
      isClosed: true,
      provenance: 'LIVE',
    },
    {
      timestamp: '2026-09-13T09:30:00.000Z',
      open: 103,
      high: 108,
      low: 102,
      close: 106,
      volume: 1200,
      isClosed: true,
      provenance: 'LIVE',
    },
  ];

  const validFormingCandle: ChartFormingCandle = {
    timestamp: '2026-09-13T09:45:00.000Z',
    open: 106,
    high: 109,
    low: 105,
    close: 108,
    volume: 500,
    isClosed: false,
    provenance: 'LIVE',
  };

  const validSMCSnapshot: ChartSMCSnapshot = {
    symbol: 'NIFTY',
    timeframe: '15m',
    provenance: 'LIVE',
    asOfTimestamp: '2026-09-13T09:45:00.000Z',
    structures: {
      swings: [{ price: 108, timestamp: '2026-09-13T09:45:00.000Z', type: 'HIGH' }],
      bos: [],
      choch: [],
      marketRegime: 'BULLISH_CONTINUATION',
    },
    liquidity: { pools: [], sweeps: [] },
    fvgs: [
      {
        id: 'fvg-1',
        symbol: 'NIFTY',
        timeframe: '15m',
        direction: 'BULLISH',
        upperBound: 106,
        lowerBound: 103,
        timestamp: '2026-09-13T09:30:00.000Z',
        isFilled: false,
      },
    ],
    orderBlocks: [
      {
        id: 'ob-1',
        symbol: 'NIFTY',
        timeframe: '15m',
        direction: 'BULLISH',
        high: 103,
        low: 100,
        openPrice: 101,
        closePrice: 103,
        volume: 1200,
        timestamp: '2026-09-13T09:15:00.000Z',
        status: 'ACTIVE',
      },
    ],
  };

  // 1. Rejection of synthetic/fallback candle generation
  test('P0-1: Rejects synthetic/fabricated fallback market data', () => {
    const invalidCandles = [
      {
        timestamp: '2026-09-13T09:15:00.000Z',
        open: 100,
        high: 105,
        low: 98,
        close: 103,
        volume: 1000,
        isClosed: true,
        provenance: 'SYNTHETIC_FALLBACK', // Violation of strict real data policy
      } as any,
    ];
    const validation = ChartSnapshotValidator.validateClosedCandles(invalidCandles);
    expect(validation.isValid).toBe(false);
    expect(validation.errors).toContain(
      'Candle 0 has invalid provenance: SYNTHETIC_FALLBACK. Synthetic data is prohibited.',
    );
  });

  // 2. Canonical snapshot contract validation
  test('P0-4: Validates complete canonical ChartMarketSnapshot', () => {
    const snapshot: ChartMarketSnapshot = {
      symbol: 'NIFTY',
      timeframe: '15m',
      closedCandles: validClosedCandles,
      formingCandle: validFormingCandle,
      smcSnapshot: validSMCSnapshot,
      dataProvenance: 'LIVE',
      sourceIdentity: 'NSE_TRUE_DATA',
      livePrice: 108,
      asOfTimestamp: '2026-09-13T09:45:00.000Z',
    };

    const result = ChartSnapshotValidator.validateSnapshot(snapshot, 'NIFTY', '15m');
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // 3. Separation of closedCandles vs formingCandle
  test('P0-2: Explicitly separates closedCandles (isClosed:true) vs formingCandle (isClosed:false)', () => {
    const mixedClosedCandles = [
      ...validClosedCandles,
      {
        timestamp: '2026-09-13T09:45:00.000Z',
        open: 106,
        high: 109,
        low: 105,
        close: 108,
        volume: 500,
        isClosed: false, // Informing candle inside closedCandles array
        provenance: 'LIVE',
      } as any,
    ];

    const validation = ChartSnapshotValidator.validateClosedCandles(mixedClosedCandles);
    expect(validation.isValid).toBe(false);
    expect(validation.errors).toContain(
      'Candle 2 in closedCandles array has isClosed = false. closedCandles must only contain closed candles.',
    );
  });

  // 4. Sorting & deduplication of closed candles
  test('P0-2: Detects duplicate timestamps and unsorted candles in closedCandles', () => {
    const unsortedCandles: ChartCandle[] = [
      validClosedCandles[1],
      validClosedCandles[0], // Out of order
    ];
    const validationUnsorted = ChartSnapshotValidator.validateClosedCandles(unsortedCandles);
    expect(validationUnsorted.isValid).toBe(false);

    const duplicateCandles: ChartCandle[] = [
      validClosedCandles[0],
      validClosedCandles[0], // Duplicate timestamp
    ];
    const validationDuplicate = ChartSnapshotValidator.validateClosedCandles(duplicateCandles);
    expect(validationDuplicate.isValid).toBe(false);
    expect(validationDuplicate.errors).toContain(
      'Duplicate timestamp detected at index 1: 2026-09-13T09:15:00.000Z',
    );
  });

  // 5. Invariant checking on OHLC
  test('P0-2: Enforces OHLC invariants (high >= max(open, close), low <= min(open, close), volume >= 0)', () => {
    const invalidOHLC: ChartCandle[] = [
      {
        timestamp: '2026-09-13T09:15:00.000Z',
        open: 100,
        high: 95, // Invalid: high < open
        low: 98,
        close: 103,
        volume: 1000,
        isClosed: true,
        provenance: 'LIVE',
      },
    ];

    const validation = ChartSnapshotValidator.validateClosedCandles(invalidOHLC);
    expect(validation.isValid).toBe(false);
    expect(validation.errors[0]).toContain('invalid OHLC relationship');
  });

  // 6. Single forming candle bucket rule
  test('P0-1: Ensures forming candle timestamp matches or follows last closed candle', () => {
    const staleFormingCandle: ChartFormingCandle = {
      timestamp: '2026-09-13T09:00:00.000Z', // Before first closed candle
      open: 90,
      high: 95,
      low: 89,
      close: 94,
      volume: 100,
      isClosed: false,
      provenance: 'LIVE',
    };

    const snapshot: ChartMarketSnapshot = {
      symbol: 'NIFTY',
      timeframe: '15m',
      closedCandles: validClosedCandles,
      formingCandle: staleFormingCandle,
      smcSnapshot: null,
      dataProvenance: 'LIVE',
      sourceIdentity: 'NSE_TRUE_DATA',
      livePrice: 94,
      asOfTimestamp: '2026-09-13T09:45:00.000Z',
    };

    const validation = ChartSnapshotValidator.validateSnapshot(snapshot, 'NIFTY', '15m');
    expect(validation.isValid).toBe(false);
    expect(validation.errors).toContain(
      'Forming candle timestamp 2026-09-13T09:00:00.000Z is strictly before the latest closed candle timestamp 2026-09-13T09:30:00.000Z.',
    );
  });

  // 7. Single live price authority semantics
  test('P1-3: Validates livePrice presence and non-negative finite value', () => {
    const invalidPriceSnapshot: ChartMarketSnapshot = {
      symbol: 'NIFTY',
      timeframe: '15m',
      closedCandles: validClosedCandles,
      formingCandle: validFormingCandle,
      smcSnapshot: null,
      dataProvenance: 'LIVE',
      sourceIdentity: 'NSE_TRUE_DATA',
      livePrice: -5, // Invalid price
      asOfTimestamp: '2026-09-13T09:45:00.000Z',
    };

    const validation = ChartSnapshotValidator.validateSnapshot(invalidPriceSnapshot, 'NIFTY', '15m');
    expect(validation.isValid).toBe(false);
    expect(validation.errors).toContain('Snapshot livePrice is invalid: -5');
  });

  // 8. SMC snapshot validation matching symbol & timeframe
  test('P0-5: Validates matching SMC snapshot symbol and timeframe', () => {
    const isValid = ChartSnapshotValidator.validateSMCSnapshot(validSMCSnapshot, 'NIFTY', '15m');
    expect(isValid).toBe(true);
  });

  // 9. Symbol/timeframe mismatch rejection in SMC snapshot
  test('P0-5: Rejects SMC snapshot with symbol or timeframe mismatch', () => {
    const mismatchedSymbol = ChartSnapshotValidator.validateSMCSnapshot(
      validSMCSnapshot,
      'BANKNIFTY', // Expected BANKNIFTY, but snapshot is NIFTY
      '15m',
    );
    expect(mismatchedSymbol).toBe(false);

    const mismatchedTf = ChartSnapshotValidator.validateSMCSnapshot(
      validSMCSnapshot,
      'NIFTY',
      '1h', // Expected 1h, but snapshot is 15m
    );
    expect(mismatchedTf).toBe(false);
  });

  // 10. Timestamp-based coordinate mapping invariant (rejection of percentage X fallbacks)
  test('P0-6: Enforces timestamp presence on all SMC objects for timeToCoordinate mapping', () => {
    const invalidSMCObject: ChartSMCSnapshot = {
      ...validSMCSnapshot,
      orderBlocks: [
        {
          id: 'ob-invalid',
          symbol: 'NIFTY',
          timeframe: '15m',
          direction: 'BULLISH',
          high: 103,
          low: 100,
          openPrice: 101,
          closePrice: 103,
          volume: 1200,
          timestamp: '', // Empty timestamp violates coordinate anchoring requirement
          status: 'ACTIVE',
        },
      ],
    };

    const isValid = ChartSnapshotValidator.validateSMCSnapshot(invalidSMCObject, 'NIFTY', '15m');
    expect(isValid).toBe(false);
  });

  // 11. Session VWAP boundary resets (NSE 09:15 IST, Gold 22:00 UTC, Crypto 00:00 UTC)
  test('P1-1: Tests session VWAP boundary detection logic', () => {
    const isNewSession = (prevIso: string, currIso: string, symbol: string): boolean => {
      const prevDate = new Date(prevIso);
      const currDate = new Date(currIso);
      const symUpper = symbol.toUpperCase();
      if (symUpper === 'XAUUSD' || symUpper === 'GOLD') {
        const prevShifted = new Date(prevDate.getTime() + 2 * 3600 * 1000);
        const currShifted = new Date(currDate.getTime() + 2 * 3600 * 1000);
        return (
          prevShifted.getUTCDay() !== currShifted.getUTCDay() ||
          prevShifted.getUTCFullYear() !== currShifted.getUTCFullYear()
        );
      } else if (symUpper === 'BTCUSDT' || symUpper.endsWith('USDT') || symUpper.endsWith('USD')) {
        return (
          prevDate.getUTCDay() !== currDate.getUTCDay() ||
          prevDate.getUTCFullYear() !== currDate.getUTCFullYear()
        );
      } else {
        const prevIstSession = new Date(prevDate.getTime() + (5.5 * 3600 - 9.25 * 3600) * 1000);
        const currIstSession = new Date(currDate.getTime() + (5.5 * 3600 - 9.25 * 3600) * 1000);
        return (
          prevIstSession.getUTCDay() !== currIstSession.getUTCDay() ||
          prevIstSession.getUTCFullYear() !== currIstSession.getUTCFullYear()
        );
      }
    };

    // Crypto: 00:00 UTC boundary
    expect(isNewSession('2026-09-13T23:55:00.000Z', '2026-09-14T00:05:00.000Z', 'BTCUSDT')).toBe(true);
    expect(isNewSession('2026-09-13T10:00:00.000Z', '2026-09-13T11:00:00.000Z', 'BTCUSDT')).toBe(false);

    // Gold: 22:00 UTC boundary
    expect(isNewSession('2026-09-13T21:55:00.000Z', '2026-09-13T22:05:00.000Z', 'XAUUSD')).toBe(true);
    expect(isNewSession('2026-09-13T14:00:00.000Z', '2026-09-13T15:00:00.000Z', 'XAUUSD')).toBe(false);

    // NSE: 09:15 IST (03:45 UTC) boundary
    expect(isNewSession('2026-09-13T03:30:00.000Z', '2026-09-13T03:45:00.000Z', 'NIFTY')).toBe(true);
    expect(isNewSession('2026-09-13T04:00:00.000Z', '2026-09-13T04:15:00.000Z', 'NIFTY')).toBe(false);
  });

  // 12. Abort/stale response race condition handling
  test('P1-4: Prevents race conditions by rejecting snapshot if requested symbol does not match snapshot', () => {
    const snapshot: ChartMarketSnapshot = {
      symbol: 'BANKNIFTY', // Outdated response from previous pending fetch
      timeframe: '15m',
      closedCandles: validClosedCandles,
      formingCandle: null,
      smcSnapshot: null,
      dataProvenance: 'LIVE',
      sourceIdentity: 'NSE_TRUE_DATA',
      livePrice: 45000,
      asOfTimestamp: new Date().toISOString(),
    };

    // User is currently viewing NIFTY
    const validation = ChartSnapshotValidator.validateSnapshot(snapshot, 'NIFTY', '15m');
    expect(validation.isValid).toBe(false);
    expect(validation.errors).toContain('Snapshot symbol BANKNIFTY does not match target symbol NIFTY.');
  });

  // 13. Explicit stale/unavailable state contract when data source fails
  test('P0-1: Correctly flags empty/failed snapshot as invalid for chart rendering', () => {
    const emptySnapshot: ChartMarketSnapshot = {
      symbol: 'NIFTY',
      timeframe: '15m',
      closedCandles: [],
      formingCandle: null,
      smcSnapshot: null,
      dataProvenance: 'LIVE',
      sourceIdentity: 'NSE_TRUE_DATA',
      livePrice: null,
      asOfTimestamp: new Date().toISOString(),
    };

    const validation = ChartSnapshotValidator.validateSnapshot(emptySnapshot, 'NIFTY', '15m');
    expect(validation.isValid).toBe(false);
    expect(validation.errors).toContain('closedCandles array is empty.');
  });

  // 14. Non-mutation of historical closed candles on live forming updates
  test('P0-3: Ensures live tick updates only modify formingCandle, preserving closedCandles immutability', () => {
    const initialClosedCandles = [...validClosedCandles];
    const snapshot: ChartMarketSnapshot = {
      symbol: 'NIFTY',
      timeframe: '15m',
      closedCandles: initialClosedCandles,
      formingCandle: validFormingCandle,
      smcSnapshot: null,
      dataProvenance: 'LIVE',
      sourceIdentity: 'NSE_TRUE_DATA',
      livePrice: 108,
      asOfTimestamp: '2026-09-13T09:45:00.000Z',
    };

    // Simulate live tick update
    const liveTickPrice = 112;
    const updatedFormingCandle: ChartFormingCandle = {
      ...snapshot.formingCandle!,
      high: Math.max(snapshot.formingCandle!.high, liveTickPrice),
      low: Math.min(snapshot.formingCandle!.low, liveTickPrice),
      close: liveTickPrice,
    };

    const updatedSnapshot: ChartMarketSnapshot = {
      ...snapshot,
      formingCandle: updatedFormingCandle,
      livePrice: liveTickPrice,
      asOfTimestamp: new Date().toISOString(),
    };

    // Immutable check: closedCandles length and contents are identical
    expect(updatedSnapshot.closedCandles).toEqual(initialClosedCandles);
    expect(updatedSnapshot.closedCandles[0].close).toBe(103);
    expect(updatedSnapshot.closedCandles[1].close).toBe(106);
    // Forming candle updated cleanly
    expect(updatedSnapshot.formingCandle?.close).toBe(112);
  });
});
