import { TimeframeRegistry } from '../timeframe/timeframe-registry';
import {
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
 * Encapsulates:
 * 1. Venue & Exchange Session Calendar Identity (`VenueSessionCalendar`).
 * 2. Monotonic event sequence verification & sequence watermark restoration on reconnect.
 * 3. Latest event watermark tracking (`marketAsOf`) separate from candle bucket open time (`formingCandle.timestamp`).
 * 4. Bounded duplicate tick protection window (500-item FIFO cache) with provider-namespaced IDs.
 * 5. Timeframe rollover transition with explicit `closureType: 'TIME_BOUNDARY_INFERRED'`.
 * 6. Session cumulative volume baseline tracking and reset across session boundaries.
 */
export class CanonicalCandleAggregator {
  private processedTickSignatures = new Set<string>();
  private signatureQueue: string[] = [];
  private readonly maxQueueSize = 500;
  private lastAcceptedEventTimeMs = -1;
  private lastSequenceNumber: number | null = null;
  private lastSessionVolume = -1;
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
    this.lastSessionVolume = -1;
    this.lastSessionKey = '';
    this.currentSymbol = '';
    this.currentTimeframe = '';
  }

  /**
   * Resets sequence watermark (e.g. after socket reconnect or stream failover).
   */
  resetSequenceWatermark(seq?: number): void {
    this.lastSequenceNumber = seq ?? null;
  }

  /**
   * Fully synchronizes internal aggregator watermarks with a fresh authoritative server snapshot
   * (e.g., after REST fetch, socket reconnect, or source failover).
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

    // 1. Restore Latest Event Watermark (marketAsOf)
    if (snapshot.marketAsOf) {
      this.lastAcceptedEventTimeMs = new Date(snapshot.marketAsOf).getTime();
    } else if (snapshot.formingCandle) {
      this.lastAcceptedEventTimeMs = new Date(snapshot.formingCandle.timestamp).getTime();
    } else if (snapshot.closedCandles && snapshot.closedCandles.length > 0) {
      this.lastAcceptedEventTimeMs = new Date(
        snapshot.closedCandles[snapshot.closedCandles.length - 1].timestamp,
      ).getTime();
    }

    // 2. Restore Venue Session Key
    if (snapshot.sessionKey) {
      this.lastSessionKey = snapshot.sessionKey;
    } else if (this.lastAcceptedEventTimeMs > 0) {
      this.lastSessionKey = VenueSessionCalendar.getSessionKey(
        snapshot.symbol,
        this.lastAcceptedEventTimeMs,
      );
    }

    // 3. Restore Session Cumulative Volume Baseline from forming or closed candles
    if (snapshot.formingCandle && snapshot.formingCandle.volumeType === 'SESSION_CUMULATIVE') {
      this.lastSessionVolume = snapshot.formingCandle.volume;
    } else {
      this.lastSessionVolume = -1;
    }

    // 4. Reset sequence watermark on snapshot resync
    this.lastSequenceNumber = null;
  }

  /**
   * Processes an incoming raw or normalized live tick and produces an updated ChartMarketSnapshot.
   * Strictly typed without any `any` parameters.
   */
  processTick(
    snapshot: ChartMarketSnapshot,
    rawTick: ProviderTick | NormalizedTick,
  ): ChartMarketSnapshot {
    if (!snapshot) return snapshot;

    // 1. Strict Provider Tick Normalization & Fail-Closed Validation
    const tick = normalizeProviderTick(rawTick);
    if (!tick) {
      return snapshot; // Reject tick with missing timestamp or invalid price
    }

    // 2. Symbol Match Verification
    if (snapshot.symbol.toUpperCase() !== tick.symbol.toUpperCase()) {
      return snapshot;
    }

    const tickTimeMs = new Date(tick.timestamp).getTime();
    const providerId = (rawTick as ProviderTick).providerId || 'default';
    const isReconnect = Boolean((rawTick as ProviderTick).isReconnect);
    const seqNum = (rawTick as ProviderTick).sequenceNumber;

    // 3. Sequence Monotonicity Verification (where provider supports it)
    if (isReconnect) {
      this.lastSequenceNumber = seqNum ?? null;
    } else if (seqNum !== undefined && seqNum !== null) {
      if (this.lastSequenceNumber !== null && seqNum <= this.lastSequenceNumber) {
        return snapshot; // Reject stale or out-of-order sequence number
      }
      this.lastSequenceNumber = seqNum;
    }

    // 4. Stale Tick Check against Closed Candles
    let closedCandles = snapshot.closedCandles || [];
    if (closedCandles.length > 0) {
      const lastClosedMs = new Date(
        closedCandles[closedCandles.length - 1].timestamp,
      ).getTime();
      if (tickTimeMs < lastClosedMs) {
        return snapshot; // Ignore tick older than latest closed candle
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
      return snapshot; // Reject tick belonging to a past candle bucket
    }
    if (
      this.lastAcceptedEventTimeMs > 0 &&
      tickTimeMs < this.lastAcceptedEventTimeMs
    ) {
      return snapshot; // Reject out-of-order tick earlier than latest accepted event
    }

    // 7. Bounded Window Idempotency Check (500-Item FIFO Cache for Bounded Protection)
    const tickSig = tick.tickId
      ? `${providerId}_${tick.symbol}_id_${tick.tickId}`
      : `${providerId}_${tick.symbol}_sig_${tickTimeMs}_${tick.price}_${tick.volume ?? 'nv'}`;

    if (this.processedTickSignatures.has(tickSig)) {
      return snapshot; // Duplicate tick within bounded window -> no-op
    }

    // Update bounded FIFO queue
    this.processedTickSignatures.add(tickSig);
    this.signatureQueue.push(tickSig);
    if (this.signatureQueue.length > this.maxQueueSize) {
      const oldest = this.signatureQueue.shift();
      if (oldest) this.processedTickSignatures.delete(oldest);
    }

    // Record latest event watermark
    this.lastAcceptedEventTimeMs = Math.max(this.lastAcceptedEventTimeMs, tickTimeMs);

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

    const safeVol = tick.volume ?? 0;
    if (isNewSession) {
      this.lastSessionVolume = safeVol; // Reset cumulative volume baseline for new session
    }

    // 10. Volume Aggregation & Forming Candle Construction
    let nextForming: ChartFormingCandle;

    if (currentForming && !isRollover) {
      let newVol = currentForming.volume;
      if (tick.volumeType === 'INCREMENTAL') {
        newVol = currentForming.volume + safeVol;
      } else if (tick.volumeType === 'BUCKET_CUMULATIVE') {
        newVol = Math.max(currentForming.volume, safeVol);
      } else if (tick.volumeType === 'SESSION_CUMULATIVE') {
        const delta =
          this.lastSessionVolume >= 0 && !isNewSession
            ? Math.max(0, safeVol - this.lastSessionVolume)
            : 0;
        newVol = currentForming.volume + delta;
        this.lastSessionVolume = safeVol;
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
        this.lastSessionVolume = safeVol;
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

    this.lastSessionKey = sessionKey;

    // 11. Metadata, Market Watermark & Observation Timestamps
    const marketAsOfIso = new Date(this.lastAcceptedEventTimeMs).toISOString();
    const observationIso = new Date().toISOString();
    const closedThrough =
      closedCandles.length > 0
        ? closedCandles[closedCandles.length - 1].timestamp
        : snapshot.closedThrough;

    return {
      ...snapshot,
      closedCandles,
      formingCandle: nextForming,
      livePrice: nextForming.close,
      closedThrough,
      marketAsOf: marketAsOfIso,
      sessionKey,
      asOfTimestamp: observationIso,
    };
  }
}
