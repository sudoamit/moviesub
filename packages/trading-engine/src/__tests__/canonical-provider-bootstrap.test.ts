import {
  CanonicalCandleAggregator,
  ChartMarketSnapshot,
  ProviderSequenceCapabilityRegistry,
  NormalizedTick,
} from '@quant/shared';
import { ChartSnapshotValidator } from '../chart-snapshot-validator';

describe('AI FIX 129 — Final Provider Watermark & Stream Bootstrap Suite', () => {
  let aggregator: CanonicalCandleAggregator;

  beforeEach(() => {
    aggregator = new CanonicalCandleAggregator();
  });

  const baseSnapshot: ChartMarketSnapshot = {
    symbol: 'NSE:RELIANCE',
    timeframe: '15m',
    closedCandles: [
      {
        timestamp: 1700000100000,
        open: 2500,
        high: 2510,
        low: 2495,
        close: 2505,
        volume: 1000,
        isClosed: true,
        provenance: 'HISTORICAL',
      },
    ],
    formingCandle: {
      timestamp: 1700001000000, // 22:30 bucket open
      open: 2505,
      high: 2515,
      low: 2500,
      close: 2510,
      volume: 500,
      isClosed: false,
      provenance: 'LIVE',
    },
    livePrice: 2510,
    closedThrough: 1700000100000,
    asOfTimestamp: 1700001000000,
    marketAsOf: 1700001000000,
    observedAt: 1700001005000,
    dataProvenance: 'LIVE',
    sourceIdentity: 'NSE_TRUE_DATA',
    sessionKey: 'NSE:2023-11-15',
    sessionVolumeWatermark: 10000,
    streamState: {
      marketAsOf: 1700001000000,
      observedAt: 1700001005000,
      sessionKey: 'NSE:2023-11-15',
      providerId: 'NSE_TRUE_DATA',
      connectionEpoch: 'ws_conn_1',
      providerConnectionEpoch: 'ws_conn_1',
      localConnectionInstanceId: null,
      lastSequenceNumber: 100,
      sessionVolumeWatermark: 10000,
    },
  };

  test('1. REST bootstrap with real provider event timestamp', () => {
    const snap: ChartMarketSnapshot = {
      ...baseSnapshot,
      marketAsOf: 1700001000000,
      observedAt: 1700005000000,
      isDegraded: false,
      streamState: {
        ...baseSnapshot.streamState!,
        marketAsOf: 1700001000000,
        observedAt: 1700005000000,
      },
    };
    const res = ChartSnapshotValidator.validateSnapshot(snap);
    expect(snap.marketAsOf).toBeDefined();
    expect(snap.isDegraded).toBe(false);
    expect(res.isValid).toBe(true);
  });

  test('2. Unavailable provider event timestamp -> degraded state', () => {
    const degradedSnap: ChartMarketSnapshot = {
      ...baseSnapshot,
      marketAsOf: undefined,
      isDegraded: true,
      streamState: {
        ...baseSnapshot.streamState!,
        marketAsOf: baseSnapshot.observedAt!,
      },
    };
    expect(degradedSnap.isDegraded).toBe(true);
    expect(degradedSnap.marketAsOf).toBeUndefined();
  });

  test('3. Forming bucket timestamp never masquerades as market event timestamp', () => {
    const formingBucketTs = 1700001000000;
    const actualEventTs = 1700001005000;

    const snap: ChartMarketSnapshot = {
      ...baseSnapshot,
      formingCandle: {
        ...baseSnapshot.formingCandle!,
        timestamp: formingBucketTs,
      },
      marketAsOf: actualEventTs,
      observedAt: 1700001010000,
    };

    expect(snap.marketAsOf).not.toBe(snap.formingCandle?.timestamp);
    expect(snap.marketAsOf).toBe(actualEventTs);
  });

  test('4. First SESSION_CUMULATIVE tick with null baseline establishes watermark without fabricating volume delta', () => {
    const snapshotWithNullWatermark: ChartMarketSnapshot = {
      ...baseSnapshot,
      sessionVolumeWatermark: null,
      streamState: {
        ...baseSnapshot.streamState!,
        sessionVolumeWatermark: null,
      },
    };

    aggregator.syncFromSnapshot(snapshotWithNullWatermark);

    const tick1: NormalizedTick = {
      symbol: 'NSE:RELIANCE',
      price: 2512,
      volumeType: 'SESSION_CUMULATIVE',
      sessionVolume: 1000,
      timestamp: 1700001001000,
      providerId: 'NSE_TRUE_DATA',
      connectionEpoch: 'ws_conn_1',
    };

    const snap1 = aggregator.processTick(snapshotWithNullWatermark, tick1);
    expect(snap1.streamState?.sessionVolumeWatermark).toBe(1000);
    // Baseline established, no fake delta fabricated for first tick
    expect(snap1.formingCandle?.volume).toBe(baseSnapshot.formingCandle!.volume);
  });

  test('5. Second SESSION_CUMULATIVE tick calculates volume delta from established watermark', () => {
    const snapshotWithWatermark: ChartMarketSnapshot = {
      ...baseSnapshot,
      sessionVolumeWatermark: 1000,
      streamState: {
        ...baseSnapshot.streamState!,
        sessionVolumeWatermark: 1000,
      },
    };

    aggregator.syncFromSnapshot(snapshotWithWatermark);

    const tick2: NormalizedTick = {
      symbol: 'NSE:RELIANCE',
      price: 2515,
      volumeType: 'SESSION_CUMULATIVE',
      sessionVolume: 1250, // Delta = 250
      timestamp: 1700001002000,
      sequenceNumber: 101,
      providerId: 'NSE_TRUE_DATA',
      connectionEpoch: 'ws_conn_1',
    };

    const snap2 = aggregator.processTick(snapshotWithWatermark, tick2);
    expect(snap2.streamState?.sessionVolumeWatermark).toBe(1250);
    expect(snap2.formingCandle?.volume).toBe(baseSnapshot.formingCandle!.volume + 250);
  });

  test('6. Provider connection epoch vs local connection instance separation', () => {
    const restBootstrapSnapshot: ChartMarketSnapshot = {
      ...baseSnapshot,
      streamState: {
        ...baseSnapshot.streamState!,
        connectionEpoch: 'REST_BOOTSTRAP',
        providerConnectionEpoch: 'REST_BOOTSTRAP',
        localConnectionInstanceId: null,
      },
    };

    aggregator.syncFromSnapshot(restBootstrapSnapshot);

    const tickWithoutEpoch: NormalizedTick = {
      symbol: 'NSE:RELIANCE',
      price: 2512,
      volume: 10,
      volumeType: 'INCREMENTAL',
      timestamp: 1700001001000,
      providerId: 'NSE_TRUE_DATA',
      // providerConnectionEpoch omitted
    };

    const snap = aggregator.processTick(restBootstrapSnapshot, tickWithoutEpoch);
    expect(snap.streamState?.localConnectionInstanceId).toBeDefined();
    expect(snap.streamState?.localConnectionInstanceId).toMatch(/^local_inst_/);
    expect(snap.streamState?.connectionEpoch).not.toBe('NSE_TRUE_DATA_epoch'); // Never generate ${providerId}_epoch
  });

  test('7. Reconnect with same provider-issued sequence numbering', () => {
    aggregator.syncFromSnapshot(baseSnapshot);

    const reconnectTick: NormalizedTick = {
      symbol: 'NSE:RELIANCE',
      price: 2518,
      volume: 5,
      volumeType: 'INCREMENTAL',
      timestamp: 1700001003000,
      sequenceNumber: 1, // Reset sequence on reconnect
      providerId: 'NSE_TRUE_DATA',
      connectionEpoch: 'ws_conn_2', // New provider connection epoch
      isReconnect: true,
    };

    const snap = aggregator.processTick(baseSnapshot, reconnectTick);
    expect(snap.streamState?.connectionEpoch).toBe('ws_conn_2');
    expect(snap.streamState?.lastSequenceNumber).toBe(1);
    expect(snap.livePrice).toBe(2518);
  });

  test('8. Exact provider capability lookup (no substring fuzzy matching)', () => {
    const binanceCaps = ProviderSequenceCapabilityRegistry.getPolicy('BINANCE_REALTIME');
    expect(binanceCaps.providerId).toBe('BINANCE_REALTIME');

    const nseCaps = ProviderSequenceCapabilityRegistry.getPolicy('NSE_TRUE_DATA');
    expect(nseCaps.providerId).toBe('NSE_TRUE_DATA');

    const yahooCaps = ProviderSequenceCapabilityRegistry.getPolicy('YAHOO_FINANCE');
    expect(yahooCaps.providerId).toBe('YAHOO_FINANCE');
  });

  test('9. Unknown provider fail-closed (UNKNOWN_PROVIDER)', () => {
    const unknownCaps = ProviderSequenceCapabilityRegistry.getPolicy('SOME_UNREGISTERED_FEED_XYZ');
    expect(unknownCaps.providerId).toBe('UNKNOWN_PROVIDER');
    expect(unknownCaps.sequence.supportsSequenceNumber).toBe(false);
    expect(unknownCaps.volume.supportsSessionVolume).toBe(false);
    expect(unknownCaps.volume.supportsBucketCumulative).toBe(false);
    expect(unknownCaps.volume.supportsIncremental).toBe(false);
  });

  test('10. streamState vs snapshot strict equality validation', () => {
    const invalidSnap: ChartMarketSnapshot = {
      ...baseSnapshot,
      observedAt: 1700001005000,
      streamState: {
        ...baseSnapshot.streamState!,
        observedAt: 1700001099999, // Mismatch!
      },
    };

    const res = ChartSnapshotValidator.validateSnapshot(invalidSnap);
    expect(res.isValid).toBe(false);
    expect(res.errors.some(e => e.includes('streamState.observedAt'))).toBe(true);
  });

  test('11. Complete timestamp & watermark invariants validation', () => {
    const validRes = ChartSnapshotValidator.validateSnapshot(baseSnapshot);
    expect(validRes.isValid).toBe(true);

    const invalidFormingSnap: ChartMarketSnapshot = {
      ...baseSnapshot,
      formingCandle: {
        ...baseSnapshot.formingCandle!,
        timestamp: 1700002000000,
      },
      marketAsOf: 1700001000000, // marketAsOf < formingCandle.timestamp
    };

    const invalidRes = ChartSnapshotValidator.validateSnapshot(invalidFormingSnap);
    expect(invalidRes.isValid).toBe(false);
    expect(invalidRes.errors.some(e => e.includes('cannot be before formingCandle timestamp'))).toBe(true);
  });
});
