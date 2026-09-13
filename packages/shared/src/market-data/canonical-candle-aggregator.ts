import { TimeframeRegistry } from '../timeframe/timeframe-registry';
import {
  CanonicalStreamState,
  ChartCandle,
  ChartFormingCandle,
  ChartMarketSnapshot,
  NormalizedTick,
  ProviderTick,
} from './chart-snapshot.interface';
import { normalizeProviderTick } from './provider-tick-normalizer';
import { VenueSessionCalendar } from './venue-session-calendar';

/**
 * Canonical Live Candle Aggregator State Machine (Instance Scoped)
 *
 * Guarantees:
 * 1. Transactional Watermark Commits: `lastSequenceNumber`, `sessionVolumeWatermark`, and `lastAcceptedEventTimeMs`
 *    are ONLY committed at the very end of processing when the tick successfully passes all validations.
 * 2. Reconnect Stream Epoch Boundaries: Sequence identity is scoped as `providerId + connectionEpoch + sequenceNumber`.
 *    Reconnecting establishes a new epoch, resetting sequence watermarks while rejecting stale ticks from older epochs.
 * 3. Canonical Session Volume Watermark: `sessionVolumeWatermark` represents the provider's latest `SESSION_CUMULATIVE` reading.
 *    `syncFromSnapshot()` restores it directly.
 * 4. Venue & Exchange Session Identity: `VenueSessionCalendar` provides deterministic session keys.
 * 5. Bounded FIFO Idempotency Cache (500 items): Provides secondary duplicate replay protection.
 */
export class CanonicalCandleAggregator {
  private processedTickSignatures = new Set<string>();
  private signatureQueue: string[] = [];
  private readonly maxQueueSize = 500;
  private lastAcceptedEventTimeMs = -1;
  private lastSequenceNumber: number | null = null;
  private sessionVolumeWatermark: number | null = null;
  private connectionEpoch = '';
  private providerId = 'default';
  private lastSessionKey = '';
  private currentSymbol = '';
  private currentTimeframe = '';

  /**
   * Resets internal aggregator state (for symbol switches, disconnection, or fresh streams).
   */
  reset(): void {
    this.processedTickSignatures.clear();
    this.signatureQueue = [];
    this.lastAcceptedEventTimeMs = -1;
    this.lastSequenceNumber = null;
    this.sessionVolumeWatermark = null;
    this.connectionEpoch = '';
    this.providerId = 'default';
    this.lastSessionKey = '';
    this.currentSymbol = '';
    this.currentTimeframe = '';
  }

  /**
   * Explicitly sets current stream connection epoch.
   */
  setConnectionEpoch(epoch: string): void {
    this.connectionEpoch = epoch || '';
    this.lastSequenceNumber = null;
  }

  /**
   * Resets sequence watermark (e.g. after socket reconnect or stream failover).
   */
  resetSequenceWatermark(seq?: number): void {
    this.lastSequenceNumber = seq ?? null;
  }

