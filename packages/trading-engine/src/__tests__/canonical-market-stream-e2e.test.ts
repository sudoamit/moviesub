import {
  CanonicalCandleAggregator,
  ChartMarketSnapshot,
  ProviderIdentityNormalizer,
  ProviderSequenceCapabilityRegistry,
  VenueSessionCalendar,
} from '@quant/shared';
import { ChartSnapshotValidator } from '../chart-snapshot-validator';

describe('AI FIX 132 — Final Canonical Market-Stream Verification Suite', () => {
  let aggregator: CanonicalCandleAggregator;

  beforeEach(() => {
    ProviderSequenceCapabilityRegistry.resetRegistryForTesting();
    aggregator = new CanonicalCandleAggregator();
  });

  afterEach(() => {
    ProviderSequenceCapabilityRegistry.resetRegistryForTesting();
  });

  // P0-1: End-to-End Trace of Genuine Provider Market Event Watermark
  describe('P0-1 End-to-End Real Market Event Timestamp Trace', () => {
    test('Genuine provider event timestamp propagates to marketAsOf; missing event time sets isDegraded=true', () => {
      const providerEventMs = new Date('2026-09-15T10:15:01.000Z').getTime();
      const observationTimeIso = '2026-09-15T10:15:05.000Z';

      const validSnapshot: ChartMarketSnapshot = {
        symbol: 'NSE:RELIANCE',
        timeframe: '15m',
        closedCandles: [
          { timestamp: '2026-09-15T10:00:00.000Z', open: 2500, high: 2510, low: 2490, close: 2505, volume: 100, isClosed: true },
        ],
        formingCandle: {
          timestamp: '2026-09-15T10:15:00.000Z',
          open: 2505,
          high: 2515,
          low: 2500,
          close: 2512,
          volume: 50,
          isClosed: false,
        },
        livePrice: 2512,
        asOfTimestamp: observationTimeIso,
        marketAsOf: new Date(providerEventMs).toISOString(),
        observedAt: observationTimeIso,
        dataProvenance: 'LIVE',
        sourceIdentity: 'NSE_TRUE_DATA',
        sessionKey: 'NSE:2026-09-15',
        sessionVolumeWatermark: 10500,
        streamState: {
          marketAsOf: new Date(providerEventMs).toISOString(),
          observedAt: observationTimeIso,
          sessionKey: 'NSE:2026-09-15',
          providerId: 'NSE_TRUE_DATA',
          providerConnectionEpoch: 'ws_conn_1',
          lastSequenceNumber: 100,
          sessionVolumeWatermark: 10500,
        },
      };

      const valResult = ChartSnapshotValidator.validateSnapshot(validSnapshot, 'NSE:RELIANCE', '15m');
      expect(valResult.isValid).toBe(true);

      // Degraded snapshot without marketAsOf MUST have isDegraded === true
      const degradedSnapshot: ChartMarketSnapshot = {
        ...validSnapshot,
        marketAsOf: undefined,
        isDegraded: true,
        streamState: {
          ...validSnapshot.streamState!,
          marketAsOf: undefined,
        },
      };
      const degResult = ChartSnapshotValidator.validateSnapshot(degradedSnapshot, 'NSE:RELIANCE', '15m');
      expect(degResult.isValid).toBe(true);

      // Validation fails if marketAsOf is missing without isDegraded = true
      const invalidDegradedSnapshot: ChartMarketSnapshot = {
        ...validSnapshot,
        marketAsOf: undefined,
        isDegraded: false,
        streamState: {
          ...validSnapshot.streamState!,
          marketAsOf: undefined,
        },
      };
      const invResult = ChartSnapshotValidator.validateSnapshot(invalidDegradedSnapshot, 'NSE:RELIANCE', '15m');
      expect(invResult.isValid).toBe(false);
      expect(invResult.errors.some((e) => e.includes('must explicitly have isDegraded = true'))).toBe(true);
    });
  });

  // P0-2: Stream Lifecycle API Authority
  describe('P0-2 Stream Lifecycle API Authority', () => {
    test('onStreamConnected and onStreamReconnected atomically update epochs and sequence state', () => {
      aggregator.onStreamConnected({
        providerConnectionEpoch: 'epoch_alpha',
        localConnectionInstanceId: 'local_inst_1',
      });

      expect(aggregator.connectionEpoch).toBe('epoch_alpha');

      const snap1 = aggregator.processTick(
        {
          symbol: 'BTCUSDT',
          timeframe: '15m',
          closedCandles: [],
          formingCandle: null,
          livePrice: 50000,
          asOfTimestamp: '2026-09-15T10:00:00.000Z',
          dataProvenance: 'LIVE',
          sourceIdentity: 'BINANCE_REALTIME',
        },
        {
          symbol: 'BTCUSDT',
          price: 50100,
          timestamp: '2026-09-15T10:00:01.000Z',
          sequenceNumber: 500,
          providerId: 'BINANCE_REALTIME',
          providerConnectionEpoch: 'epoch_alpha',
          volumeType: 'INCREMENTAL',
        },
      );

      expect(snap1.streamState?.lastSequenceNumber).toBe(500);

      // Reconnect lifecycle event resets sequence watermark atomically
      aggregator.onStreamReconnected({
        providerConnectionEpoch: 'epoch_beta',
      });

      expect(aggregator.connectionEpoch).toBe('epoch_beta');

      const snap2 = aggregator.processTick(snap1, {
        symbol: 'BTCUSDT',
        price: 50150,
        timestamp: '2026-09-15T10:00:02.000Z',
        sequenceNumber: 1, // Sequence restarted on new connection epoch
        providerId: 'BINANCE_REALTIME',
        providerConnectionEpoch: 'epoch_beta',
        volumeType: 'INCREMENTAL',
      });

      expect(snap2.streamState?.connectionEpoch).toBe('epoch_beta');
      expect(snap2.streamState?.lastSequenceNumber).toBe(1);
    });
  });

  // P0-3 & P0-4: Unified Registry Lock & Test Isolation
  describe('P0-3 & P0-4 Registry Shared Lock & Test Isolation', () => {
    test('lockRegistry prevents alias and capability mutations; resetRegistryForTesting resets state', () => {
      ProviderSequenceCapabilityRegistry.registerCapabilities({
        providerId: 'CUSTOM_TEST_FEED',
        sequence: { scope: 'CONNECTION_SCOPED', resetOnReconnect: true, supportsSequenceNumber: true },
        volume: { supportsSessionVolume: true, supportsBucketCumulative: true, supportsIncremental: true },
        session: { isContinuous247: true, requiresVenueCalendar: false },
      });

      expect(ProviderIdentityNormalizer.toCanonicalId('CUSTOM_TEST_FEED')).toBe('CUSTOM_TEST_FEED');

      // Lock registry
      ProviderSequenceCapabilityRegistry.lockRegistry();
      expect(ProviderSequenceCapabilityRegistry.getIsLocked()).toBe(true);

      // Mutation while locked must throw error
      expect(() => {
        ProviderSequenceCapabilityRegistry.registerCapabilities({
          providerId: 'ANOTHER_FEED',
          sequence: { scope: 'NONE', resetOnReconnect: true, supportsSequenceNumber: false },
          volume: { supportsSessionVolume: false, supportsBucketCumulative: true, supportsIncremental: false },
          session: { isContinuous247: true, requiresVenueCalendar: false },
        });
      }).toThrow('locked');

      expect(() => {
        ProviderIdentityNormalizer.registerAlias('ALIAS_TEST', 'BINANCE_REALTIME');
      }).toThrow('locked');

      // Test reset unlocks and resets state
      ProviderSequenceCapabilityRegistry.resetRegistryForTesting();
      expect(ProviderSequenceCapabilityRegistry.getIsLocked()).toBe(false);
      expect(ProviderIdentityNormalizer.toCanonicalId('CUSTOM_TEST_FEED')).toBe('UNKNOWN_PROVIDER');
    });
  });

  // P1-6: Complete Sequence Scope Policies
  describe('P1-6 Complete Sequence Scope Enforcement', () => {
    test('CONNECTION_SCOPED accepts sequence reset across connection epoch transition', () => {
      ProviderSequenceCapabilityRegistry.registerCapabilities({
        providerId: 'CONN_FEED',
        sequence: { scope: 'CONNECTION_SCOPED', resetOnReconnect: true, supportsSequenceNumber: true },
        volume: { supportsSessionVolume: false, supportsBucketCumulative: true, supportsIncremental: true },
        session: { isContinuous247: true, requiresVenueCalendar: false },
      });

      aggregator.onStreamConnected({ providerConnectionEpoch: 'conn_1' });

      const baseSnap: ChartMarketSnapshot = {
        symbol: 'BTCUSDT',
        timeframe: '15m',
        closedCandles: [],
        formingCandle: null,
        livePrice: 50000,
        asOfTimestamp: '2026-09-15T10:00:00.000Z',
        dataProvenance: 'LIVE',
        sourceIdentity: 'CONN_FEED',
      };

      const snap1 = aggregator.processTick(baseSnap, {
        symbol: 'BTCUSDT',
        price: 50100,
        timestamp: '2026-09-15T10:00:01.000Z',
        sequenceNumber: 100,
        providerId: 'CONN_FEED',
        providerConnectionEpoch: 'conn_1',
        volumeType: 'INCREMENTAL',
      });
      expect(snap1.streamState?.lastSequenceNumber).toBe(100);

      // Same epoch lower sequence number -> REJECTED
      const snapStale = aggregator.processTick(snap1, {
        symbol: 'BTCUSDT',
        price: 50110,
        timestamp: '2026-09-15T10:00:02.000Z',
        sequenceNumber: 99,
        providerId: 'CONN_FEED',
        providerConnectionEpoch: 'conn_1',
        volumeType: 'INCREMENTAL',
      });
      expect(snapStale).toBe(snap1);

      // Connection epoch transition -> seq 1 ACCEPTED
      aggregator.onStreamReconnected({ providerConnectionEpoch: 'conn_2' });
      const snapNewEpoch = aggregator.processTick(snap1, {
        symbol: 'BTCUSDT',
        price: 50120,
        timestamp: '2026-09-15T10:00:03.000Z',
        sequenceNumber: 1,
        providerId: 'CONN_FEED',
        providerConnectionEpoch: 'conn_2',
        volumeType: 'INCREMENTAL',
      });
      expect(snapNewEpoch.streamState?.lastSequenceNumber).toBe(1);
    });

    test('GLOBALLY_MONOTONIC strictly enforces sequence monotonicity regardless of epoch or provider', () => {
      ProviderSequenceCapabilityRegistry.registerCapabilities({
        providerId: 'GLOBAL_FEED',
        sequence: { scope: 'GLOBALLY_MONOTONIC', resetOnReconnect: false, supportsSequenceNumber: true },
        volume: { supportsSessionVolume: false, supportsBucketCumulative: true, supportsIncremental: true },
        session: { isContinuous247: true, requiresVenueCalendar: false },
      });

      aggregator.onStreamConnected({ providerConnectionEpoch: 'conn_1' });

      const baseSnap: ChartMarketSnapshot = {
        symbol: 'BTCUSDT',
        timeframe: '15m',
        closedCandles: [],
        formingCandle: null,
        livePrice: 50000,
        asOfTimestamp: '2026-09-15T10:00:00.000Z',
        dataProvenance: 'LIVE',
        sourceIdentity: 'GLOBAL_FEED',
      };

      const snap1 = aggregator.processTick(baseSnap, {
        symbol: 'BTCUSDT',
        price: 50100,
        timestamp: '2026-09-15T10:00:01.000Z',
        sequenceNumber: 500,
        providerId: 'GLOBAL_FEED',
        providerConnectionEpoch: 'conn_1',
        volumeType: 'INCREMENTAL',
      });
      expect(snap1.streamState?.lastSequenceNumber).toBe(500);

      // Epoch change under GLOBALLY_MONOTONIC still rejects lower sequence number 499
      aggregator.onStreamConnected({ providerConnectionEpoch: 'conn_2' });
      const snapStale = aggregator.processTick(snap1, {
        symbol: 'BTCUSDT',
        price: 50110,
        timestamp: '2026-09-15T10:00:02.000Z',
        sequenceNumber: 499,
        providerId: 'GLOBAL_FEED',
        providerConnectionEpoch: 'conn_2',
        volumeType: 'INCREMENTAL',
      });
      expect(snapStale).toBe(snap1);

      // Higher sequence 501 ACCEPTED
      const snapValid = aggregator.processTick(snap1, {
        symbol: 'BTCUSDT',
        price: 50120,
        timestamp: '2026-09-15T10:00:03.000Z',
        sequenceNumber: 501,
        providerId: 'GLOBAL_FEED',
        providerConnectionEpoch: 'conn_2',
        volumeType: 'INCREMENTAL',
      });
      expect(snapValid.streamState?.lastSequenceNumber).toBe(501);
    });

    test('NONE scope completely ignores sequence number', () => {
      ProviderSequenceCapabilityRegistry.registerCapabilities({
        providerId: 'NONE_FEED',
        sequence: { scope: 'NONE', resetOnReconnect: true, supportsSequenceNumber: false },
        volume: { supportsSessionVolume: false, supportsBucketCumulative: true, supportsIncremental: true },
        session: { isContinuous247: true, requiresVenueCalendar: false },
      });

      const baseSnap: ChartMarketSnapshot = {
        symbol: 'BTCUSDT',
        timeframe: '15m',
        closedCandles: [],
        formingCandle: null,
        livePrice: 50000,
        asOfTimestamp: '2026-09-15T10:00:00.000Z',
        dataProvenance: 'LIVE',
        sourceIdentity: 'NONE_FEED',
      };

      const snap1 = aggregator.processTick(baseSnap, {
        symbol: 'BTCUSDT',
        price: 50100,
        timestamp: '2026-09-15T10:00:01.000Z',
        sequenceNumber: 100,
        providerId: 'NONE_FEED',
        volumeType: 'INCREMENTAL',
      });
      expect(snap1.livePrice).toBe(50100);
      expect(snap1.streamState?.lastSequenceNumber).toBeNull();

      const snap2 = aggregator.processTick(snap1, {
        symbol: 'BTCUSDT',
        price: 50110,
        timestamp: '2026-09-15T10:00:02.000Z',
        sequenceNumber: 50, // Lower sequence number ignored under NONE scope
        providerId: 'NONE_FEED',
        volumeType: 'INCREMENTAL',
      });
      expect(snap2.livePrice).toBe(50110);
    });
  });

  // P1-8: Full End-to-End Live Tick Pipeline Integration
  describe('P1-8 End-to-End Live Tick Pipeline Integration', () => {
    test('Raw tick flows through normalizer -> aggregator -> forming candle -> streamState -> validator without synthetic values', () => {
      aggregator.onStreamConnected({ providerConnectionEpoch: 'e2e_epoch_1' });

      const initialSnapshot: ChartMarketSnapshot = {
        symbol: 'NSE:RELIANCE',
        timeframe: '15m',
        closedCandles: [
          { timestamp: '2026-09-13T09:15:00.000Z', open: 2500, high: 2510, low: 2490, close: 2505, volume: 100, isClosed: true },
        ],
        formingCandle: null,
        livePrice: 2505,
        closedThrough: '2026-09-13T09:15:00.000Z',
        asOfTimestamp: '2026-09-13T09:30:00.000Z',
        marketAsOf: '2026-09-13T09:15:00.000Z',
        observedAt: '2026-09-13T09:30:00.000Z',
        dataProvenance: 'LIVE',
        sourceIdentity: 'NSE_TRUE_DATA',
        sessionKey: 'NSE:2026-09-13',
        sessionVolumeWatermark: 10000,
        streamState: {
          marketAsOf: '2026-09-13T09:15:00.000Z',
          observedAt: '2026-09-13T09:30:00.000Z',
          sessionKey: 'NSE:2026-09-13',
          providerId: 'NSE_TRUE_DATA',
          providerConnectionEpoch: 'e2e_epoch_1',
          lastSequenceNumber: 1,
          sessionVolumeWatermark: 10000,
        },
      };

      const rawTick = {
        symbol: 'NSE:RELIANCE',
        price: 2515,
        timestamp: '2026-09-13T09:30:15.000Z',
        volume: 25,
        volumeType: 'INCREMENTAL' as const,
        sequenceNumber: 2,
        providerId: 'NSE_TRUE_DATA',
        providerConnectionEpoch: 'e2e_epoch_1',
      };

      const updatedSnapshot = aggregator.processTick(initialSnapshot, rawTick);

      // Verify forming candle OHLCV derived strictly from real tick
      expect(updatedSnapshot.formingCandle).not.toBeNull();
      expect(updatedSnapshot.formingCandle?.timestamp).toBe('2026-09-13T09:30:00.000Z');
      expect(updatedSnapshot.formingCandle?.open).toBe(2515);
      expect(updatedSnapshot.formingCandle?.high).toBe(2515);
      expect(updatedSnapshot.formingCandle?.low).toBe(2515);
      expect(updatedSnapshot.formingCandle?.close).toBe(2515);
      expect(updatedSnapshot.formingCandle?.volume).toBe(25);

      // Verify single ownership of marketAsOf and observedAt
      expect(updatedSnapshot.marketAsOf).toBe('2026-09-13T09:30:15.000Z');
      expect(updatedSnapshot.streamState?.marketAsOf).toBe('2026-09-13T09:30:15.000Z');

      // Verify full validator checks pass
      const validation = ChartSnapshotValidator.validateSnapshot(updatedSnapshot, 'NSE:RELIANCE', '15m');
      expect(validation.isValid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });
  });
});
