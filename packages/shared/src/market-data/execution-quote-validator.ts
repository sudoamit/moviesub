import { MarketDataUnavailableError, StaleMarketDataError } from '../errors';

export const MAX_FUTURE_SKEW_MS = 5000;
export const DEFAULT_MAX_AGE_MS = 5000;

export const CANONICAL_OPTION_QUOTE_SCHEMA = 'CANONICAL_OPTION_QUOTE_V1' as const;
export const CANONICAL_WRITER_ORIGIN = 'CANONICAL_REAL_MARKET_STREAMER' as const;
const CANONICAL_SECRET = 'CANONICAL_INTERNAL_PRODUCER_AUTH_TOKEN_V1';

export function computeCanonicalSignature(
  contractSymbol: string,
  price: number,
  marketEventTime: number,
  connectionEpoch: number,
  providerId: string,
): string {
  let hash = 0x811c9dc5;
  const str = `${contractSymbol}:${price.toFixed(4)}:${marketEventTime}:${connectionEpoch}:${providerId}:${CANONICAL_SECRET}`;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `sig_${(hash >>> 0).toString(16)}`;
}

export interface ICanonicalOptionQuoteRecord {
  schemaVersion: typeof CANONICAL_OPTION_QUOTE_SCHEMA;
  writerOrigin: typeof CANONICAL_WRITER_ORIGIN;
  contractSymbol: string;
  price: number;
  marketEventTime: number;
  observedAt: number;
  receivedAt: number;
  providerId: string;
  connectionEpoch: number;
  provenance: 'LIVE_PROVIDER';
  sequence?: number;
  signatureToken: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  prevClose?: number;
  changePercent?: number;
  changeAmount?: number;
  volatility?: number;
  tickSize?: number;
}

