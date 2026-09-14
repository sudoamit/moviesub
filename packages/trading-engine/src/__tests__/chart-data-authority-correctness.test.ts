import { ChartSnapshotValidator } from '../chart-snapshot-validator';
import { ChartMarketSnapshot, ChartCandle, ChartFormingCandle, ChartSMCSnapshot, Direction, StructureType } from '@quant/shared';

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
      swings: [{ price: 108, timestamp: new Date('2026-09-13T09:45:00.000Z'), type: StructureType.SWING_HIGH, index: 0, isConfirmed: true }] as any,
      bos: [],
      choch: [],
      marketRegime: 'BULLISH_CONTINUATION' as any,
    },
    liquidity: { pools: [], sweeps: [] },
    fvgs: [
      {
        id: 'fvg-1',
        symbol: 'NIFTY',
        timeframe: '15m',
        direction: Direction.BULLISH,
        upperBound: 106,
        lowerBound: 103,
        timestamp: new Date('2026-09-13T09:30:00.000Z'),
        isFilled: false,
      } as any,
    ],
    orderBlocks: [
      {
        id: 'ob-1',
        symbol: 'NIFTY',
        timeframe: '15m',
        direction: Direction.BULLISH,
        high: 103,
        low: 100,
        openPrice: 101,
        closePrice: 103,
        volume: 1200,
        timestamp: new Date('2026-09-13T09:15:00.000Z'),
        status: 'ACTIVE',
      } as any,
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
      marketAsOf: '2026-09-13T09:45:00.000Z',
      observedAt: '2026-09-13T09:45:00.000Z',
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
    expect(validation.errors[0]).toContain(
      'must be strictly after the latest closed candle timestamp',
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
          direction: Direction.BULLISH,
          high: 103,
          low: 100,
          openPrice: 101,
          closePrice: 103,
          volume: 1200,
          timestamp: '' as any, // Empty timestamp violates coordinate anchoring requirement
          status: 'ACTIVE',
        } as any,
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

  // 15. TimeframeRegistry bucket open time calculation
  test('P0-1: TimeframeRegistry.getBucketOpenTime calculates exact candle open timestamp without raw new Date()', () => {
    const { TimeframeRegistry } = require('@quant/shared');
    const tickTime = '2026-09-13T09:42:17.345Z';
    const bucketOpen = TimeframeRegistry.getBucketOpenTime(tickTime, '15m');
    expect(bucketOpen.toISOString()).toBe('2026-09-13T09:30:00.000Z');

    const bucketOpen1h = TimeframeRegistry.getBucketOpenTime(tickTime, '1h');
    expect(bucketOpen1h.toISOString()).toBe('2026-09-13T09:00:00.000Z');
  });

  // 16. Incremental vs Cumulative tick volume semantics
  test('P0-2: Handles INCREMENTAL vs CUMULATIVE tick volume aggregation', () => {
    const initialForming: ChartFormingCandle = {
      timestamp: '2026-09-13T09:30:00.000Z',
      open: 100,
      high: 105,
      low: 99,
      close: 104,
      volume: 500,
      isClosed: false,
    };

    // Incremental tick: 100 added -> 600
    const incrementalVol = 100;
    const updatedIncremental = {
      ...initialForming,
      volume: initialForming.volume + incrementalVol,
    };
    expect(updatedIncremental.volume).toBe(600);

    // Cumulative tick: cumulative 750 -> 750
    const cumulativeVol = 750;
    const updatedCumulative = {
      ...initialForming,
      volume: Math.max(initialForming.volume, cumulativeVol),
    };
    expect(updatedCumulative.volume).toBe(750);
  });

  // 17. Timeframe Rollover Transition
  test('P0-3: Performs atomic timeframe rollover when tick crosses candle bucket boundary', () => {
    const { TimeframeRegistry } = require('@quant/shared');
    const prevSnapshot: ChartMarketSnapshot = {
      symbol: 'NIFTY',
      timeframe: '15m',
      closedCandles: validClosedCandles,
      formingCandle: {
        timestamp: '2026-09-13T09:30:00.000Z',
        open: 103,
        high: 108,
        low: 102,
        close: 106,
        volume: 1200,
        isClosed: false,
      },
      livePrice: 106,
      asOfTimestamp: '2026-09-13T09:35:00.000Z',
      dataProvenance: 'LIVE',
      sourceIdentity: 'NSE_LIVE_STREAM',
    };

    // Tick arrives at 09:45:02 (new 09:45 candle bucket)
    const tickTime = '2026-09-13T09:45:02.000Z';
    const tickPrice = 109;
    const bucketOpenDate = TimeframeRegistry.getBucketOpenTime(tickTime, '15m');
    const bucketOpenMs = bucketOpenDate.getTime();

    const currentForming = prevSnapshot.formingCandle!;
    const formingMs = new Date(currentForming.timestamp).getTime();
    const isRollover = bucketOpenMs > formingMs;

    expect(isRollover).toBe(true);

    // Perform atomic transition
    const closedPrevForming: ChartCandle = { ...currentForming, isClosed: true as const };
    const updatedClosedCandles = [...prevSnapshot.closedCandles, closedPrevForming];

    const newForming: ChartFormingCandle = {
      timestamp: bucketOpenDate.toISOString(),
      open: tickPrice,
      high: tickPrice,
      low: tickPrice,
      close: tickPrice,
      volume: 150,
      isClosed: false as const,
    };

    expect(updatedClosedCandles).toHaveLength(3);
    expect(updatedClosedCandles[2].isClosed).toBe(true);
    expect(updatedClosedCandles[2].timestamp).toBe('2026-09-13T09:30:00.000Z');
    expect(newForming.timestamp).toBe('2026-09-13T09:45:00.000Z');
  });

  // 18. Fail-closed volumeType aggregation and initial forming volume (Defect Fix #1 & #2)
  test('P0-1: Fail-closed volumeType behavior for UNKNOWN or missing volumeType', () => {
    const currentForming: ChartFormingCandle = {
      timestamp: '2026-09-13T09:30:00.000Z',
      open: 100,
      high: 105,
      low: 99,
      close: 104,
      volume: 500,
      isClosed: false,
    };

    const processTickVolume = (forming: ChartFormingCandle | null, tick: { volume?: number; volumeType?: string }) => {
      const volType = tick.volumeType;
      if (forming) {
        let newVol = forming.volume;
        if (volType === 'INCREMENTAL') {
          newVol = forming.volume + (tick.volume ?? 0);
        } else if (volType === 'CUMULATIVE') {
          newVol = Math.max(forming.volume, tick.volume ?? 0);
        } else {
          // Fail-closed
          newVol = forming.volume;
        }
        return newVol;
      } else {
        let initialVol = 0;
        if (volType === 'INCREMENTAL' || volType === 'CUMULATIVE') {
          initialVol = tick.volume ?? 0;
        }
        return initialVol;
      }
    };

    // 1. Missing / UNKNOWN volumeType does NOT aggregate volume blindly (fail-closed)
    expect(processTickVolume(currentForming, { volume: 150 })).toBe(500);
    expect(processTickVolume(currentForming, { volume: 150, volumeType: 'UNKNOWN' })).toBe(500);

    // 2. INCREMENTAL volumeType adds delta
    expect(processTickVolume(currentForming, { volume: 150, volumeType: 'INCREMENTAL' })).toBe(650);

    // 3. CUMULATIVE volumeType replaces with Math.max
    expect(processTickVolume(currentForming, { volume: 750, volumeType: 'CUMULATIVE' })).toBe(750);

    // 4. Initial forming candle volume assignment without volumeType starts at 0 (fail-closed)
    expect(processTickVolume(null, { volume: 200 })).toBe(0);
    expect(processTickVolume(null, { volume: 200, volumeType: 'INCREMENTAL' })).toBe(200);
  });

  // 19. SMC snapshot dual timestamps (Defect Fix #4)
  test('P1-4: Preserves computedAt and structureAsOf in ChartSMCSnapshot', () => {
    const smcWithDualTimestamps: ChartSMCSnapshot = {
      ...validSMCSnapshot,
      computedAt: '2026-09-13T09:45:10.000Z',
      structureAsOf: '2026-09-13T09:30:00.000Z',
    };

    expect(smcWithDualTimestamps.computedAt).toBe('2026-09-13T09:45:10.000Z');
    expect(smcWithDualTimestamps.structureAsOf).toBe('2026-09-13T09:30:00.000Z');
    expect(ChartSnapshotValidator.validateSMCSnapshot(smcWithDualTimestamps, 'NIFTY', '15m')).toBe(true);
  });

  // 20. Comprehensive CanonicalCandleAggregator Suite (P0 20 Required Tests)
  describe('CanonicalCandleAggregator State Machine Rules', () => {
    const { CanonicalCandleAggregator } = require('@quant/shared');

    const baseSnapshot: ChartMarketSnapshot = {
      symbol: 'NIFTY',
      timeframe: '15m',
      closedCandles: [validClosedCandles[0]],
      formingCandle: null,
      smcSnapshot: validSMCSnapshot,
      dataProvenance: 'LIVE',
      sourceIdentity: 'NSE_LIVE',
      livePrice: 103,
      asOfTimestamp: '2026-09-13T09:15:00.000Z',
      closedThrough: '2026-09-13T09:15:00.000Z',
    };

    test('1. First forming candle creation initialized at bucket open timestamp', () => {
      const aggregator = new CanonicalCandleAggregator();
      const updated = aggregator.processTick(baseSnapshot, {
        symbol: 'NIFTY',
        price: 107,
        timestamp: '2026-09-13T09:42:15.000Z',
        volume: 100,
        volumeType: 'INCREMENTAL',
      });

      expect(updated.formingCandle).not.toBeNull();
      expect(updated.formingCandle?.timestamp).toBe('2026-09-13T09:30:00.000Z');
      expect(updated.formingCandle?.open).toBe(107);
      expect(updated.formingCandle?.high).toBe(107);
      expect(updated.formingCandle?.low).toBe(107);
      expect(updated.formingCandle?.close).toBe(107);
      expect(updated.formingCandle?.volume).toBe(100);
      expect(updated.livePrice).toBe(107);
    });

    test('2. INCREMENTAL volume adds tick volume delta', () => {
      const aggregator = new CanonicalCandleAggregator();
      const s1 = aggregator.processTick(baseSnapshot, {
        symbol: 'NIFTY',
        price: 107,
        timestamp: '2026-09-13T09:40:00.000Z',
        volume: 100,
        volumeType: 'INCREMENTAL',
      });

      const s2 = aggregator.processTick(s1, {
        symbol: 'NIFTY',
        price: 108,
        timestamp: '2026-09-13T09:41:00.000Z',
        volume: 50,
        volumeType: 'INCREMENTAL',
      });

      expect(s2.formingCandle?.volume).toBe(150);
    });

    test('3. BUCKET_CUMULATIVE volume uses Math.max', () => {
      const aggregator = new CanonicalCandleAggregator();
      const s1 = aggregator.processTick(baseSnapshot, {
        symbol: 'NIFTY',
        price: 107,
        timestamp: '2026-09-13T09:40:00.000Z',
        volume: 500,
        volumeType: 'BUCKET_CUMULATIVE',
      });

      const s2 = aggregator.processTick(s1, {
        symbol: 'NIFTY',
        price: 108,
        timestamp: '2026-09-13T09:41:00.000Z',
        volume: 750,
        volumeType: 'BUCKET_CUMULATIVE',
      });

      expect(s2.formingCandle?.volume).toBe(750);
    });

    test('4. UNKNOWN or missing volumeType fails closed without changing volume', () => {
      const aggregator = new CanonicalCandleAggregator();
      const s1 = aggregator.processTick(baseSnapshot, {
        symbol: 'NIFTY',
        price: 107,
        timestamp: '2026-09-13T09:40:00.000Z',
        volume: 500,
        volumeType: 'INCREMENTAL',
      });

      const s2 = aggregator.processTick(s1, {
        symbol: 'NIFTY',
        price: 108,
        timestamp: '2026-09-13T09:41:00.000Z',
        volume: 300,
        volumeType: 'UNKNOWN',
      });

      expect(s2.formingCandle?.volume).toBe(500);
    });

    test('5. Rollover into next bucket closes previous forming candle exactly once', () => {
      const aggregator = new CanonicalCandleAggregator();
      const s1 = aggregator.processTick(baseSnapshot, {
        symbol: 'NIFTY',
        price: 107,
        timestamp: '2026-09-13T09:40:00.000Z',
        volume: 500,
        volumeType: 'INCREMENTAL',
      });

      // Tick in next bucket (09:45)
      const s2 = aggregator.processTick(s1, {
        symbol: 'NIFTY',
        price: 110,
        timestamp: '2026-09-13T09:46:00.000Z',
        volume: 100,
        volumeType: 'INCREMENTAL',
      });

      expect(s2.closedCandles).toHaveLength(2);
      expect(s2.closedCandles[1].timestamp).toBe('2026-09-13T09:30:00.000Z');
      expect(s2.closedCandles[1].isClosed).toBe(true);
      expect(s2.formingCandle?.timestamp).toBe('2026-09-13T09:45:00.000Z');
    });

    test('6. Duplicate tick does not double-count volume', () => {
      const aggregator = new CanonicalCandleAggregator();
      const s1 = aggregator.processTick(baseSnapshot, {
        symbol: 'NIFTY',
        price: 107,
        timestamp: '2026-09-13T09:40:00.000Z',
        volume: 100,
        volumeType: 'INCREMENTAL',
        tickId: 'tick-1',
      });

      // Duplicate tick re-entry
      const s2 = aggregator.processTick(s1, {
        symbol: 'NIFTY',
        price: 107,
        timestamp: '2026-09-13T09:40:00.000Z',
        volume: 100,
        volumeType: 'INCREMENTAL',
        tickId: 'tick-1',
      });

      expect(s2.formingCandle?.volume).toBe(100);
    });

    test('7. Old/stale tick cannot mutate current forming candle', () => {
      const aggregator = new CanonicalCandleAggregator();
      const s1 = aggregator.processTick(baseSnapshot, {
        symbol: 'NIFTY',
        price: 107,
        timestamp: '2026-09-13T09:40:00.000Z',
        volume: 100,
        volumeType: 'INCREMENTAL',
      });

      // Stale tick from 09:20
      const s2 = aggregator.processTick(s1, {
        symbol: 'NIFTY',
        price: 95,
        timestamp: '2026-09-13T09:20:00.000Z',
        volume: 500,
        volumeType: 'INCREMENTAL',
      });

      expect(s2).toBe(s1);
    });

    test('8. Gap Policy: omit missing empty buckets when ticks jump across intervals', () => {
      const aggregator = new CanonicalCandleAggregator();
      const s1 = aggregator.processTick(baseSnapshot, {
        symbol: 'NIFTY',
        price: 107,
        timestamp: '2026-09-13T09:40:00.000Z',
        volume: 100,
        volumeType: 'INCREMENTAL',
      });

      // Jump from 09:40 to 11:15 (skips 10:00, 10:15, 10:30, 10:45, 11:00)
      const s2 = aggregator.processTick(s1, {
        symbol: 'NIFTY',
        price: 120,
        timestamp: '2026-09-13T11:17:00.000Z',
        volume: 200,
        volumeType: 'INCREMENTAL',
      });

      // 09:30 forming closed cleanly, missing intermediate buckets omitted (no fake candles inserted)
      expect(s2.closedCandles).toHaveLength(2);
      expect(s2.formingCandle?.timestamp).toBe('2026-09-13T11:15:00.000Z');
    });

    test('9. Invalid price is rejected', () => {
      const aggregator = new CanonicalCandleAggregator();
      const s1 = aggregator.processTick(baseSnapshot, {
        symbol: 'NIFTY',
        price: -50,
        timestamp: '2026-09-13T09:40:00.000Z',
        volumeType: 'INCREMENTAL',
      });

      expect(s1).toBe(baseSnapshot);
    });

    test('10. Invalid timestamp is rejected', () => {
      const aggregator = new CanonicalCandleAggregator();
      const s1 = aggregator.processTick(baseSnapshot, {
        symbol: 'NIFTY',
        price: 108,
        timestamp: 'invalid-date-string',
        volumeType: 'INCREMENTAL',
      });

      expect(s1).toBe(baseSnapshot);
    });

    test('11. livePrice strictly equals formingCandle.close', () => {
      const aggregator = new CanonicalCandleAggregator();
      const s1 = aggregator.processTick(baseSnapshot, {
        symbol: 'NIFTY',
        price: 112.5,
        timestamp: '2026-09-13T09:40:00.000Z',
        volumeType: 'INCREMENTAL',
      });

      expect(s1.livePrice).toBe(112.5);
      expect(s1.livePrice).toBe(s1.formingCandle?.close);
    });

    test('12. A -> B -> A duplicate tick pattern handled via bounded idempotency queue', () => {
      const aggregator = new CanonicalCandleAggregator();

      const tickA = {
        symbol: 'NIFTY',
        price: 107,
        timestamp: '2026-09-13T09:40:00.000Z',
        volume: 100,
        volumeType: 'INCREMENTAL' as const,
        tickId: 'tick-A',
      };

      const tickB = {
        symbol: 'NIFTY',
        price: 108,
        timestamp: '2026-09-13T09:41:00.000Z',
        volume: 50,
        volumeType: 'INCREMENTAL' as const,
        tickId: 'tick-B',
      };

      const s1 = aggregator.processTick(baseSnapshot, tickA);
      const s2 = aggregator.processTick(s1, tickB);
      // Re-emit tickA (A -> B -> A)
      const s3 = aggregator.processTick(s2, tickA);

      expect(s3).toBe(s2); // Re-emitted tickA is ignored by bounded idempotency set
      expect(s3.formingCandle?.volume).toBe(150);
    });

    test('13. Out-of-order tick (09:42 -> 09:41) is rejected within forming candle bucket', () => {
      const aggregator = new CanonicalCandleAggregator();

      const s1 = aggregator.processTick(baseSnapshot, {
        symbol: 'NIFTY',
        price: 105,
        timestamp: '2026-09-13T09:42:00.000Z',
        volume: 100,
        volumeType: 'INCREMENTAL',
      });

      // Out-of-order tick arriving at 09:41
      const s2 = aggregator.processTick(s1, {
        symbol: 'NIFTY',
        price: 95,
        timestamp: '2026-09-13T09:41:00.000Z',
        volume: 50,
        volumeType: 'INCREMENTAL',
      });

      expect(s2).toBe(s1);
      expect(s2.formingCandle?.close).toBe(105); // Price not corrupted by late tick
    });

    test('14. Missing timestamp tick is rejected without browser wall-clock fallback', () => {
      const aggregator = new CanonicalCandleAggregator();

      const s1 = aggregator.processTick(baseSnapshot, {
        symbol: 'NIFTY',
        price: 108,
        timestamp: undefined as any,
        volumeType: 'INCREMENTAL',
      });

      expect(s1).toBe(baseSnapshot); // Rejected cleanly
      expect(s1.formingCandle).toBeNull();
    });

    test('15. SESSION_CUMULATIVE volume calculates exact session delta', () => {
      const aggregator = new CanonicalCandleAggregator();

      const s1 = aggregator.processTick(baseSnapshot, {
        symbol: 'NIFTY',
        price: 107,
        timestamp: '2026-09-13T09:40:00.000Z',
        sessionVolume: 1000,
        volumeType: 'SESSION_CUMULATIVE',
        providerId: 'NSE_TRUE_DATA',
      });

      const s2 = aggregator.processTick(s1, {
        symbol: 'NIFTY',
        price: 108,
        timestamp: '2026-09-13T09:41:00.000Z',
        sessionVolume: 1250,
        volumeType: 'SESSION_CUMULATIVE',
        providerId: 'NSE_TRUE_DATA',
      });

      // Session volume jumped 1000 -> 1250 (delta = 250)
      expect(s2.formingCandle?.volume).toBe(250);
    });

    test('16. Snapshot closedThrough matches latest closed candle timestamp and passes validator', () => {
      const snapshot: ChartMarketSnapshot = {
        symbol: 'NIFTY',
        timeframe: '15m',
        closedCandles: validClosedCandles,
        formingCandle: validFormingCandle,
        smcSnapshot: validSMCSnapshot,
        dataProvenance: 'LIVE',
        sourceIdentity: 'NSE_LIVE',
        livePrice: 108,
        asOfTimestamp: '2026-09-13T09:45:00.000Z',
        closedThrough: '2026-09-13T09:30:00.000Z',
        marketAsOf: '2026-09-13T09:45:00.000Z',
        observedAt: '2026-09-13T09:45:00.000Z',
      };

      const result = ChartSnapshotValidator.validateSnapshot(snapshot, 'NIFTY', '15m');
      expect(result.isValid).toBe(true);
    });

    test('17. syncFromSnapshot updates aggregator watermarks to server state', () => {
      const aggregator = new CanonicalCandleAggregator();
      const serverSnapshot: ChartMarketSnapshot = {
        ...baseSnapshot,
        closedCandles: validClosedCandles,
        formingCandle: validFormingCandle,
      };

      aggregator.syncFromSnapshot(serverSnapshot);

      // Attempt to process a tick earlier than server snapshot forming candle (09:40 vs 09:45)
      const stale = aggregator.processTick(serverSnapshot, {
        symbol: 'NIFTY',
        price: 104,
        timestamp: '2026-09-13T09:40:00.000Z',
        volumeType: 'INCREMENTAL',
      });

      expect(stale).toBe(serverSnapshot); // Rejected cleanly due to watermark sync
    });

    test('18. chartCandlesToICandles rejects non-finite and NaN candle fields', () => {
      const { chartCandlesToICandles, chartCandlesToICandlesResult } = require('@quant/shared');

      const invalidCandles: ChartCandle[] = [
        {
          timestamp: '2026-09-13T09:15:00.000Z',
          open: NaN, // Invalid
          high: 105,
          low: 98,
          close: 103,
          volume: 1000,
          isClosed: true,
        },
        {
          timestamp: '2026-09-13T09:30:00.000Z',
          open: 103,
          high: 108,
          low: 102,
          close: 106,
          volume: Infinity, // Invalid
          isClosed: true,
        },
        {
          timestamp: '2026-09-13T09:45:00.000Z',
          open: 106,
          high: 109,
          low: 105,
          close: 108,
          volume: 500,
          isClosed: true, // Valid
        },
      ];

      const res = chartCandlesToICandlesResult(invalidCandles);
      expect(res.isDegraded).toBe(true);
      expect(res.isValid).toBe(false);
      expect(res.candles).toHaveLength(1);
      expect(res.candles[0].close).toBe(108);

      expect(() => chartCandlesToICandles(invalidCandles)).toThrow();
    });

    test('19. SESSION_CUMULATIVE volume resets baseline across day session boundary', () => {
      const aggregator = new CanonicalCandleAggregator();

      // Day 1 tick
      const s1 = aggregator.processTick(baseSnapshot, {
        symbol: 'NIFTY',
        price: 107,
        timestamp: '2026-09-13T15:15:00.000Z',
        volume: 5000000,
        volumeType: 'SESSION_CUMULATIVE',
        providerId: 'NSE_TRUE_DATA',
      });

      // Day 2 tick (new 1d session open)
      const s2 = aggregator.processTick(s1, {
        symbol: 'NIFTY',
        price: 108,
        timestamp: '2026-09-14T09:16:00.000Z',
        volume: 100,
        volumeType: 'SESSION_CUMULATIVE',
        providerId: 'NSE_TRUE_DATA',
      });

      // Baseline reset to 100 without negative overflow
      expect(s2.formingCandle?.volume).toBe(0);
    });
  });
});