  /**
   * Fully synchronizes internal aggregator watermarks with an authoritative server snapshot.
   */
  syncFromSnapshot(snapshot: ChartMarketSnapshot): void {
    if (!snapshot) return;

    if (
      this.currentSymbol !== snapshot.symbol ||
      this.currentTimeframe !== snapshot.timeframe
    ) {
      this.reset();
      this.currentSymbol = snapshot.symbol;
      this.currentTimeframe = snapshot.timeframe;
    }

    const state = snapshot.streamState;

    // 1. Restore Provider ID & Connection Epoch
    if (state?.providerId) {
      this.providerId = state.providerId;
    }
    if (state?.connectionEpoch) {
      this.connectionEpoch = state.connectionEpoch;
    }

    // 2. Restore Latest Event Watermark (marketAsOf)
    if (state?.marketAsOf) {
      this.lastAcceptedEventTimeMs = new Date(state.marketAsOf).getTime();
    } else if (snapshot.marketAsOf) {
      this.lastAcceptedEventTimeMs = new Date(snapshot.marketAsOf).getTime();
    } else if (snapshot.formingCandle) {
      this.lastAcceptedEventTimeMs = new Date(snapshot.formingCandle.timestamp).getTime();
    } else if (snapshot.closedCandles && snapshot.closedCandles.length > 0) {
      this.lastAcceptedEventTimeMs = new Date(
        snapshot.closedCandles[snapshot.closedCandles.length - 1].timestamp,
      ).getTime();
    }

    // 3. Restore Venue Session Key
    if (state?.sessionKey) {
      this.lastSessionKey = state.sessionKey;
    } else if (snapshot.sessionKey) {
      this.lastSessionKey = snapshot.sessionKey;
    } else if (this.lastAcceptedEventTimeMs > 0) {
      this.lastSessionKey = VenueSessionCalendar.getSessionKey(
        snapshot.symbol,
        this.lastAcceptedEventTimeMs,
      );
    }

    // 4. Restore Session Cumulative Volume Watermark directly
    if (state?.sessionVolumeWatermark !== undefined && state.sessionVolumeWatermark !== null) {
      this.sessionVolumeWatermark = state.sessionVolumeWatermark;
    } else if (snapshot.sessionVolumeWatermark !== undefined && snapshot.sessionVolumeWatermark !== null) {
      this.sessionVolumeWatermark = snapshot.sessionVolumeWatermark;
    } else if (snapshot.formingCandle && snapshot.formingCandle.volumeType === 'SESSION_CUMULATIVE') {
      this.sessionVolumeWatermark = snapshot.formingCandle.volume;
    } else {
      this.sessionVolumeWatermark = null;
    }

    // 5. Restore Sequence Watermark if present on streamState
    if (state?.lastSequenceNumber !== undefined && state.lastSequenceNumber !== null) {
      this.lastSequenceNumber = state.lastSequenceNumber;
    } else {
      this.lastSequenceNumber = null;
    }
  }