export function createCanonicalOptionQuoteRecord(params: {
  contractSymbol: string;
  price: number;
  marketEventTime: number;
  providerId: string;
  connectionEpoch: number;
  observedAt?: number;
  receivedAt?: number;
  sequence?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  prevClose?: number;
  changePercent?: number;
  changeAmount?: number;
  volatility?: number;
  tickSize?: number;
}): ICanonicalOptionQuoteRecord {
  const now = Date.now();
  const signatureToken = computeCanonicalSignature(
    params.contractSymbol.toUpperCase(),
    params.price,
    params.marketEventTime,
    params.connectionEpoch,
    params.providerId,
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

export type ProviderConnectionState = 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING' | 'RECONNECTED';

export function isProviderExecutionHealthy(
  state?: ProviderConnectionState | string,
  connected?: boolean,
): boolean {
  if (connected === false) return false;
  return state === 'CONNECTED' || state === 'RECONNECTED';
}

export interface ITimestampValidationResult {
  valid: boolean;
  reason?: string;
  errorType?: 'INVALID_EVENT_TIME' | 'FUTURE_SKEW' | 'STALE_QUOTE';
  ageMs?: number;
}

export function validateExecutionQuoteTimestamp(
  marketEventTime: any,
  currentTimeMs = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  maxFutureSkewMs = MAX_FUTURE_SKEW_MS,
): ITimestampValidationResult {
  if (
    marketEventTime === null ||
    marketEventTime === undefined ||
    typeof marketEventTime !== 'number' ||
    !Number.isFinite(marketEventTime) ||
    Number.isNaN(marketEventTime) ||
    marketEventTime <= 0
  ) {
    return {
      valid: false,
      reason: 'Quote timestamp is missing, non-numeric, non-finite, zero, or negative',
      errorType: 'INVALID_EVENT_TIME',
    };
  }

  if (marketEventTime > currentTimeMs + maxFutureSkewMs) {
    return {
      valid: false,
      reason: `Quote timestamp (${marketEventTime}) exceeds maximum future clock skew (${maxFutureSkewMs}ms ahead of ${currentTimeMs})`,
      errorType: 'FUTURE_SKEW',
    };
  }

  const ageMs = currentTimeMs - marketEventTime;
  if (ageMs > maxAgeMs) {
    return {
      valid: false,
      reason: `Quote timestamp is stale (${ageMs}ms old, max allowed: ${maxAgeMs}ms)`,
      errorType: 'STALE_QUOTE',
      ageMs,
    };
  }

  return { valid: true, ageMs };
}

export interface IExecutionQuoteValidationContext {
  expectedSymbol?: string;
  activeConnectionEpoch?: number;
  providerState?: ProviderConnectionState | string;
  isProviderConnected?: boolean;
  maxAgeMs?: number;
  maxFutureSkewMs?: number;
  currentTimeMs?: number;
}

export interface IExecutionQuoteValidationResult {
  valid: boolean;
  reason?: string;
  errorType?:
    | 'INVALID_PRICE'
    | 'SYMBOL_MISMATCH'
    | 'NOT_LIVE_PROVIDER'
    | 'MISSING_PROVIDER_ID'
    | 'INVALID_EVENT_TIME'
    | 'STALE_QUOTE'
    | 'FUTURE_SKEW'
    | 'EPOCH_MISMATCH'
    | 'PROVIDER_DISCONNECTED'
    | 'PROVIDER_RECONNECTING'
    | 'SYNTHETIC_REJECTED';
}

export function validateAuthoritativeExecutionQuote(
  quote: any,
  ctx: IExecutionQuoteValidationContext = {},
): IExecutionQuoteValidationResult {
  if (!quote) {
    return { valid: false, reason: 'Quote object is null or undefined', errorType: 'INVALID_PRICE' };
  }

  if (typeof quote.price !== 'number' || !Number.isFinite(quote.price) || quote.price <= 0) {
    return { valid: false, reason: `Invalid execution price: ${quote.price}`, errorType: 'INVALID_PRICE' };
  }

  if (quote.isSynthetic === true) {
    return { valid: false, reason: 'Synthetic market data rejected for execution', errorType: 'SYNTHETIC_REJECTED' };
  }

  if (ctx.expectedSymbol) {
    const quoteSym = (quote.symbol || quote.contractSymbol || '').toUpperCase();
    if (quoteSym !== ctx.expectedSymbol.toUpperCase()) {
      return {
        valid: false,
        reason: `Symbol mismatch: expected '${ctx.expectedSymbol}', got '${quoteSym}'`,
        errorType: 'SYMBOL_MISMATCH',
      };
    }
  }

  if (ctx.providerState === 'RECONNECTING') {
    return {
      valid: false,
      reason: 'Market data provider is in RECONNECTING state. Trade execution blocked.',
      errorType: 'PROVIDER_RECONNECTING',
    };
  }

  if (
    ctx.providerState === 'DISCONNECTED' ||
    ctx.isProviderConnected === false ||
    (ctx.providerState && !isProviderExecutionHealthy(ctx.providerState, ctx.isProviderConnected))
  ) {
    return {
      valid: false,
      reason: `Market data provider is in '${ctx.providerState || 'DISCONNECTED'}' state. Trade execution blocked.`,
      errorType: 'PROVIDER_DISCONNECTED',
    };
  }

  if (quote.provenance !== 'LIVE_PROVIDER') {
    return {
      valid: false,
      reason: `Quote provenance '${quote.provenance}' is not LIVE_PROVIDER`,
      errorType: 'NOT_LIVE_PROVIDER',
    };
  }

  if (!quote.providerId) {
    return {
      valid: false,
      reason: 'Quote is missing authenticated providerId',
      errorType: 'MISSING_PROVIDER_ID',
    };
  }

  if (ctx.activeConnectionEpoch !== undefined) {
    if (quote.connectionEpoch !== ctx.activeConnectionEpoch) {
      return {
        valid: false,
        reason: `Market quote is from connection epoch ${quote.connectionEpoch ?? 'none'} (active connection epoch: ${ctx.activeConnectionEpoch}). A fresh tick from the active connection is required.`,
        errorType: 'EPOCH_MISMATCH',
      };
    }
  }

  const tsResult = validateExecutionQuoteTimestamp(
    quote.marketEventTime,
    ctx.currentTimeMs,
    ctx.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    ctx.maxFutureSkewMs ?? MAX_FUTURE_SKEW_MS,
  );
  if (!tsResult.valid) {
    return {
      valid: false,
      reason: tsResult.reason,
      errorType: tsResult.errorType,
    };
  }

  return { valid: true };
}

export function parseAndValidateRedisOptionQuote(
  rawJson: string | null | undefined,
  expectedContractSymbol: string,
  activeEpoch: number,
  isStreamerHealthy: boolean,
  currentTimeMs = Date.now(),
): { valid: boolean; quote?: any; reason?: string } {
  if (!rawJson) {
    return { valid: false, reason: 'Redis key is empty or null' };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { valid: false, reason: 'Malformed JSON payload in Redis' };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { valid: false, reason: 'Parsed Redis payload is not an object' };
  }

  // Schema & Writer verification
  if (parsed.schemaVersion !== CANONICAL_OPTION_QUOTE_SCHEMA) {
    return {
      valid: false,
      reason: `Untrusted schemaVersion: '${parsed.schemaVersion}'. Expected '${CANONICAL_OPTION_QUOTE_SCHEMA}'`,
    };
  }
  if (parsed.writerOrigin !== CANONICAL_WRITER_ORIGIN) {
    return {
      valid: false,
      reason: `Untrusted writerOrigin: '${parsed.writerOrigin}'. Expected '${CANONICAL_WRITER_ORIGIN}'`,
    };
  }

  const expectedContract = expectedContractSymbol.toUpperCase();
  const actualContract = (parsed.contractSymbol || parsed.symbol || '').toUpperCase();
  if (actualContract !== expectedContract) {
    return { valid: false, reason: `Contract mismatch: '${actualContract}' vs '${expectedContract}'` };
  }

  if (typeof parsed.price !== 'number' || !Number.isFinite(parsed.price) || parsed.price <= 0) {
    return { valid: false, reason: `Invalid price in Redis payload: ${parsed.price}` };
  }

  // Streamer health check: execution quotes from Redis are valid only while the streamer connection is healthy
  if (!isStreamerHealthy) {
    return { valid: false, reason: 'Underlying market streamer is not in an execution-healthy state' };
  }

  // Connection Epoch check
  if (parsed.connectionEpoch !== activeEpoch) {
    return {
      valid: false,
      reason: `Redis option quote is from obsolete connection epoch ${parsed.connectionEpoch} (active epoch: ${activeEpoch})`,
    };
  }

  // Signature verification to prevent arbitrary/forged Redis JSON elevation
  const expectedSig = computeCanonicalSignature(
    expectedContract,
    parsed.price,
    parsed.marketEventTime,
    parsed.connectionEpoch,
    parsed.providerId,
  );
  if (parsed.signatureToken !== expectedSig) {
    return { valid: false, reason: 'Cryptographic signature mismatch in Redis option quote payload' };
  }

  // Timestamp & Future-Skew Validation
  const tsResult = validateExecutionQuoteTimestamp(parsed.marketEventTime, currentTimeMs);
  if (!tsResult.valid) {
    return { valid: false, reason: tsResult.reason };
  }

  return {
    valid: true,
    quote: {
      symbol: expectedContract,
      price: parsed.price,
      open: parsed.open,
      high: parsed.high,
      low: parsed.low,
      close: parsed.close ?? parsed.price,
      volume: parsed.volume,
      prevClose: parsed.prevClose,
      changePercent: parsed.changePercent,
      changeAmount: parsed.changeAmount,
      volatility: parsed.volatility,
      tickSize: parsed.tickSize,
      lastUpdated: parsed.receivedAt || parsed.observedAt || currentTimeMs,
      provenance: 'LIVE_PROVIDER' as const,
      marketEventTime: parsed.marketEventTime,
      connectionEpoch: parsed.connectionEpoch,
      providerId: parsed.providerId,
    },
  };
}
