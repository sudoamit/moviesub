import { TimeframeRegistry } from '../timeframe/timeframe-registry';
import {
  ChartCandle,
  ChartFormingCandle,
  ChartMarketSnapshot,
  NormalizedTick,
  ProviderTick,
} from './chart-snapshot.interface';
import { normalizeProviderTick } from './provider-tick-normalizer';

/**
 * Canonical Live Candle Aggregator State Machine (Instance Scoped)
 *
 * Encapsulates bounded idempotency, fail-closed out-of-order tick rejection,
 * session cumulative volume delta tracking, and deterministic timeframe rollover.
 */
export class CanonicalCandleAggregator {
  private processedTickSignatures = new Set<string>();
  private signatureQueue: string[] = [];
  private readonly maxQueueSize = 500;
  private lastAcceptedEventTimeMs = -1;
  private lastSessionVolume = -1;

  /**
   * Resets internal aggregator state (useful for symbol switches or fresh streams).
   */
  reset(): void {
    this.processedTickSignatures.clear();
    this.signatureQueue = [];
    this.lastAcceptedEventTimeMs = -1;
    this.lastSessionVolume = -1;
  }

  /**
   * Processes an incoming raw or normalized live tick and produces an updated ChartMarketSnapshot.
   */
  processTick(
    snapshot: ChartMarketSnapshot,
    rawTick: ProviderTick | NormalizedTick | any,
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

    // 3. Stale Tick Check against Closed Candles
    let closedCandles = snapshot.closedCandles || [];
    if (closedCandles.length > 0) {
      const lastClosedMs = new Date(
        closedCandles[closedCandles.length - 1].timestamp,
      ).getTime();
      if (tickTimeMs < lastClosedMs) {
        return snapshot; // Ignore tick older than latest closed candle
      }
    }

    // 4. Timeframe Bucket Calculation via TimeframeRegistry (Never new Date())
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

    // 5. Fail-Closed Out-of-Order Tick Rejection
    if (currentForming && tickTimeMs < currentFormingMs) {
      return snapshot; // Reject tick belonging to a past candle bucket
    }
    if (this.lastAcceptedEventTimeMs > 0 && tickTimeMs < this.lastAcceptedEventTimeMs) {
      return snapshot; // Reject out-of-order tick earlier than latest accepted event
    }

    // 6. Bounded Idempotency Check (A -> B -> A Duplicate Replay Protection)
    const tickSig = `${tick.symbol}_${tickTimeMs}_${tick.price}_${tick.volume ?? 'nv'}_${tick.tickId ?? ''}`;
    if (this.processedTickSignatures.has(tickSig)) {
      return snapshot; // Bounded duplicate tick hit -> no-op
    }

    // Update bounded queue
    this.processedTickSignatures.add(tickSig);
    this.signatureQueue.push(tickSig);
    if (this.signatureQueue.length > this.maxQueueSize) {
      const oldest = this.signatureQueue.shift();
      if (oldest) this.processedTickSignatures.delete(oldest);
    }

    // Record last accepted event timestamp
    this.lastAcceptedEventTimeMs = Math.max(this.lastAcceptedEventTimeMs, tickTimeMs);

    // 7. Timeframe Rollover Transition
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

    // 8. Volume Aggregation & Forming Candle Construction
    let nextForming: ChartFormingCandle;
    const safeVol = tick.volume ?? 0;

    if (currentForming && !isRollover) {
      let newVol = currentForming.volume;
      if (tick.volumeType === 'INCREMENTAL') {
        newVol = currentForming.volume + safeVol;
      } else if (tick.volumeType === 'BUCKET_CUMULATIVE') {
        newVol = Math.max(currentForming.volume, safeVol);
      } else if (tick.volumeType === 'SESSION_CUMULATIVE') {
        const delta =
          this.lastSessionVolume >= 0
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

    // 9. Snapshot Metadata & Live Observation Timestamp Consistency
    const observationIso = new Date(tickTimeMs).toISOString();
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
      asOfTimestamp: observationIso,
    };
  }
}
