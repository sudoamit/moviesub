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
import { ProviderSequenceCapabilityRegistry } from './provider-sequence-capability';
import { VenueSessionCalendar } from './venue-session-calendar';

/**
 * Canonical Live Candle Aggregator State Machine (Instance Scoped)
 *
 * Guarantees:
 * 1. Capability Policy Resolution & Enforcement: Uses `ProviderSequenceCapabilityRegistry` per provider ID.
 *    - `supportsSequenceNumber === false` -> sequenceNumber is IGNORED and does not affect ordering.
 *    - `supportsSessionVolume === false` -> SESSION_CUMULATIVE volume ticks are rejected.
 * 2. Transactional Watermark Commits: `lastSequenceNumber`, `sessionVolumeWatermark`, and `lastAcceptedEventTimeMs`
 *    are ONLY committed at the very end of processing when the tick successfully passes all validations.
 * 3. Sequence Requires Epoch Invariant: `lastSequenceNumber != null ⇒ connectionEpoch != null`.
 * 4. REST_BOOTSTRAP Non-Reusability State Machine: `REST_BOOTSTRAP` is an origin-only state. Once a live WS epoch
 *    is established, REST_BOOTSTRAP ticks/state are rejected unless `syncFromSnapshot()` explicitly resynchronizes state.
 * 5. Bounded FIFO Idempotency Cache (500 items): Provides secondary duplicate replay protection.
 */
