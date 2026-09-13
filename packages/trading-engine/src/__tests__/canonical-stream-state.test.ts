import {
  CanonicalCandleAggregator,
  ChartMarketSnapshot,
  VenueSessionCalendar,
} from '@quant/shared';
import { ChartSnapshotValidator } from '../chart-snapshot-validator';

describe('AI FIX 126 — Canonical Stream State Correctness Suite', () => {
  let aggregator: CanonicalCandleAggregator;

  beforeEach(() => {
    aggregator = new CanonicalCandleAggregator();
  });

  // 1. Transactional Sequence Watermarks
  describe('Transactional Sequence & Watermark Commit', () => {
    test('1. Rejected tick does not advance sequence number', () => {
      const snapshot: ChartMarketSnapshot = {
        symbol: 'BTCUSDT',
        timeframe: '15m',
        closedCandles: [
          { timestamp: '2026-09-15T10:00:00.000Z', open: 50000, high: 50100, low: 49900, close: 50050, volume: 10, isClosed: true },
        ],
        formingCandle: null,
        livePrice: 50050,
        closedThrough: '2026-09-15T10:00:00.000Z',
        asOfTimestamp: '2026-09-15T10:00:00.000Z',
        dataProvenance: 'LIVE',
        sourceIdentity: 'BINANCE_WS',
      };

      // Valid tick seq 100
      const snap1 = aggregator.processTick(snapshot, {
        symbol: 'BTCUSDT',
        price: 50100,
        timestamp: '2026-09-15T10:15:01.000Z',
        sequenceNumber: 100,
        providerId: 'p1',
        connectionEpoch: 'ep1',
        volumeType: 'INCREMENTAL',
      });
      expect(snap1.livePrice).toBe(50100);
      expect(snap1.streamState?.lastSequenceNumber).toBe(100);

      // Invalid tick seq 101 (invalid negative price)
      const snap2 = aggregator.processTick(snap1, {
        symbol: 'BTCUSDT',
        price: -10, // INVALID PRICE
        timestamp: '2026-09-15T10:15:02.000Z',
        sequenceNumber: 101,
        providerId: 'p1',
        connectionEpoch: 'ep1',
        volumeType: 'INCREMENTAL',
      });
      expect(snap2).toBe(snap1); // Rejected

      // Valid tick seq 101 must be accepted because watermark did not advance on invalid tick 101
      const snap3 = aggregator.processTick(snap1, {
        symbol: 'BTCUSDT',
        price: 50120,
        timestamp: '2026-09-15T10:15:02.000Z',
        sequenceNumber: 101,
        providerId: 'p1',
        connectionEpoch: 'ep1',
        volumeType: 'INCREMENTAL',
      });
      expect(snap3.livePrice).toBe(50120);
      expect(snap3.streamState?.lastSequenceNumber).toBe(101);
    });

    test('2. Invalid tick followed by same sequence valid tick (valid accepted)', () => {
      const snapshot: ChartMarketSnapshot = {
        symbol: 'NIFTY',
        timeframe: '15m',
        closedCandles: [
          { timestamp: '2026-09-15T09:15:00.000Z', open: 25000, high: 25100, low: 24950, close: 25050, volume: 100, isClosed: true },
        ],
        formingCandle: null,
        livePrice: 25050,
        closedThrough: '2026-09-15T09:15:00.000Z',
        asOfTimestamp: '2026-09-15T09:15:00.000Z',
        dataProvenance: 'LIVE',
        sourceIdentity: 'NSE_WS',
      };

      // Invalid tick seq 50 (symbol mismatch)
      const snap1 = aggregator.processTick(snapshot, {
        symbol: 'WRONG_SYMBOL',
        price: 25060,
        timestamp: '2026-09-15T09:30:01.000Z',
        sequenceNumber: 50,
        providerId: 'nse-1',
        connectionEpoch: 'ep1',
        volumeType: 'INCREMENTAL',
      });
      expect(snap1).toBe(snapshot);

      // Valid tick seq 50 accepted
      const snap2 = aggregator.processTick(snapshot, {
        symbol: 'NIFTY',
        price: 25070,
        timestamp: '2026-09-15T09:30:01.000Z',
        sequenceNumber: 50,
        providerId: 'nse-1',
        connectionEpoch: 'ep1',
        volumeType: 'INCREMENTAL',
      });
      expect(snap2.livePrice).toBe(25070);
      expect(snap2.streamState?.lastSequenceNumber).toBe(50);
    });
  });

  // 2. Reconnect Stream Epoch Boundaries
  describe('Stream Reconnect Epochs', () => {
    test('3. Reconnect epoch reset permits sequence restart', () => {
      const snapshot: ChartMarketSnapshot = {
        symbol: 'BTCUSDT',
        timeframe: '15m',
        closedCandles: [
          { timestamp: '2026-09-15T10:00:00.000Z', open: 50000, high: 50100, low: 49900, close: 50050, volume: 10, isClosed: true },
        ],
        formingCandle: null,
        livePrice: 50050,
        closedThrough: '2026-09-15T10:00:00.000Z',
        asOfTimestamp: '2026-09-15T10:00:00.000Z',
        dataProvenance: 'LIVE',
        sourceIdentity: 'BINANCE_WS',
      };

      // Epoch A seq 9500
      const snapA = aggregator.processTick(snapshot, {
        symbol: 'BTCUSDT',
        price: 50100,
        timestamp: '2026-09-15T10:15:01.000Z',
        sequenceNumber: 9500,
        providerId: 'binance-1',
        connectionEpoch: 'epoch-A',
        volumeType: 'INCREMENTAL',
      });
      expect(snapA.streamState?.connectionEpoch).toBe('epoch-A');
      expect(snapA.streamState?.lastSequenceNumber).toBe(9500);

      // Epoch B seq 1 with isReconnect: true
      const snapB1 = aggregator.processTick(snapA, {
        symbol: 'BTCUSDT',
        price: 50110,
        timestamp: '2026-09-15T10:15:02.000Z',
        sequenceNumber: 1,
        providerId: 'binance-1',
        connectionEpoch: 'epoch-B',
        isReconnect: true,
        volumeType: 'INCREMENTAL',
      });
      expect(snapB1.streamState?.connectionEpoch).toBe('epoch-B');
      expect(snapB1.streamState?.lastSequenceNumber).toBe(1);

      // Epoch B seq 2
      const snapB2 = aggregator.processTick(snapB1, {
        symbol: 'BTCUSDT',
        price: 50120,
        timestamp: '2026-09-15T10:15:03.000Z',
        sequenceNumber: 2,
        providerId: 'binance-1',
        connectionEpoch: 'epoch-B',
        volumeType: 'INCREMENTAL',
      });
      expect(snapB2.streamState?.lastSequenceNumber).toBe(2);
    });

    test('4. Ticks matching old connection epoch are rejected', () => {
      const snapshot: ChartMarketSnapshot = {
        symbol: 'BTCUSDT',
        timeframe: '15m',
        closedCandles: [
          { timestamp: '2026-09-15T10:00:00.000Z', open: 50000, high: 50100, low: 49900, close: 50050, volume: 10, isClosed: true },
        ],
        formingCandle: null,
        livePrice: 50050,
        closedThrough: '2026-09-15T10:00:00.000Z',
        asOfTimestamp: '2026-09-15T10:00:00.000Z',
        dataProvenance: 'LIVE',
        sourceIdentity: 'BINANCE_WS',
      };

      // Connect to epoch-B
      const snapB = aggregator.processTick(snapshot, {
        symbol: 'BTCUSDT',
        price: 50100,
        timestamp: '2026-09-15T10:15:01.000Z',
        sequenceNumber: 1,
        providerId: 'binance-1',
        connectionEpoch: 'epoch-B',
        isReconnect: true,
        volumeType: 'INCREMENTAL',
      });

      // Late tick from old epoch-A rejected
      const snapOld = aggregator.processTick(snapB, {
        symbol: 'BTCUSDT',
        price: 50090,
        timestamp: '2026-09-15T10:15:02.000Z',
        sequenceNumber: 9999,
        providerId: 'binance-1',
        connectionEpoch: 'epoch-A',
        volumeType: 'INCREMENTAL',
      });
      expect(snapOld).toBe(snapB); // Unchanged
    });
  });

  // 3. Session Cumulative Volume Watermarks
  describe('Session Cumulative Volume Watermark', () => {
    test('5. syncFromSnapshot restores sessionVolumeWatermark directly', () => {
      const snapshot: ChartMarketSnapshot = {
        symbol: 'NIFTY',
        timeframe: '15m',
        closedCandles: [
          { timestamp: '2026-09-15T09:15:00.000Z', open: 25000, high: 25100, low: 24950, close: 25050, volume: 100, isClosed: true },
        ],
        formingCandle: {
          timestamp: '2026-09-15T09:30:00.000Z',
          open: 25050,
          high: 25100,
          low: 25040,
          close: 25080,
          volume: 500,
          isClosed: false,
          volumeType: 'SESSION_CUMULATIVE',
        },
        livePrice: 25080,
        closedThrough: '2026-09-15T09:15:00.000Z',
        sessionVolumeWatermark: 10500,
        streamState: {
          marketAsOf: '2026-09-15T09:35:00.000Z',
          sessionKey: 'NSE:2026-09-15',
          sessionVolumeWatermark: 10500,
        },
        asOfTimestamp: '2026-09-15T09:35:00.000Z',
        dataProvenance: 'LIVE',
        sourceIdentity: 'NSE_WS',
      };

      aggregator.syncFromSnapshot(snapshot);

      // Process SESSION_CUMULATIVE tick with reading 10700 (expected delta 200)
      const updated = aggregator.processTick(snapshot, {
        symbol: 'NIFTY',
        price: 25090,
        timestamp: '2026-09-15T09:36:00.000Z',
        sessionVolume: 10700,
        volumeType: 'SESSION_CUMULATIVE',
      });

      // Forming candle volume should be 500 + 200 = 700
      expect(updated.formingCandle?.volume).toBe(700);
      expect(updated.sessionVolumeWatermark).toBe(10700);
    });

    test('6. Cumulative volume delta calculation after restore', () => {
      const snapshot: ChartMarketSnapshot = {
        symbol: 'NIFTY',
        timeframe: '15m',
        closedCandles: [
          { timestamp: '2026-09-15T09:15:00.000Z', open: 25000, high: 25100, low: 24950, close: 25050, volume: 100, isClosed: true },
        ],
        formingCandle: {
          timestamp: '2026-09-15T09:30:00.000Z',
          open: 25050,
          high: 25100,
          low: 25040,
          close: 25080,
          volume: 300,
          isClosed: false,
          volumeType: 'SESSION_CUMULATIVE',
        },
        livePrice: 25080,
        closedThrough: '2026-09-15T09:15:00.000Z',
        sessionVolumeWatermark: 5000,
        streamState: {
          marketAsOf: '2026-09-15T09:32:00.000Z',
          sessionKey: 'NSE:2026-09-15',
          sessionVolumeWatermark: 5000,
        },
        asOfTimestamp: '2026-09-15T09:32:00.000Z',
        dataProvenance: 'LIVE',
        sourceIdentity: 'NSE_WS',
      };

      aggregator.syncFromSnapshot(snapshot);

      const nextTick = aggregator.processTick(snapshot, {
        symbol: 'NIFTY',
        price: 25095,
        timestamp: '2026-09-15T09:33:00.000Z',
        sessionVolume: 5150, // Delta = 150
        volumeType: 'SESSION_CUMULATIVE',
      });

      expect(nextTick.formingCandle?.volume).toBe(450); // 300 + 150
      expect(nextTick.sessionVolumeWatermark).toBe(5150);
    });

    test('7. Session transition resets sessionVolumeWatermark baseline', () => {
      const snapshot: ChartMarketSnapshot = {
        symbol: 'NIFTY',
        timeframe: '15m',
        closedCandles: [
          { timestamp: '2026-09-15T15:15:00.000Z', open: 25000, high: 25100, low: 24950, close: 25050, volume: 100, isClosed: true },
        ],
        formingCandle: null,
        livePrice: 25050,
        closedThrough: '2026-09-15T15:15:00.000Z',
        sessionKey: 'NSE:2026-09-15',
        sessionVolumeWatermark: 50000,
        asOfTimestamp: '2026-09-15T15:30:00.000Z',
        dataProvenance: 'LIVE',
        sourceIdentity: 'NSE_WS',
      };

      aggregator.syncFromSnapshot(snapshot);

      // Tick on next day's session (2026-09-16 09:15 IST / 03:45 UTC)
      const nextDayTick = aggregator.processTick(snapshot, {
        symbol: 'NIFTY',
        price: 25100,
        timestamp: '2026-09-16T03:45:00.000Z',
        sessionVolume: 250, // New day session starting cumulative volume
        volumeType: 'SESSION_CUMULATIVE',
      });

      expect(nextDayTick.sessionKey).toBe('NSE:2026-09-16');
      expect(nextDayTick.formingCandle?.volume).toBe(0); // Initial forming volume for SESSION_CUMULATIVE starts at 0
      expect(nextDayTick.sessionVolumeWatermark).toBe(250);
    });
  });

  // 4. Timestamp Semantics & Invariants
  describe('Timestamp Semantics & Invariants', () => {
    test('8 & 9 & 10. marketAsOf > formingCandle timestamp when tick arrives within bucket', () => {
      const snapshot: ChartMarketSnapshot = {
        symbol: 'BTCUSDT',
        timeframe: '15m',
        closedCandles: [
          { timestamp: '2026-09-15T10:00:00.000Z', open: 50000, high: 50100, low: 49900, close: 50050, volume: 10, isClosed: true },
        ],
        formingCandle: {
          timestamp: '2026-09-15T10:15:00.000Z', // Bucket open
          open: 50050,
          high: 50100,
          low: 50000,
          close: 50080,
          volume: 5,
          isClosed: false,
        },
        livePrice: 50080,
        closedThrough: '2026-09-15T10:00:00.000Z',
        marketAsOf: '2026-09-15T10:15:00.000Z',
        asOfTimestamp: '2026-09-15T10:15:00.000Z',
        dataProvenance: 'LIVE',
        sourceIdentity: 'BINANCE_WS',
      };

      aggregator.syncFromSnapshot(snapshot);

      // Tick arriving at 10:22:15.123Z
      const updated = aggregator.processTick(snapshot, {
        symbol: 'BTCUSDT',
        price: 50150,
        timestamp: '2026-09-15T10:22:15.123Z',
        volumeType: 'INCREMENTAL',
      });

      // Forming candle timestamp MUST remain bucket open 10:15:00.000Z
      expect(updated.formingCandle?.timestamp).toBe('2026-09-15T10:15:00.000Z');
      // marketAsOf MUST reflect actual tick event timestamp 10:22:15.123Z
      expect(updated.marketAsOf).toBe('2026-09-15T10:22:15.123Z');
      expect(new Date(updated.marketAsOf!).getTime()).toBeGreaterThan(
        new Date(updated.formingCandle!.timestamp).getTime(),
      );
    });

    test('11. Snapshot validator enforces temporal invariants (structureAsOf <= marketAsOf <= asOfTimestamp)', () => {
      const validSnapshot: ChartMarketSnapshot = {
        symbol: 'NIFTY',
        timeframe: '15m',
        closedCandles: [
          { timestamp: '2026-09-15T09:15:00.000Z', open: 25000, high: 25100, low: 24950, close: 25050, volume: 100, isClosed: true },
        ],
        formingCandle: {
          timestamp: '2026-09-15T09:30:00.000Z',
          open: 25050,
          high: 25100,
          low: 25040,
          close: 25080,
          volume: 10,
          isClosed: false,
        },
        livePrice: 25080,
        closedThrough: '2026-09-15T09:15:00.000Z',
        marketAsOf: '2026-09-15T09:42:00.000Z',
        asOfTimestamp: '2026-09-15T09:42:05.000Z',
        sessionKey: 'NSE:2026-09-15',
        dataProvenance: 'LIVE',
        sourceIdentity: 'NSE_REALTIME',
        smcSnapshot: {
          symbol: 'NIFTY',
          timeframe: '15m',
          asOfTimestamp: '2026-09-15T09:42:05.000Z',
          computedAt: '2026-09-15T09:42:05.000Z',
          structureAsOf: '2026-09-15T09:15:00.000Z',
          marketAsOf: '2026-09-15T09:42:00.000Z',
          provenance: 'LIVE',
        },
      };

      const val = ChartSnapshotValidator.validateSnapshot(validSnapshot, 'NIFTY', '15m');
      expect(val.isValid).toBe(true);

      // Invalid snapshot: marketAsOf strictly before closedThrough
      const invalidSnapshot: ChartMarketSnapshot = {
        ...validSnapshot,
        marketAsOf: '2026-09-15T09:10:00.000Z', // Before closedThrough 09:15
      };
      const invalidVal = ChartSnapshotValidator.validateSnapshot(invalidSnapshot, 'NIFTY', '15m');
      expect(invalidVal.isValid).toBe(false);
      expect(invalidVal.errors.some((e) => e.includes('marketAsOf'))).toBe(true);
    });

    test('12. Provider identity namespace includes providerId + connectionEpoch + tickId', () => {
      const snapshot: ChartMarketSnapshot = {
        symbol: 'BTCUSDT',
        timeframe: '15m',
        closedCandles: [
          { timestamp: '2026-09-15T10:00:00.000Z', open: 50000, high: 50100, low: 49900, close: 50050, volume: 10, isClosed: true },
        ],
        formingCandle: null,
        livePrice: 50050,
        closedThrough: '2026-09-15T10:00:00.000Z',
        asOfTimestamp: '2026-09-15T10:00:00.000Z',
        dataProvenance: 'LIVE',
        sourceIdentity: 'BINANCE_WS',
      };

      // Tick from provider A
      const snapA = aggregator.processTick(snapshot, {
        symbol: 'BTCUSDT',
        price: 50100,
        timestamp: '2026-09-15T10:15:01.000Z',
        tickId: 'same_id_123',
        providerId: 'providerA',
        connectionEpoch: 'ep1',
        volumeType: 'INCREMENTAL',
      });
      expect(snapA.livePrice).toBe(50100);

      // Tick with same tickId from provider B is accepted due to namespacing
      const snapB = aggregator.processTick(snapA, {
        symbol: 'BTCUSDT',
        price: 50120,
        timestamp: '2026-09-15T10:15:02.000Z',
        tickId: 'same_id_123',
        providerId: 'providerB',
        connectionEpoch: 'ep1',
        volumeType: 'INCREMENTAL',
      });
      expect(snapB.livePrice).toBe(50120);
    });

    test('13. Bounded cache permits reprocessing tick ID after 500 items evicted it', () => {
      const snapshot: ChartMarketSnapshot = {
        symbol: 'BTCUSDT',
        timeframe: '15m',
        closedCandles: [
          { timestamp: '2026-09-15T10:00:00.000Z', open: 50000, high: 50100, low: 49900, close: 50050, volume: 10, isClosed: true },
        ],
        formingCandle: null,
        livePrice: 50050,
        closedThrough: '2026-09-15T10:00:00.000Z',
        asOfTimestamp: '2026-09-15T10:00:00.000Z',
        dataProvenance: 'LIVE',
        sourceIdentity: 'BINANCE_WS',
      };

      const baseTime = new Date('2026-09-15T10:15:00.000Z').getTime();
      let current = aggregator.processTick(snapshot, {
        symbol: 'BTCUSDT',
        price: 50000,
        timestamp: new Date(baseTime).toISOString(),
        tickId: 'tick_unique_0',
        volumeType: 'INCREMENTAL',
      });

      // Fill cache with 505 entries
      for (let i = 1; i <= 505; i++) {
        current = aggregator.processTick(current, {
          symbol: 'BTCUSDT',
          price: 50000 + i,
          timestamp: new Date(baseTime + i * 1000).toISOString(),
          tickId: `tick_unique_${i}`,
          volumeType: 'INCREMENTAL',
        });
      }

      // Re-sending tick_unique_0 after 505 items evicted it succeeds
      const replayed = aggregator.processTick(current, {
        symbol: 'BTCUSDT',
        price: 50600,
        timestamp: new Date(baseTime + 506 * 1000).toISOString(),
        tickId: 'tick_unique_0',
        volumeType: 'INCREMENTAL',
      });
      expect(replayed.livePrice).toBe(50600);
    });
  });
});
