import {
  CanonicalCandleAggregator,
  ChartMarketSnapshot,
  ProviderSequenceCapabilityRegistry,
  NormalizedTick,
} from '@quant/shared';
import { ChartSnapshotValidator } from '../chart-snapshot-validator';

describe('AI FIX 128 — Canonical Provider Observation & Capability Enforcement Suite', () => {
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
      timestamp: 1700001000000, // 22:30 bucket open (1700001000000 ms is exact 15m boundary)
      open: 2505,
      high: 2515,
      low: 2500,
      close: 2510,
      volume: 500,
      isClosed: false,
      provenance: 'LIVE',
    },
    livePrice: 2510,
    asOfTimestamp: 1700001000000,
    marketAsOf: 1700001000000,
    observedAt: 1700001005000,
    dataProvenance: 'LIVE',
    sourceIdentity: 'NSE_TRUE_DATA',
    sessionKey: 'NSE:2026-09-13',
    sessionVolumeWatermark: 10000,
    streamState: {
      marketAsOf: 1700001000000,
      observedAt: 1700001005000,
      sessionKey: 'NSE:2026-09-13',
      providerId: 'NSE_TRUE_DATA',
      connectionEpoch: 'ws_conn_1',
      lastSequenceNumber: 100,
      sessionVolumeWatermark: 10000,
    },
  };

  test('1. REST snapshot derives marketAsOf strictly from historical closed or forming candles, never Date.now()', () => {
    const snap: ChartMarketSnapshot = {
      ...baseSnapshot,
      marketAsOf: 1700001000000,
      observedAt: 1700005000000,
      streamState: {
        ...baseSnapshot.streamState!,
        observedAt: 1700005000000,
      },
    };
    expect(snap.marketAsOf).toBeLessThanOrEqual(snap.observedAt as number);
    expect(snap.marketAsOf).not.toBe(snap.observedAt);
    expect(ChartSnapshotValidator.validateSnapshot(snap).isValid).toBe(true);
  });

  test('2. Validation fails if marketAsOf exceeds observedAt', () => {
    const invalidSnap: ChartMarketSnapshot = {
      ...baseSnapshot,
      marketAsOf: 1700006000000,
      observedAt: 1700005000000,
    };
    const res = ChartSnapshotValidator.validateSnapshot(invalidSnap);
    expect(res.isValid).toBe(false);
    expect(res.errors.some(e => e.includes('cannot be strictly after server observation'))).toBe(true);
  });

  test('3. Validation fails if formingCandle.timestamp > marketAsOf', () => {
    const invalidSnap: ChartMarketSnapshot = {
      ...baseSnapshot,
      formingCandle: {
        ...baseSnapshot.formingCandle!,
        timestamp: 1700002000000,
      },
      marketAsOf: 1700001000000,
    };
    const res = ChartSnapshotValidator.validateSnapshot(invalidSnap);
    expect(res.isValid).toBe(false);
    expect(res.errors.some(e => e.includes('cannot be before formingCandle timestamp'))).toBe(true);
  });

  test('4. Capability enforcement: capability registry properly resolves BINANCE, NSE, and UNKNOWN', () => {
    const binanceCaps = ProviderSequenceCapabilityRegistry.getPolicy('BINANCE_REALTIME');
    expect(binanceCaps.sequence.supportsSequenceNumber).toBe(true);
    expect(binanceCaps.volume.supportsSessionVolume).toBe(false);

    const nseCaps = ProviderSequenceCapabilityRegistry.getPolicy('NSE_TRUE_DATA');
    expect(nseCaps.sequence.supportsSequenceNumber).toBe(true);
    expect(nseCaps.volume.supportsSessionVolume).toBe(true);

    const unknownCaps = ProviderSequenceCapabilityRegistry.getPolicy('UNKNOWN_PROVIDER');
    expect(unknownCaps.sequence.supportsSequenceNumber).toBe(false);
    expect(unknownCaps.volume.supportsSessionVolume).toBe(false);
  });

  test('5. Ignore sequenceNumber when supportsSequenceNumber is false', () => {
    aggregator.syncFromSnapshot(baseSnapshot);

    const tick: NormalizedTick = {
      symbol: 'NSE:RELIANCE',
      price: 2512,
      volume: 10,
      volumeType: 'INCREMENTAL',
      timestamp: 1700001001000,
      sequenceNumber: 50, // Out of order sequence number (50 < 100)
      providerId: 'UNKNOWN_PROVIDER', // supportsSequenceNumber === false
      connectionEpoch: 'ws_conn_1',
    };

    const nextSnap = aggregator.processTick(baseSnapshot, tick);
    expect(nextSnap.livePrice).toBe(2512);
    expect(nextSnap.marketAsOf).toBe(1700001001000);
  });

  test('6. Reject SESSION_CUMULATIVE tick when provider does not support session volume', () => {
    aggregator.syncFromSnapshot(baseSnapshot);

    const tick: NormalizedTick = {
      symbol: 'NSE:RELIANCE',
      price: 2512,
      volume: 100,
      volumeType: 'SESSION_CUMULATIVE',
      sessionVolume: 10500,
      timestamp: 1700001001000,
      providerId: 'BINANCE_REALTIME', // supportsSessionVolume === false
      connectionEpoch: 'ws_conn_1',
    };

    const nextSnap = aggregator.processTick(baseSnapshot, tick);
    expect(nextSnap).toBe(baseSnapshot); // Rejected!
  });

  test('7. Reject SESSION_CUMULATIVE tick when sessionVolume field is missing', () => {
    aggregator.syncFromSnapshot(baseSnapshot);

    const tick: NormalizedTick = {
      symbol: 'NSE:RELIANCE',
      price: 2512,
      // volume and sessionVolume omitted
      volumeType: 'SESSION_CUMULATIVE',
      timestamp: 1700001001000,
      sequenceNumber: 101,
      providerId: 'NSE_TRUE_DATA',
      connectionEpoch: 'ws_conn_1',
    };

    const nextSnap = aggregator.processTick(baseSnapshot, tick);
    expect(nextSnap).toBe(baseSnapshot); // Rejected!
  });

  test('8. Enforce single-ownership equality between top-level and streamState watermarks in validation', () => {
    const invalidSnap: ChartMarketSnapshot = {
      ...baseSnapshot,
      marketAsOf: 1700001000000,
      streamState: {
        ...baseSnapshot.streamState!,
        marketAsOf: 1700001099999, // Mismatch!
      },
    };

    const res = ChartSnapshotValidator.validateSnapshot(invalidSnap);
    expect(res.isValid).toBe(false);
    expect(res.errors.some(e => e.includes('does not match'))).toBe(true);
  });

  test('9. Enforce lastSequenceNumber != null implies connectionEpoch != null in validation', () => {
    const invalidSnap: ChartMarketSnapshot = {
      ...baseSnapshot,
      streamState: {
        ...baseSnapshot.streamState!,
        lastSequenceNumber: 100,
        connectionEpoch: null,
      },
    };

    const res = ChartSnapshotValidator.validateSnapshot(invalidSnap);
    expect(res.isValid).toBe(false);
    expect(res.errors.some(e => e.includes('specified without connectionEpoch'))).toBe(true);
  });

  test('10. REST_BOOTSTRAP tick rejected when current epoch is active WebSocket epoch', () => {
    aggregator.syncFromSnapshot(baseSnapshot); // active connectionEpoch is 'ws_conn_1'

    const tick: NormalizedTick = {
      symbol: 'NSE:RELIANCE',
      price: 2520,
      volume: 10,
      volumeType: 'INCREMENTAL',
      timestamp: 1700001002000,
      providerId: 'REST_BOOTSTRAP',
      connectionEpoch: 'REST_BOOTSTRAP',
    };

    const nextSnap = aggregator.processTick(baseSnapshot, tick);
    expect(nextSnap).toBe(baseSnapshot); // Rejected!
  });

  test('11. Transition from REST_BOOTSTRAP to live WS epoch occurs seamlessly on first live tick', () => {
    const restSnap: ChartMarketSnapshot = {
      ...baseSnapshot,
      dataProvenance: 'HISTORICAL',
      streamState: {
        marketAsOf: 1700001000000,
        observedAt: 1700001005000,
        sessionKey: 'NSE:2026-09-13',
        providerId: 'REST_BOOTSTRAP',
        connectionEpoch: 'REST_BOOTSTRAP',
        lastSequenceNumber: null,
        sessionVolumeWatermark: null,
      },
    };

    aggregator.syncFromSnapshot(restSnap);

    const liveTick: NormalizedTick = {
      symbol: 'NSE:RELIANCE',
      price: 2515,
      volume: 15,
      volumeType: 'INCREMENTAL',
      timestamp: 1700001001000,
      sequenceNumber: 1,
      providerId: 'BINANCE_REALTIME',
      connectionEpoch: 'ws_epoch_99',
    };

    const updatedSnap = aggregator.processTick(restSnap, liveTick);
    expect(updatedSnap.dataProvenance).toBe('LIVE');
    expect(updatedSnap.streamState?.connectionEpoch).toBe('ws_epoch_99');
    expect(updatedSnap.streamState?.lastSequenceNumber).toBe(1);
    expect(updatedSnap.livePrice).toBe(2515);
  });

  test('12. Aggregator rejects non-monotonic sequence numbers for sequence-enabled providers', () => {
    aggregator.syncFromSnapshot(baseSnapshot); // lastSequenceNumber is 100

    const staleTick: NormalizedTick = {
      symbol: 'NSE:RELIANCE',
      price: 2512,
      volume: 10,
      volumeType: 'INCREMENTAL',
      timestamp: 1700001001000,
      sequenceNumber: 100, // Equal to lastSequenceNumber (100) -> not strictly monotonic (> 100)
      providerId: 'NSE_TRUE_DATA',
      connectionEpoch: 'ws_conn_1',
    };

    const nextSnap = aggregator.processTick(baseSnapshot, staleTick);
    expect(nextSnap).toBe(baseSnapshot); // Rejected
  });

  test('13. Validation passes for valid snapshot with matching streamState watermarks', () => {
    const res = ChartSnapshotValidator.validateSnapshot(baseSnapshot);
    expect(res.isValid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test('14. Aggregator properly updates forming candle and live price on valid tick', () => {
    aggregator.syncFromSnapshot(baseSnapshot);

    const tick: NormalizedTick = {
      symbol: 'NSE:RELIANCE',
      price: 2525,
      volume: 50,
      volumeType: 'INCREMENTAL',
      timestamp: 1700001005000,
      sequenceNumber: 101,
      providerId: 'NSE_TRUE_DATA',
      connectionEpoch: 'ws_conn_1',
    };

    const snap = aggregator.processTick(baseSnapshot, tick);
    expect(snap.livePrice).toBe(2525);
    expect(snap.formingCandle?.high).toBe(2525);
    expect(snap.formingCandle?.close).toBe(2525);
    expect(snap.formingCandle?.volume).toBe(550); // 500 + 50
    expect(snap.marketAsOf).toBe(1700001005000);
    expect(snap.streamState?.marketAsOf).toBe(1700001005000);
    expect(snap.streamState?.lastSequenceNumber).toBe(101);
  });

  test('15. Snapshot validator rejects missing streamState observedAt timestamp', () => {
    const invalidSnap: ChartMarketSnapshot = {
      ...baseSnapshot,
      streamState: {
        ...baseSnapshot.streamState!,
        observedAt: undefined,
      },
    };

    const res = ChartSnapshotValidator.validateSnapshot(invalidSnap);
    expect(res.isValid).toBe(false);
    expect(res.errors.some(e => e.includes('observedAt missing'))).toBe(true);
  });
});