export class CanonicalCandleAggregator {
  private processedTickSignatures = new Set<string>();
  private signatureQueue: string[] = [];
  private readonly maxQueueSize = 500;
  private lastAcceptedEventTimeMs = -1;
  private lastSequenceNumber: number | null = null;
  private sessionVolumeWatermark: number | null = null;
  private connectionEpoch: string | null = null;
  private providerConnectionEpoch: string | null = null;
  private localConnectionInstanceId: string | null = null;
  private providerId = 'UNKNOWN_PROVIDER';
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
    this.connectionEpoch = null;
    this.providerConnectionEpoch = null;
    this.localConnectionInstanceId = null;
    this.providerId = 'UNKNOWN_PROVIDER';
    this.lastSessionKey = '';
    this.currentSymbol = '';
    this.currentTimeframe = '';
  }

  /**
   * Explicitly sets current stream connection epoch.
   */
  setConnectionEpoch(epoch: string | null): void {
    this.connectionEpoch = epoch;
    if (!epoch || epoch === 'REST_BOOTSTRAP') {
      this.lastSequenceNumber = null;
    }
  }

  /**
   * Resets sequence watermark ONLY when a new connection epoch is provided.
   */
  resetSequenceWatermark(epoch?: string, seq?: number): void {
    if (epoch) {
      this.connectionEpoch = epoch;
      this.lastSequenceNumber = seq ?? null;
    } else {
      this.lastSequenceNumber = null;
    }
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
    if (state?.providerId && state.providerId !== 'UNKNOWN_PROVIDER') {
      this.providerId = state.providerId;
    } else if (snapshot.sourceIdentity && snapshot.sourceIdentity !== 'UNKNOWN_SOURCE') {
      this.providerId = snapshot.sourceIdentity;
    } else {
      this.providerId = 'UNKNOWN_PROVIDER';
    }

    this.providerConnectionEpoch = state?.providerConnectionEpoch ?? (state?.connectionEpoch && state.connectionEpoch !== 'REST_BOOTSTRAP' ? state.connectionEpoch : null);
    this.localConnectionInstanceId = state?.localConnectionInstanceId ?? null;
    this.connectionEpoch = state?.connectionEpoch ?? (this.providerConnectionEpoch || this.localConnectionInstanceId || (snapshot.streamState ? 'REST_BOOTSTRAP' : null));

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

    // 4. Restore Session Cumulative Volume Watermark directly from streamState or snapshot (NEVER formingCandle.volume)
    if (state?.sessionVolumeWatermark !== undefined && state.sessionVolumeWatermark !== null) {
      this.sessionVolumeWatermark = state.sessionVolumeWatermark;
    } else if (snapshot.sessionVolumeWatermark !== undefined && snapshot.sessionVolumeWatermark !== null) {
      this.sessionVolumeWatermark = snapshot.sessionVolumeWatermark;
    } else {
      this.sessionVolumeWatermark = null;
    }

    // 5. Restore Sequence Watermark if present on streamState and valid connectionEpoch exists
    if (state?.lastSequenceNumber !== undefined && state.lastSequenceNumber !== null && this.connectionEpoch && this.connectionEpoch !== 'REST_BOOTSTRAP') {
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
    const tickProviderId = (rawTick as ProviderTick).providerId || (tick.providerId) || this.providerId || 'UNKNOWN_PROVIDER';
    const tickEpoch = (rawTick as ProviderTick).connectionEpoch || (tick.connectionEpoch);
    const isReconnect = Boolean((rawTick as ProviderTick).isReconnect || tick.isReconnect);
    const rawSeqNum = (rawTick as ProviderTick).sequenceNumber ?? tick.sequenceNumber;
    const explicitSessionVol = (rawTick as ProviderTick).sessionVolume ?? tick.sessionVolume;

    // Resolve Provider Capability Policy
    const capability = ProviderSequenceCapabilityRegistry.getPolicy(tickProviderId);

    // Reject SESSION_CUMULATIVE tick if provider lacks support or explicit sessionVolume is missing
    if (tick.volumeType === 'SESSION_CUMULATIVE') {
      if (capability.volume.supportsSessionVolume === false || explicitSessionVol === undefined || explicitSessionVol === null) {
        return snapshot;
      }
    }

    // Enforce Sequence Capability: If provider does not support sequence numbers, ignore sequenceNumber completely
    const seqNum = capability.sequence.supportsSequenceNumber ? rawSeqNum : undefined;

    let candidateEpoch = this.connectionEpoch;
    let candidateProviderEpoch = this.providerConnectionEpoch;
    let candidateLocalInstanceId = this.localConnectionInstanceId;
    let candidateSequenceNum = this.lastSequenceNumber;

    // 3. REST_BOOTSTRAP Non-Reusability & Connection Epoch Verification
    if (candidateEpoch !== null && candidateEpoch !== '' && candidateEpoch !== 'REST_BOOTSTRAP') {
      // Aggregator is in LIVE epoch state. Reject ticks attempting to claim REST_BOOTSTRAP without resynchronization!
      if (tickEpoch === 'REST_BOOTSTRAP') {
        return snapshot;
      }
    }

    const rawProviderEpoch = (rawTick as ProviderTick).providerConnectionEpoch || (tick.providerConnectionEpoch) || (tickEpoch && tickEpoch !== 'REST_BOOTSTRAP' ? tickEpoch : null);
    const rawLocalInstanceId = (rawTick as ProviderTick).localConnectionInstanceId || (tick.localConnectionInstanceId) || null;

    if (rawProviderEpoch || rawLocalInstanceId) {
      if (isReconnect || this.connectionEpoch === null || this.connectionEpoch === 'REST_BOOTSTRAP' || this.connectionEpoch === '') {
        candidateProviderEpoch = rawProviderEpoch;
        candidateLocalInstanceId = rawLocalInstanceId;
        candidateEpoch = candidateProviderEpoch || candidateLocalInstanceId;
        candidateSequenceNum = seqNum ?? null;
      } else if (rawProviderEpoch && candidateProviderEpoch && rawProviderEpoch !== candidateProviderEpoch) {
        return snapshot; // Reject tick from mismatched provider connection epoch
      } else {
        if (!candidateProviderEpoch) candidateProviderEpoch = rawProviderEpoch;
        if (!candidateLocalInstanceId) candidateLocalInstanceId = rawLocalInstanceId;
        candidateEpoch = candidateProviderEpoch || candidateLocalInstanceId;
      }
    } else if (this.connectionEpoch === null || this.connectionEpoch === '' || this.connectionEpoch === 'REST_BOOTSTRAP') {
      // Generate a distinct local connection instance ID for the local stream session (never masquerade as provider epoch)
      candidateLocalInstanceId = `local_inst_${tickTimeMs}_${Math.random().toString(36).substring(2, 7)}`;
      candidateProviderEpoch = null;
      candidateEpoch = candidateLocalInstanceId;
      candidateSequenceNum = seqNum ?? null;
    }

    // Sequence Monotonicity & Ordering Validation
    if (isReconnect) {
      candidateSequenceNum = seqNum ?? null;
    } else if (seqNum !== undefined && seqNum !== null) {
      // Sequence requires valid non-REST connectionEpoch invariant
      if (!candidateEpoch || candidateEpoch === 'REST_BOOTSTRAP') {
        return snapshot; // Reject sequence specified without live connectionEpoch
      }

      if (this.lastSequenceNumber !== null && this.connectionEpoch === candidateEpoch && seqNum <= this.lastSequenceNumber) {
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

    // 10. True Session Volume Watermark & Provider Capability Enforcement
    const safeVol = tick.volume ?? 0;
    let candidateSessionVolumeWatermark = this.sessionVolumeWatermark;

    if (isNewSession) {
      // Reset session volume watermark baseline on session key transition
      candidateSessionVolumeWatermark = explicitSessionVol !== undefined ? explicitSessionVol : null;
    }

    let nextForming: ChartFormingCandle;

    if (currentForming && !isRollover) {
      let newVol = currentForming.volume;
      if (tick.volumeType === 'INCREMENTAL') {
        newVol = currentForming.volume + safeVol;
      } else if (tick.volumeType === 'BUCKET_CUMULATIVE') {
        newVol = Math.max(currentForming.volume, safeVol);
      } else if (tick.volumeType === 'SESSION_CUMULATIVE') {
        if (capability.volume.supportsSessionVolume === false) {
          newVol = currentForming.volume;
        } else if (explicitSessionVol === undefined || explicitSessionVol === null) {
          newVol = currentForming.volume;
        } else {
          const baseline = candidateSessionVolumeWatermark;
          if (baseline === null || baseline === undefined || isNewSession) {
            // P0-2 Bootstrap: First live SESSION_CUMULATIVE tick establishes baseline watermark without fabricating a delta
            candidateSessionVolumeWatermark = explicitSessionVol;
            newVol = currentForming.volume;
          } else {
            const delta = Math.max(0, explicitSessionVol - baseline);
            newVol = currentForming.volume + delta;
            candidateSessionVolumeWatermark = explicitSessionVol;
          }
        }
      } else {
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
        if (capability.volume.supportsSessionVolume !== false && explicitSessionVol !== undefined && explicitSessionVol !== null) {
          const baseline = candidateSessionVolumeWatermark;
          if (baseline === null || baseline === undefined || isNewSession) {
            candidateSessionVolumeWatermark = explicitSessionVol;
            initialVol = 0;
          } else {
            initialVol = Math.max(0, explicitSessionVol - baseline);
            candidateSessionVolumeWatermark = explicitSessionVol;
          }
        } else {
          initialVol = 0;
        }
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

    // 11. Construct Candidate Snapshot & Stream State (No Date.now() for marketAsOf)
    const latestEventMs = Math.max(this.lastAcceptedEventTimeMs, tickTimeMs);
    const marketAsOfValue = typeof snapshot.marketAsOf === 'string' || typeof snapshot.latestMarketEventTimestamp === 'string'
      ? new Date(latestEventMs).toISOString()
      : latestEventMs;
    const observationIso = new Date().toISOString();
    const closedThrough =
      closedCandles.length > 0
        ? closedCandles[closedCandles.length - 1].timestamp
        : snapshot.closedThrough;

    const candidateStreamState: CanonicalStreamState = {
      marketAsOf: marketAsOfValue,
      observedAt: observationIso,
      sessionKey,
      providerId: tickProviderId,
      connectionEpoch: candidateEpoch,
      providerConnectionEpoch: candidateProviderEpoch,
      localConnectionInstanceId: candidateLocalInstanceId,
      lastSequenceNumber: candidateSequenceNum,
      sessionVolumeWatermark: candidateSessionVolumeWatermark,
    };

    const nextProvenance = (candidateEpoch && candidateEpoch !== 'REST_BOOTSTRAP') ? 'LIVE' : snapshot.dataProvenance;

    const nextSnapshot: ChartMarketSnapshot = {
      ...snapshot,
      closedCandles,
      formingCandle: nextForming,
      livePrice: nextForming.close,
      closedThrough,
      marketAsOf: marketAsOfValue,
      latestMarketEventTimestamp: marketAsOfValue,
      observedAt: observationIso,
      sessionKey,
      sessionVolumeWatermark: candidateSessionVolumeWatermark,
      streamState: candidateStreamState,
      asOfTimestamp: observationIso,
      sourceIdentity: tickProviderId,
      dataProvenance: nextProvenance,
    };

    // 12. TRANSACTIONAL COMMIT: Only update internal state AFTER tick processing succeeds
    this.providerId = tickProviderId;
    this.connectionEpoch = candidateEpoch;
    this.providerConnectionEpoch = candidateProviderEpoch;
    this.localConnectionInstanceId = candidateLocalInstanceId;
    this.lastSequenceNumber = candidateSequenceNum;
    this.sessionVolumeWatermark = candidateSessionVolumeWatermark;
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
