import { TimeframeRegistry } from '../timeframe/timeframe-registry';
import {
  ChartCandle,
  ChartFormingCandle,
  ChartMarketSnapshot,
  NormalizedTick,
} from './chart-snapshot.interface';

/**
 * Canonical Live Candle Aggregator State Machine
 *
 * Implements the single authoritative logic for transforming normalized live market ticks
 * into closed candles and forming candle snapshots.
 *
 * Gap Policy:
 * If ticks skip across one or more timeframe buckets (e.g., 09:30 bucket followed by 10:30 tick on 15m),
 * the aggregator fails closed by omitting missing buckets. Synthetic empty candles with fabricated OHLC
 * values are strictly prohibited.
 */
export class CanonicalCandleAggregator {
  private static lastProcessedTicks = new Map<string, string>();

  /**
   * Clears internal state tracking (useful for unit testing deterministic scenarios).
   */
  static clearState(): void {
    this.lastProcessedTicks.clear();
  }

  /**
   * Processes an incoming normalized live tick and produces the updated ChartMarketSnapshot.
   */
  static processTick(
    snapshot: ChartMarketSnapshot,
    tick: NormalizedTick,
  ): ChartMarketSnapshot {
    if (!snapshot || !tick) return snapshot;

    // 1. Symbol Validation
    if (
      !tick.symbol ||
      snapshot.symbol.toUpperCase() !== tick.symbol.toUpperCase()
    ) {
      return snapshot;
    }

    // 2. Price Validation (Fail-closed on non-finite, NaN, or <= 0 prices)
    if (
      typeof tick.price !== 'number' ||
      isNaN(tick.price) ||
      !isFinite(tick.price) ||
      tick.price <= 0
    ) {
      return snapshot;
    }

    // 3. Timestamp Validation
    const tickTimeMs = new Date(tick.timestamp).getTime();
    if (isNaN(tickTimeMs)) {
      return snapshot;
    }

    // 4. Volume Sanitization
    const rawVol = tick.volume;
    const safeVol =
      typeof rawVol === 'number' && !isNaN(rawVol) && isFinite(rawVol) && rawVol >= 0
        ? rawVol
        : undefined;

    // 5. Stale / Out-of-Order Check against Closed Candles
    let closedCandles = snapshot.closedCandles || [];
    if (closedCandles.length > 0) {
      const lastClosedMs = new Date(
        closedCandles[closedCandles.length - 1].timestamp,
      ).getTime();
      if (tickTimeMs < lastClosedMs) {
        return snapshot; // Ignore tick older than latest closed candle
      }
    }

    // 6. Timeframe Bucket Calculation via TimeframeRegistry (Never new Date())
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

    // 7. Stale / Out-of-Order Check against Current Forming Candle
    if (currentForming && tickTimeMs < currentFormingMs) {
      return snapshot; // Ignore tick older than current forming candle bucket
    }

    // 8. Idempotency & Duplicate Tick Handling
    const tickSig = `${tick.symbol}_${tickTimeMs}_${tick.price}_${tick.volume ?? 'nv'}_${tick.tickId ?? ''}`;
    const stateKey = `${snapshot.symbol}_${snapshot.timeframe}`;
    const lastSig = this.lastProcessedTicks.get(stateKey);

    if (lastSig === tickSig) {
      return snapshot; // Exact duplicate tick re-entry -> no-op
    }

    // 9. Timeframe Rollover Check
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

      // Append to closed candles if not already present
      const alreadyClosed = closedCandles.some(
        (c) =>
          new Date(c.timestamp).getTime() ===
          new Date(closedPrevForming.timestamp).getTime(),
      );
      if (!alreadyClosed) {
        closedCandles = [...closedCandles, closedPrevForming];
      }
    }

    // 10. Forming Candle Assembly / Volume Aggregation
    let nextForming: ChartFormingCandle;

    if (currentForming && !isRollover) {
      // Same candle bucket update
      let newVol = currentForming.volume;
      if (tick.volumeType === 'INCREMENTAL') {
        newVol = currentForming.volume + (safeVol ?? 0);
      } else if (tick.volumeType === 'CUMULATIVE') {
        newVol = Math.max(currentForming.volume, safeVol ?? 0);
      } else {
        // UNKNOWN / missing volumeType: fail-closed, keep volume unchanged
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
        tick.volumeType === 'CUMULATIVE'
      ) {
        initialVol = safeVol ?? 0;
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

    // Record processed tick signature
    this.lastProcessedTicks.set(stateKey, tickSig);

    // 11. Single Live Price Authority
    const livePrice = nextForming.close;

    return {
      ...snapshot,
      closedCandles,
      formingCandle: nextForming,
      livePrice,
    };
  }
}