  /**
   * Processes an incoming raw or normalized live tick and produces an updated ChartMarketSnapshot.
   * Transactional: If tick processing fails or is rejected at any stage, no watermarks advance.
   */
  processTick(
    snapshot: ChartMarketSnapshot,
    rawTick: ProviderTick | NormalizedTick,
  ): ChartMarketSnapshot {
    if (!snapshot) return snapshot;

    // 1. Normalize Tick (Fail closed on invalid timestamp or non-positive price)
    const tick = normalizeProviderTick(rawTick);
    if (!tick) {
      return snapshot; // Reject invalid tick -> watermarks UNCHANGED
    }

    // 2. Symbol Match Verification
    if (snapshot.symbol.toUpperCase() !== tick.symbol.toUpperCase()) {
      return snapshot; // Reject symbol mismatch -> watermarks UNCHANGED
    }

    const tickTimeMs = new Date(tick.timestamp).getTime();
    const tickProviderId = (rawTick as ProviderTick).providerId || this.providerId || 'default';
    const tickEpoch = (rawTick as ProviderTick).connectionEpoch;
    const isReconnect = Boolean((rawTick as ProviderTick).isReconnect);
    const seqNum = (rawTick as ProviderTick).sequenceNumber;

    let candidateEpoch = this.connectionEpoch;
    let candidateSequenceNum = this.lastSequenceNumber;

    // 3. Connection Epoch & Sequence Monotonicity Verification
    if (tickEpoch && tickEpoch !== this.connectionEpoch) {
      if (isReconnect || this.connectionEpoch === '') {
        // Accept new connection epoch
        candidateEpoch = tickEpoch;
        candidateSequenceNum = seqNum ?? null;
      } else {
        // Reject tick from old / mismatched connection epoch
        return snapshot;
      }
    } else if (isReconnect) {
      candidateSequenceNum = seqNum ?? null;
    } else if (seqNum !== undefined && seqNum !== null) {
      if (candidateSequenceNum !== null && seqNum <= candidateSequenceNum) {
        return snapshot; // Reject stale or out-of-order sequence number -> watermarks UNCHANGED
      }
      candidateSequenceNum = seqNum;
    }

    // 4. Stale Tick Check against Closed Candles
    let closedCandles = snapshot.closedCandles || [];
    if (closedCandles.length > 0) {
      const lastClosedMs = new Date(
        closedCandles[closedCandles.length - 1].timestamp,
      ).getTime();
      if (tickTimeMs < lastClosedMs) {
        return snapshot; // Ignore tick older than latest closed candle -> watermarks UNCHANGED
      }
    }

    // 5. Timeframe Bucket Calculation via TimeframeRegistry (Never new Date())
    const bucketOpenDate = TimeframeRegistry.getBucketOpenTime(
      tick.timestamp,
      snapshot.timeframe,
    );
    const bucketOpenMs = bucketOpenDate.getTime();
    const bucketOpenIso = bucketOpenDate.toISOString();

    const currentForming = snapshot.formingCandle;
    const currentFormingMs = currentForming
      ? new Date(currentForming.timestamp).getTime()
      : -1;

    // 6. Fail-Closed Out-of-Order Tick Rejection
    if (currentForming && tickTimeMs < currentFormingMs) {
      return snapshot; // Reject tick belonging to a past candle bucket -> watermarks UNCHANGED
    }
    if (
      this.lastAcceptedEventTimeMs > 0 &&
      tickTimeMs < this.lastAcceptedEventTimeMs
    ) {
      return snapshot; // Reject out-of-order tick earlier than latest accepted event -> watermarks UNCHANGED
    }

    // 7. Bounded Window Idempotency Check (500-Item FIFO Cache)
    const epochPrefix = candidateEpoch ? `${candidateEpoch}_` : '';
    const tickSig = tick.tickId
      ? `${tickProviderId}_${epochPrefix}${tick.symbol}_id_${tick.tickId}`
      : `${tickProviderId}_${epochPrefix}${tick.symbol}_sig_${tickTimeMs}_${tick.price}_${tick.volume ?? 'nv'}`;

    if (this.processedTickSignatures.has(tickSig)) {
      return snapshot; // Duplicate tick within bounded window -> no-op -> watermarks UNCHANGED
    }

    // 8. Timeframe Rollover Transition with Closure Semantics
    const isRollover = Boolean(currentForming && bucketOpenMs > currentFormingMs);

    if (isRollover && currentForming) {
      const closedPrevForming: ChartCandle = {
        timestamp: currentForming.timestamp,
        open: currentForming.open,
        high: currentForming.high,
        low: currentForming.low,
        close: currentForming.close,
        volume: currentForming.volume,
        isClosed: true as const,
        provenance: currentForming.provenance || snapshot.dataProvenance,
        closureType: 'TIME_BOUNDARY_INFERRED' as const,
      };

      const alreadyClosed = closedCandles.some(
        (c) =>
          new Date(c.timestamp).getTime() ===
          new Date(closedPrevForming.timestamp).getTime(),
      );
      if (!alreadyClosed) {
        closedCandles = [...closedCandles, closedPrevForming];
      }
    }

    // 9. Canonical Exchange Session Identity (`VenueSessionCalendar`)
    const sessionKey = VenueSessionCalendar.getSessionKey(
      snapshot.symbol,
      tick.timestamp,
    );
    const isNewSession = Boolean(
      this.lastSessionKey && this.lastSessionKey !== sessionKey,
    );

    // 10. Explicit Session Volume Watermark Calculation
    const safeVol = tick.volume ?? 0;
    const tickCumVol = (rawTick as ProviderTick).sessionVolume ?? safeVol;
    let candidateSessionVolumeWatermark = this.sessionVolumeWatermark;

    if (isNewSession) {
      candidateSessionVolumeWatermark = tickCumVol; // Reset session cumulative baseline for new session
    }

    let nextForming: ChartFormingCandle;

    if (currentForming && !isRollover) {
      let newVol = currentForming.volume;
      if (tick.volumeType === 'INCREMENTAL') {
        newVol = currentForming.volume + safeVol;
      } else if (tick.volumeType === 'BUCKET_CUMULATIVE') {
        newVol = Math.max(currentForming.volume, safeVol);
      } else if (tick.volumeType === 'SESSION_CUMULATIVE') {
        const baseline = candidateSessionVolumeWatermark;
        const delta =
          baseline !== null && baseline >= 0 && !isNewSession
            ? Math.max(0, tickCumVol - baseline)
            : 0;
        newVol = currentForming.volume + delta;
        candidateSessionVolumeWatermark = tickCumVol;
      } else {
        // UNKNOWN: fail-closed, keep volume unchanged
        newVol = currentForming.volume;
      }

      nextForming = {
        timestamp: currentForming.timestamp,
        open: currentForming.open,
        high: Math.max(currentForming.high, tick.price),
        low: Math.min(currentForming.low, tick.price),
        close: tick.price,
        volume: newVol,
        isClosed: false as const,
        provenance: currentForming.provenance || snapshot.dataProvenance,
        volumeType: tick.volumeType,
      };
    } else {
      // New candle bucket initialization
      let initialVol = 0;
      if (
        tick.volumeType === 'INCREMENTAL' ||
        tick.volumeType === 'BUCKET_CUMULATIVE'
      ) {
        initialVol = safeVol;
      } else if (tick.volumeType === 'SESSION_CUMULATIVE') {
        initialVol = 0;
        candidateSessionVolumeWatermark = tickCumVol;
      }

      nextForming = {
        timestamp: bucketOpenIso,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: initialVol,
        isClosed: false as const,
        provenance: snapshot.dataProvenance,
        volumeType: tick.volumeType,
      };
    }

    // 11. Construct Candidate Snapshot & Stream State
    const marketAsOfIso = new Date(Math.max(this.lastAcceptedEventTimeMs, tickTimeMs)).toISOString();
    const observationIso = new Date().toISOString();
    const closedThrough =
      closedCandles.length > 0
        ? closedCandles[closedCandles.length - 1].timestamp
        : snapshot.closedThrough;

    const candidateStreamState: CanonicalStreamState = {
      marketAsOf: marketAsOfIso,
      sessionKey,
      providerId: tickProviderId,
      connectionEpoch: candidateEpoch,
      lastSequenceNumber: candidateSequenceNum,
      sessionVolumeWatermark: candidateSessionVolumeWatermark,
    };

    const nextSnapshot: ChartMarketSnapshot = {
      ...snapshot,
      closedCandles,
      formingCandle: nextForming,
      livePrice: nextForming.close,
      closedThrough,
      marketAsOf: marketAsOfIso,
      sessionKey,
      sessionVolumeWatermark: candidateSessionVolumeWatermark ?? undefined,
      streamState: candidateStreamState,
      asOfTimestamp: observationIso,
    };

    // 12. TRANSACTIONAL COMMIT: Only update internal state AFTER tick processing succeeds
    this.providerId = tickProviderId;
    this.connectionEpoch = candidateEpoch;
    this.lastSequenceNumber = candidateSequenceNum;
    this.sessionVolumeWatermark = candidateSessionVolumeWatermark;
    this.lastAcceptedEventTimeMs = Math.max(this.lastAcceptedEventTimeMs, tickTimeMs);
    this.lastSessionKey = sessionKey;

    // Update bounded FIFO duplicate cache
    this.processedTickSignatures.add(tickSig);
    this.signatureQueue.push(tickSig);
    if (this.signatureQueue.length > this.maxQueueSize) {
      const oldest = this.signatureQueue.shift();
      if (oldest) this.processedTickSignatures.delete(oldest);
    }

    return nextSnapshot;
  }
}
