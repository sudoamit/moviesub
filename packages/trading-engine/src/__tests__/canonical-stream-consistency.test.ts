import {
  CanonicalCandleAggregator,
  ChartMarketSnapshot,
  chartCandlesToICandlesResult,
  chartCandlesToICandles,
  VenueSessionCalendar,
} from '@quant/shared';
import { ChartSnapshotValidator } from '../chart-snapshot-validator';

describe('AI FIX 125 — Canonical Market Stream Consistency Suite', () => {
  let aggregator: CanonicalCandleAggregator;

  beforeEach(() => {
    aggregator = new CanonicalCandleAggregator();
  });

  // 1. Exchange-Local Session Identity Tests
  describe('VenueSessionCalendar', () => {
    test('NSE Equities/Indices 09:15 IST Session Identity', () => {
      // 09:15 IST on 2026-09-15 is 03:45 UTC on 2026-09-15
      const ts1 = new Date('2026-09-15T03:45:00.000Z');
      const key1 = VenueSessionCalendar.getSessionKey('NIFTY', ts1);
      expect(key1).toBe('NSE:2026-09-15');

      // Pre-market 09:00 IST on 2026-09-15 is 03:30 UTC
      const ts2 = new Date('2026-09-15T03:30:00.000Z');
      const key2 = VenueSessionCalendar.getSessionKey('BANKNIFTY', ts2);
      expect(key2).toBe('NSE:2026-09-15');

      // Late evening IST 15:30 IST is 10:00 UTC on 2026-09-15
      const ts3 = new Date('2026-09-15T10:00:00.000Z');
      const key3 = VenueSessionCalendar.getSessionKey('RELIANCE', ts3);
      expect(key3).toBe('NSE:2026-09-15');
    });

    test('Metals / Spot Gold Overnight 22:00 UTC Session Boundary', () => {
      // 21:59 UTC on 2026-09-15 belongs to 2026-09-15 session
      const tsBefore = new Date('2026-09-15T21:59:00.000Z');
      const keyBefore = VenueSessionCalendar.getSessionKey('XAUUSD', tsBefore);
      expect(keyBefore).toBe('METALS:2026-09-15');

      // 22:00 UTC on 2026-09-15 rolls into next trading day's session (2026-09-16)
      const tsAfter = new Date('2026-09-15T22:00:00.000Z');
      const keyAfter = VenueSessionCalendar.getSessionKey('XAUUSD', tsAfter);
      expect(keyAfter).toBe('METALS:2026-09-16');
    });

    test('Crypto 24/7 00:00 UTC Session Boundary', () => {
      const ts1 = new Date('2026-09-15T00:00:00.000Z');
      const key1 = VenueSessionCalendar.getSessionKey('BTCUSDT', ts1);
      expect(key1).toBe('CRYPTO:2026-09-15');

      const ts2 = new Date('2026-09-15T23:59:59.000Z');
      const key2 = VenueSessionCalendar.getSessionKey('ETHUSDT', ts2);
      expect(key2).toBe('CRYPTO:2026-09-15');
    });
  });

  // 2. Snapshot Resynchronization & Watermark Restoration
  describe('Aggregator syncFromSnapshot & Watermarks', () => {
    test('Restores latest event watermark (marketAsOf) and venue session key', () => {
      const initialSnapshot: ChartMarketSnapshot = {
        symbol: 'BTCUSDT',
        timeframe: '15m',
        closedCandles: [
          { timestamp: '2026-09-15T10:00:00.000Z', open: 50000, high: 50100, low: 49900, close: 50050, volume: 10, isClosed: true },
        ],
        formingCandle: {
          timestamp: '2026-09-15T10:15:00.000Z',
          open: 50050,
          high: 50200,
          low: 50000,
          close: 50150,
          volume: 5,
          isClosed: false,
          volumeType: 'SESSION_CUMULATIVE',
        },
        livePrice: 50150,
        closedThrough: '2026-09-15T10:00:00.000Z',
        marketAsOf: '2026-09-15T10:22:30.000Z',
        sessionKey: 'CRYPTO:2026-09-15',
        asOfTimestamp: '2026-09-15T10:22:35.000Z',
        dataProvenance: 'LIVE',
        sourceIdentity: 'BINANCE_REALTIME',
      };

      aggregator.syncFromSnapshot(initialSnapshot);

      // Process tick at 10:23:00 (after marketAsOf 10:22:30)
      const updated = aggregator.processTick(initialSnapshot, {
        symbol: 'BTCUSDT',
        price: 50180,
        timestamp: '2026-09-15T10:23:00.000Z',
        volume: 12,
        volumeType: 'INCREMENTAL',
      });

      expect(updated.marketAsOf).toBe('2026-09-15T10:23:00.000Z');
      expect(updated.formingCandle?.timestamp).toBe('2026-09-15T10:15:00.000Z'); // Bucket open time preserved
      expect(updated.livePrice).toBe(50180);
      expect(updated.sessionKey).toBe('CRYPTO:2026-09-15');
    });

    test('Rejects out-of-order ticks earlier than restored marketAsOf watermark', () => {
      const snapshot: ChartMarketSnapshot = {
        symbol: 'NIFTY',
        timeframe: '15m',
        closedCandles: [
          { timestamp: '2026-09-15T09:15:00.000Z', open: 25000, high: 25100, low: 24950, close: 25050, volume: 100, isClosed: true },
        ],
        formingCandle: {
          timestamp: '2026-09-15T09:30:00.000Z',
          open: 25050,
          high: 25080,
          low: 25040,
          close: 25070,
          volume: 50,
          isClosed: false,
        },
        livePrice: 25070,
        closedThrough: '2026-09-15T09:15:00.000Z',
        marketAsOf: '2026-09-15T09:35:00.000Z',
        sessionKey: 'NSE:2026-09-15',
        asOfTimestamp: '2026-09-15T09:35:05.000Z',
        dataProvenance: 'LIVE',
        sourceIdentity: 'NSE_REALTIME',
      };

      aggregator.syncFromSnapshot(snapshot);

      // Tick arriving at 09:32:00 (before marketAsOf 09:35:00) must be rejected
      const result = aggregator.processTick(snapshot, {
        symbol: 'NIFTY',
        price: 25060,
        timestamp: '2026-09-15T09:32:00.000Z',
        volumeType: 'INCREMENTAL',
      });

      expect(result).toBe(snapshot); // Unmodified
    });
  });

  // 3. Sequence Monotonicity & Tick Identity Namespacing
  describe('Sequence Monotonicity & Tick Identity', () => {
    test('Rejects stale sequence numbers on same provider stream', () => {
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

      // Tick 1 with sequence 100
      const snap1 = aggregator.processTick(snapshot, {
        symbol: 'BTCUSDT',
        price: 50100,
        timestamp: '2026-09-15T10:15:01.000Z',
        sequenceNumber: 100,
        providerId: 'binance-1',
        volumeType: 'INCREMENTAL',
      });
      expect(snap1.livePrice).toBe(50100);

      // Stale Tick with sequence 99 must be rejected
      const snap2 = aggregator.processTick(snap1, {
        symbol: 'BTCUSDT',
        price: 50090,
        timestamp: '2026-09-15T10:15:02.000Z',
        sequenceNumber: 99,
        providerId: 'binance-1',
        volumeType: 'INCREMENTAL',
      });
      expect(snap2).toBe(snap1);

      // Reconnect tick with sequence 1 resets watermark
      const snap3 = aggregator.processTick(snap2, {
        symbol: 'BTCUSDT',
        price: 50110,
        timestamp: '2026-09-15T10:15:03.000Z',
        sequenceNumber: 1,
        providerId: 'binance-1',
        isReconnect: true,
        volumeType: 'INCREMENTAL',
      });
      expect(snap3.livePrice).toBe(50110);
    });

    test('Bounded 500-item FIFO cache permits ticks after eviction', () => {
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

      let current = snapshot;
      const baseTime = new Date('2026-09-15T10:15:00.000Z').getTime();

      // Process tick #0 with explicit tickId
      current = aggregator.processTick(current, {
        symbol: 'BTCUSDT',
        price: 50000,
        timestamp: new Date(baseTime).toISOString(),
        tickId: 'tick_0',
        volumeType: 'INCREMENTAL',
      });

      // Immediate duplicate tick #0 is rejected
      const dup0 = aggregator.processTick(current, {
        symbol: 'BTCUSDT',
        price: 50000,
        timestamp: new Date(baseTime).toISOString(),
        tickId: 'tick_0',
        volumeType: 'INCREMENTAL',
      });
      expect(dup0).toBe(current);

      // Process 505 unique ticks to evict tick #0 from bounded 500 cache
      for (let i = 1; i <= 505; i++) {
        current = aggregator.processTick(current, {
          symbol: 'BTCUSDT',
          price: 50000 + (i % 10),
          timestamp: new Date(baseTime + i * 10).toISOString(),
          tickId: `tick_${i}`,
          volumeType: 'INCREMENTAL',
        });
      }

      // Re-sending tick #0 after 505 items succeeds because of bounded cache size
      const replayed = aggregator.processTick(current, {
        symbol: 'BTCUSDT',
        price: 50000,
        timestamp: new Date(baseTime + 506 * 10).toISOString(),
        tickId: 'tick_0',
        volumeType: 'INCREMENTAL',
      });
      expect(replayed).not.toBe(current);
    });
  });

  // 4. Fail-Closed SMC Adapter & Degradation Handling
  describe('Fail-Closed SMC Adapter (chartCandlesToICandlesResult)', () => {
    test('Surfaces explicit degradation when closedCandles contain non-finite OHLCV values', () => {
      const invalidClosed: any[] = [
        { timestamp: '2026-09-15T10:00:00.000Z', open: 50000, high: 50100, low: 49900, close: 50050, volume: 10, isClosed: true },
        { timestamp: '2026-09-15T10:15:00.000Z', open: NaN, high: 50200, low: 50000, close: 50150, volume: 15, isClosed: true },
      ];

      const res = chartCandlesToICandlesResult(invalidClosed);
      expect(res.isValid).toBe(false);
      expect(res.isDegraded).toBe(true);
      expect(res.degradationReason).toBeDefined();

      expect(() => chartCandlesToICandles(invalidClosed)).toThrow();
    });

    test('Validates strictly increasing chronological timestamps in closedCandles', () => {
      const outOfOrderClosed: any[] = [
        { timestamp: '2026-09-15T10:15:00.000Z', open: 50000, high: 50100, low: 49900, close: 50050, volume: 10, isClosed: true },
        { timestamp: '2026-09-15T10:00:00.000Z', open: 50050, high: 50200, low: 50000, close: 50150, volume: 15, isClosed: true },
      ];

      const res = chartCandlesToICandlesResult(outOfOrderClosed);
      expect(res.isValid).toBe(false);
      expect(res.isDegraded).toBe(true);
    });
  });

  // 5. ChartSnapshotValidator Invariants
  describe('ChartSnapshotValidator Strict Invariants', () => {
    test('Validates a complete canonical snapshot cleanly', () => {
      const validSnapshot: ChartMarketSnapshot = {
        symbol: 'NIFTY',
        timeframe: '15m',
        closedCandles: [
          { timestamp: '2026-09-15T09:15:00.000Z', open: 25000, high: 25100, low: 24950, close: 25050, volume: 100, isClosed: true },
          { timestamp: '2026-09-15T09:30:00.000Z', open: 25050, high: 25120, low: 25040, close: 25100, volume: 120, isClosed: true },
        ],
        formingCandle: {
          timestamp: '2026-09-15T09:45:00.000Z',
          open: 25100,
          high: 25150,
          low: 25090,
          close: 25130,
          volume: 40,
          isClosed: false,
        },
        livePrice: 25130,
        closedThrough: '2026-09-15T09:30:00.000Z',
        asOfTimestamp: '2026-09-15T09:50:00.000Z',
        marketAsOf: '2026-09-15T09:50:00.000Z',
        sessionKey: 'NSE:2026-09-15',
        dataProvenance: 'LIVE',
        sourceIdentity: 'NSE_REALTIME',
        smcSnapshot: {
          symbol: 'NIFTY',
          timeframe: '15m',
          asOfTimestamp: '2026-09-15T09:50:00.000Z',
          computedAt: '2026-09-15T09:50:00.000Z',
          structureAsOf: '2026-09-15T09:30:00.000Z',
          provenance: 'LIVE',
        },
      };

      const res = ChartSnapshotValidator.validateSnapshot(validSnapshot, 'NIFTY', '15m');
      expect(res.isValid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    test('Rejects snapshot when sourceIdentity or dataProvenance is missing', () => {
      const invalidSnapshot: any = {
        symbol: 'NIFTY',
        timeframe: '15m',
        closedCandles: [
          { timestamp: '2026-09-15T09:15:00.000Z', open: 25000, high: 25100, low: 24950, close: 25050, volume: 100, isClosed: true },
        ],
        formingCandle: null,
        livePrice: 25050,
        asOfTimestamp: '2026-09-15T09:30:00.000Z',
        sourceIdentity: '', // Empty sourceIdentity
      };

      const res = ChartSnapshotValidator.validateSnapshot(invalidSnapshot);
      expect(res.isValid).toBe(false);
      expect(res.errors.some((e) => e.includes('sourceIdentity'))).toBe(true);
    });
  });
});
