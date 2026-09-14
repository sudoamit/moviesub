import {
  CANONICAL_OPTION_QUOTE_SCHEMA,
  CANONICAL_WRITER_ORIGIN,
  CanonicalProviderTransport,
  ICanonicalOptionQuoteRecord,
  computeCanonicalSignature,
} from '../execution-quote-validator';
import {
  isValidatedCanonicalOptionProviderTick,
  validateCanonicalProviderTickInput,
  ValidatedCanonicalOptionProviderTick,
} from './canonical-option-provider-tick';

/**
 * AI FIX 156 — Canonical Redis record layer.
 *
 * The canonical Redis record is the ONLY representation of an option quote that may be
 * written to `option:ltp:*`. It is derived exclusively from a branded
 * ValidatedCanonicalOptionProviderTick and carries an HMAC over exactly:
 *   providerId, providerInstanceId, providerConnectionId, providerTransport,
 *   connectionEpoch, contractSymbol, price, marketEventTime
 * so tampering with any of these fields invalidates the signature.
 */
export function createCanonicalOptionQuoteRecord(
  providerTick: ValidatedCanonicalOptionProviderTick,
): ICanonicalOptionQuoteRecord {
  if (!isValidatedCanonicalOptionProviderTick(providerTick)) {
    throw new Error('Canonical option quote requires a validated provider-origin tick');
  }

  const params = providerTick.toRecordInput();
  validateCanonicalProviderTickInput(params);
  const now = Date.now();

  const signatureToken = computeCanonicalSignature(
    params.contractSymbol.toUpperCase(),
    params.price,
    params.marketEventTime,
    params.connectionEpoch,
    params.providerId,
    params.providerInstanceId,
    params.providerConnectionId,
    params.providerTransport,
  );

  return {
    schemaVersion: CANONICAL_OPTION_QUOTE_SCHEMA,
    writerOrigin: CANONICAL_WRITER_ORIGIN,
    contractSymbol: params.contractSymbol.toUpperCase(),
    price: params.price,
    marketEventTime: params.marketEventTime,
    observedAt: params.observedAt ?? now,
    receivedAt: params.receivedAt ?? now,
    providerId: params.providerId,
    connectionEpoch: params.connectionEpoch,
    providerInstanceId: params.providerInstanceId,
    providerConnectionId: params.providerConnectionId,
    providerTransport: params.providerTransport as CanonicalProviderTransport,
    provenance: 'LIVE_PROVIDER',
    sequence: params.sequence,
    signatureToken,
    open: params.open,
    high: params.high,
    low: params.low,
    close: params.close,
    volume: params.volume,
    prevClose: params.prevClose,
    changePercent: params.changePercent,
    changeAmount: params.changeAmount,
    volatility: params.volatility,
    tickSize: params.tickSize,
  };
}
