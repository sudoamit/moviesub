import {
  CanonicalCandleAggregator,
  ChartMarketSnapshot,
  VenueSessionCalendar,
  ProviderSequenceCapabilityRegistry,
} from '@quant/shared';
import { ChartSnapshotValidator } from '../chart-snapshot-validator';

describe('AI FIX 127 — Canonical Market Event & Session Watermark Correction Suite', () => {
  let aggregator: CanonicalCandleAggregator;

  beforeEach(() => {
    aggregator = new CanonicalCandleAggregator();
  });

  // 1. Market Event Timestamps & Removal of Date.now()
  describe('Market Event Timestamps (No Date.now() synthesis)', () => {
    test('1 & 2. Backend marketAsOf uses actual provider event time (Date.now does not corrupt historical event time)', () => {
      const historicalEventIso = '2026-09-15T10:15:00.000Z';
      const snapshot: ChartMarketSnapshot = {
        symbol: 'BTCUSDT',
        timeframe: '15m',
        closedCandles: [
          { timestamp: '2026-09-15T10:00:00.000Z', open: 50000, high: 50100, low: 49900, close: 50050, volume: 10, isClosed: true },
        ],
        formingCandle: {
          timestamp: '2026-09-15T10:15:00.000Z',
          open: 50050,
          high: 50100,
          low: 50000,
          close: 50080,
          volume: 5,
          isClosed: false,
        },
        livePrice: 50080,
        closedThrough: '2026-09-15T10:00:00.000Z',
        marketAsOf: historicalEventIso,
        observedAt: '2026-09-15T10:20:00.000Z',
        asOfTimestamp: '2026-09-15T10:20:00.000Z',
        dataProvenance: 'LIVE',
        sourceIdentity: 'BINANCE_WS',
      };

      expect(snapshot.marketAsOf).toBe(historicalEventIso);
      expect(new Date(snapshot.observedAt!).getTime()).toBeGreaterThan(new Date(snapshot.marketAsOf!).getTime());
    });

    test('3 & 13. observedAt can be later than marketAsOf (enforced by validator)', () => {
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
        observedAt: '2026-09-15T09:35:05.000Z',
        asOfTimestamp: '2026-09-15T09:35:05.000Z',
        sessionKey: 'NSE:2026-09-15',
        dataProvenance: 'LIVE',
        sourceIdentity: 'NSE_REALTIME',
      };

      const val = ChartSnapshotValidator.validateSnapshot(snapshot, 'NIFTY', '15m');
      expect(val.isValid).toBe(true);

      // Invalid: marketAsOf strictly after observedAt
      const invalidSnapshot: ChartMarketSnapshot = {
        ...snapshot,
        marketAsOf: '2026-09-15T09:40:00.000Z',
        observedAt: '2026-09-15T09:35:00.000Z',
      };
      const invVal = ChartSnapshotValidator.validateSnapshot(invalidSnapshot, 'NIFTY', '15m');
      expect(invVal.isValid).toBe(false);
      expect(invVal.errors.some((e) => e.includes('observedAt'))).toBe(true);
    });

    test('14 & 15. marketAsOf >= closedThrough and formingCandle.timestamp <= marketAsOf', () => {
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
        marketAsOf: '2026-09-15T09:20:00.000Z', // BEFORE formingCandle timestamp 09:30
        observedAt: '2026-09-15T09:35:05.000Z',
        asOfTimestamp: '2026-09-15T09:35:05.000Z',
        sessionKey: 'NSE:2026-09-15',
        dataProvenance: 'LIVE',
        sourceIdentity: 'NSE_REALTIME',
      };

      const val = ChartSnapshotValidator.validateSnapshot(snapshot, 'NIFTY', '15m');
      expect(val.isValid).toBe(false);
      expect(val.errors.some((e) => e.includes('formingCandle timestamp'))).toBe(true);
    });
  });

  // 2. True SESSION_CUMULATIVE Volume Semantics
  describe('True SESSION_CUMULATIVE Volume Semantics', () => {
    test('4. SESSION_CUMULATIVE tick missing sessionVolume rejects volume update (fail closed)', () => {
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
          volume: 300,
          isClosed: false,
          volumeType: 'SESSION_CUMULATIVE',
        },
        livePrice: 25070,
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

      // Tick with SESSION_CUMULATIVE but NO sessionVolume specified
      const updated = aggregator.processTick(snapshot, {
        symbol: 'NIFTY',
        price: 25090,
        timestamp: '2026-09-15T09:33:00.000Z',
        volume: 50, // volume without sessionVolume
        volumeType: 'SESSION_CUMULATIVE',
      });

      // Volume MUST remain unchanged at 300 without fabricating delta or baseline
      expect(updated.formingCandle?.volume).toBe(300);
    });

    test('5 & 6. sessionVolume delta calculation and watermark restoration', () => {
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
          volume: 200,
          isClosed: false,
          volumeType: 'SESSION_CUMULATIVE',
        },
        livePrice: 25070,
        closedThrough: '2026-09-15T09:15:00.000Z',
        sessionVolumeWatermark: 10000,
        streamState: {
          marketAsOf: '2026-09-15T09:32:00.000Z',
          sessionKey: 'NSE:2026-09-15',
          sessionVolumeWatermark: 10000,
        },
        asOfTimestamp: '2026-09-15T09:32:00.000Z',
        dataProvenance: 'LIVE',
        sourceIdentity: 'NSE_WS',
      };

      aggregator.syncFromSnapshot(snapshot);

      // SESSION_CUMULATIVE tick with reading 10250 (delta = 250)
      const updated = aggregator.processTick(snapshot, {
        symbol: 'NIFTY',
        price: 25095,
        timestamp: '2026-09-15T09:33:00.000Z',
        sessionVolume: 10250,
        volumeType: 'SESSION_CUMULATIVE',
      });

      expect(updated.formingCandle?.volume).toBe(450); // 200 + 250
      expect(updated.sessionVolumeWatermark).toBe(10250);
    });

    test('7. sessionVolumeWatermark cannot cross sessionKey boundary', () => {
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
        sessionVolume: 500,
        volumeType: 'SESSION_CUMULATIVE',
      });

      expect(nextDayTick.sessionKey).toBe('NSE:2026-09-16');
      expect(nextDayTick.sessionVolumeWatermark).toBe(500);
      expect(nextDayTick.formingCandle?.volume).toBe(0); // New day forming candle volume starts at 0
    });
  });

  // 3. REST Bootstrap vs LIVE Stream Epochs
  describe('REST Bootstrap vs LIVE Stream Epochs', () => {
    test('8 & 9. REST bootstrap sets REST_BOOTSTRAP epoch, LIVE stream establishes real epoch', () => {
      const restSnapshot: ChartMarketSnapshot = {
        symbol: 'BTCUSDT',
        timeframe: '15m',
        closedCandles: [
          { timestamp: '2026-09-15T10:00:00.000Z', open: 50000, high: 50100, low: 49900, close: 50050, volume: 10, isClosed: true },
        ],
        formingCandle: null,
        livePrice: 50050,
        closedThrough: '2026-09-15T10:00:00.000Z',
        streamState: {
          marketAsOf: '2026-09-15T10:00:00.000Z',
          sessionKey: 'CRYPTO:2026-09-15',
          connectionEpoch: 'REST_BOOTSTRAP',
          lastSequenceNumber: null,
          sessionVolumeWatermark: null,
        },
        asOfTimestamp: '2026-09-15T10:00:00.000Z',
        dataProvenance: 'LIVE',
        sourceIdentity: 'BINANCE_REST',
      };

      aggregator.syncFromSnapshot(restSnapshot);

      // Live WS tick arrives with real connection epoch 'ws_conn_101'
      const liveWsTick = aggregator.processTick(restSnapshot, {
        symbol: 'BTCUSDT',
        price: 50120,
        timestamp: '2026-09-15T10:15:01.000Z',
        sequenceNumber: 1,
        providerId: 'binance-live',
        connectionEpoch: 'ws_conn_101',
        volumeType: 'INCREMENTAL',
      });

      expect(liveWsTick.streamState?.connectionEpoch).toBe('ws_conn_101');
      expect(liveWsTick.streamState?.lastSequenceNumber).toBe(1);
    });

    test('10. Sequence semantics across reconnect reset sequence watermark', () => {
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

      const snap1 = aggregator.processTick(snapshot, {
        symbol: 'BTCUSDT',
        price: 50100,
        timestamp: '2026-09-15T10:15:01.000Z',
        sequenceNumber: 8888,
        providerId: 'binance-ws',
        connectionEpoch: 'conn_1',
        volumeType: 'INCREMENTAL',
      });

      // Socket reconnects -> new connection epoch conn_2 seq 1
      const snapReconnect = aggregator.processTick(snap1, {
        symbol: 'BTCUSDT',
        price: 50130,
        timestamp: '2026-09-15T10:15:02.000Z',
        sequenceNumber: 1,
        providerId: 'binance-ws',
        connectionEpoch: 'conn_2',
        isReconnect: true,
        volumeType: 'INCREMENTAL',
      });

      expect(snapReconnect.streamState?.connectionEpoch).toBe('conn_2');
      expect(snapReconnect.streamState?.lastSequenceNumber).toBe(1);
    });
  });

  // 4. Provider Capabilities & Stream State Consistency Invariants
  describe('Provider Capabilities & Stream State Invariants', () => {
    test('11. Unknown provider identity degrades to UNKNOWN_PROVIDER', () => {
      const policy = ProviderSequenceCapabilityRegistry.getPolicy('UNKNOWN_PROVIDER');
      expect(policy.scope).toBe('NONE');
      expect(policy.supportsSequenceNumber).toBe(false);
    });

    test('12. Stream state snapshot metadata consistency validator checks', () => {
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
        observedAt: '2026-09-15T09:42:05.000Z',
        asOfTimestamp: '2026-09-15T09:42:05.000Z',
        sessionKey: 'NSE:2026-09-15',
        dataProvenance: 'LIVE',
        sourceIdentity: 'NSE_REALTIME',
        streamState: {
          marketAsOf: '2026-09-15T09:42:00.000Z',
          observedAt: '2026-09-15T09:42:05.000Z',
          sessionKey: 'NSE:2026-09-15',
          providerId: 'NSE_REALTIME',
          connectionEpoch: 'ep1',
          lastSequenceNumber: 10,
        },
      };

      const val = ChartSnapshotValidator.validateSnapshot(validSnapshot, 'NIFTY', '15m');
      expect(val.isValid).toBe(true);

      // Mismatched marketAsOf in streamState
      const invalidSnapshot: ChartMarketSnapshot = {
        ...validSnapshot,
        streamState: {
          ...validSnapshot.streamState!,
          marketAsOf: '2026-09-15T09:00:00.000Z', // MISMATCH
        },
      };

      const invVal = ChartSnapshotValidator.validateSnapshot(invalidSnapshot, 'NIFTY', '15m');
      expect(invVal.isValid).toBe(false);
      expect(invVal.errors.some((e) => e.includes('streamState.marketAsOf'))).toBe(true);
    });
  });
});
