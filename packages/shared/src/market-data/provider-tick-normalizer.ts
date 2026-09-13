import { NormalizedTick, ProviderTick, TickVolumeType } from './chart-snapshot.interface';

/**
 * Normalizes raw market feed ticks into a canonical NormalizedTick object.
 *
 * Strict Fail-Closed Policy:
 * 1. Missing or invalid timestamp -> returns null (REJECTS tick, never synthesizes wall-clock time).
 * 2. Non-finite or <= 0 price -> returns null (REJECTS tick).
 * 3. Missing symbol -> returns null.
 */
export function normalizeProviderTick(raw: ProviderTick | NormalizedTick): NormalizedTick | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  // 1. Symbol Extraction & Normalization
  const symbol = typeof raw.symbol === 'string' ? raw.symbol.toUpperCase().trim() : '';
  if (!symbol) {
    return null;
  }

  // 2. Price Validation (Must be finite number > 0)
  const price = Number(raw.price);
  if (isNaN(price) || !isFinite(price) || price <= 0) {
    return null;
  }

  // 3. Fail-Closed Timestamp Check (Strictly NO new Date() synthesis)
  if (raw.timestamp === undefined || raw.timestamp === null || raw.timestamp === '') {
    return null;
  }
  const timeMs = new Date(raw.timestamp).getTime();
  if (isNaN(timeMs)) {
    return null;
  }

  // 4. Volume Normalization
  const rawVol = Number(raw.volume);
  const safeVol =
    typeof rawVol === 'number' && !isNaN(rawVol) && isFinite(rawVol) && rawVol >= 0
      ? rawVol
      : undefined;

  const rawSessVol = Number(raw.sessionVolume);
  const safeSessionVol =
    typeof rawSessVol === 'number' && !isNaN(rawSessVol) && isFinite(rawSessVol) && rawSessVol >= 0
      ? rawSessVol
      : undefined;

  // 5. Volume Semantics Resolution
  let volumeType: TickVolumeType = 'UNKNOWN';
  const rawVolType = raw.volumeType as string | undefined;
  if (
    rawVolType === 'INCREMENTAL' ||
    rawVolType === 'BUCKET_CUMULATIVE' ||
    rawVolType === 'SESSION_CUMULATIVE'
  ) {
    volumeType = rawVolType as TickVolumeType;
  } else if (rawVolType === 'CUMULATIVE') {
    // Backwards compatibility alias for BUCKET_CUMULATIVE
    volumeType = 'BUCKET_CUMULATIVE';
  }

  return {
    symbol,
    price,
    timestamp: raw.timestamp,
    volume: safeVol,
    volumeType,
    tickId: raw.tickId ? String(raw.tickId) : undefined,
    sequenceNumber: raw.sequenceNumber,
    providerId: raw.providerId,
    connectionEpoch: raw.connectionEpoch,
    sessionVolume: safeSessionVol,
    isReconnect: raw.isReconnect,
  };
}
