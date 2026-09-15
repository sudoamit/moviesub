import * as crypto from 'crypto';
import { MarketDataUnavailableError, StaleMarketDataError } from '../errors';

export const MAX_FUTURE_SKEW_MS = 5000;
export const DEFAULT_MAX_AGE_MS = 5000;

export const CANONICAL_OPTION_QUOTE_SCHEMA = 'CANONICAL_OPTION_QUOTE_V1' as const;
export const CANONICAL_WRITER_ORIGIN = 'CANONICAL_REAL_MARKET_STREAMER' as const;
export type CanonicalProviderTransport = 'WEBSOCKET_STREAM' | 'REST_POLLING';

let canonicalSigningSecret: string | null = null;

export function setCanonicalSigningSecret(secret: string): void {
  if (!secret || secret.trim().length === 0) {
    throw new Error('Canonical signing secret cannot be empty');
  }
  canonicalSigningSecret = secret.trim();
}

export function resetCanonicalSigningSecretForTests(): void {
  canonicalSigningSecret = null;
}

export function getCanonicalSigningSecret(): string {
  if (canonicalSigningSecret) {
    return canonicalSigningSecret;
  }
  const envSecret = process.env.CANONICAL_OPTION_QUOTE_SECRET;
  if (envSecret && envSecret.trim().length > 0) {
    return envSecret.trim();
  }
  throw new Error(
    '[CANONICAL_SECRET_UNCONFIGURED] Runtime canonical signing secret must be configured via environment variable (CANONICAL_OPTION_QUOTE_SECRET) or setCanonicalSigningSecret(). Hardcoded secrets in source code are strictly prohibited.',
  );
}

/**
 * HMAC over exactly the execution-authoritative Redis payload fields:
 * contractSymbol, price, marketEventTime, connectionEpoch, providerId,
 * providerInstanceId, providerConnectionId, providerTransport.
 * Tampering with ANY of these invalidates the signature.
 */
export function computeCanonicalSignature(
  contractSymbol: string,
  price: number,
  marketEventTime: number,
  connectionEpoch: number,
  providerId: string,
  providerInstanceId: string,
  providerConnectionId: string,
  providerTransport: CanonicalProviderTransport,
): string {
  const payload = [
    CANONICAL_OPTION_QUOTE_SCHEMA,
    contractSymbol.toUpperCase(),
    price.toFixed(4),
    marketEventTime,
    connectionEpoch,
    providerId,
    providerInstanceId,
    providerConnectionId,
    providerTransport,
  ].join(':');
  const secret = getCanonicalSigningSecret();
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function timingSafeSignatureEqual(actual: unknown, expected: string): boolean {
  if (
    typeof actual !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(actual) ||
    !/^[a-f0-9]{64}$/i.test(expected)
  ) {
    return false;
  }
  const actualBuf = Buffer.from(actual, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  return actualBuf.length === expectedBuf.length && crypto.timingSafeEqual(actualBuf, expectedBuf);
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
  providerInstanceId: string;
  providerConnectionId: string;
  providerTransport: CanonicalProviderTransport;
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

import { ProviderConnectionIdentity } from './option-provider/provider-connection-identity';

export interface ProviderRuntimeState {
  providerId: string;
  providerTransport: CanonicalProviderTransport;
  connectionState: ProviderConnectionState;
  providerConnected: boolean;
  currentConnection: ProviderConnectionIdentity;
  reconnectedAt: number | null;
}

export interface IExecutionQuoteValidationContext {
  expectedSymbol?: string;
  activeConnectionEpoch?: number;
  activeProviderConnectionId?: string;
  activeProviderInstanceId?: string;
  providerState?: ProviderConnectionState | string;
  isProviderConnected?: boolean;
  isProviderHealthy?: boolean;
  runtimeState?: ProviderRuntimeState;
  maxAgeMs?: number;
  maxFutureSkewMs?: number;
  currentTimeMs?: number;
  activeStreamConnection?: any;
  activeRestConnection?: any;
  activeConnection?: any;
  streamConnectionState?: ProviderConnectionState | string;
  isStreamConnected?: boolean;
  restHealthState?: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | string;
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
    | 'SYNTHETIC_REJECTED'
    | 'PROVIDER_TRANSPORT_MISMATCH'
    | 'UNKNOWN_PROVIDER_ID_REJECTED';
}

export function normalizeCanonicalProviderId(providerId: unknown): string {
  if (typeof providerId !== 'string' || providerId.trim().length === 0) {
    throw new Error('[UNKNOWN_PROVIDER_ID_REJECTED] Provider ID cannot be empty or non-string');
  }
  const trimmed = providerId.trim();
  switch (trimmed) {
    case 'NSE_OPTION_STREAM':
    case 'NSE_OPTION_PROVIDER':
    case 'NSE_STREAM_GATEWAY':
    case 'NSE_STREAM':
    case 'NSE_WEBSOCKET':
      return 'NSE_STREAM_GATEWAY';
    case 'NSE_OPTION_REST':
    case 'NSE_REST_OPTION_PROVIDER':
    case 'NSE_REST':
      return 'NSE_REST_OPTION_PROVIDER';
    case 'BINANCE_OPTION_STREAM':
    case 'BINANCE_DIRECT':
    case 'BINANCE_STREAM':
    case 'BINANCE':
    case 'BINANCE_WEBSOCKET':
      return 'BINANCE_DIRECT';
    case 'BINANCE_REST':
    case 'BINANCE_POLLING':
      return 'BINANCE_REST';
    case 'NSE_YAHOO_REST':
    case 'NSE_YAHOO':
    case 'YAHOO_REST':
      return 'NSE_YAHOO_REST';
    case 'REAL_MARKET_STREAMER':
      return 'REAL_MARKET_STREAMER';
    default:
      throw new Error(`[UNKNOWN_PROVIDER_ID_REJECTED] Unknown or unsupported provider ID '${trimmed}'`);
  }
}

export const CANONICAL_PROVIDER_IDS = new Set([
  'NSE_STREAM_GATEWAY',
  'NSE_REST_OPTION_PROVIDER',
  'NSE_YAHOO_REST',
  'BINANCE_DIRECT',
  'BINANCE_REST',
  'REAL_MARKET_STREAMER',
]);


const SUPPORTED_PROVIDER_IDS = new Set([
  'NSE_STREAM_GATEWAY',
  'NSE_OPTION_STREAM',
  'NSE_OPTION_REST',
  'BINANCE_OPTION_STREAM',
  'BINANCE_DIRECT',
  'BINANCE_REST',
  'NSE_YAHOO_REST',
  'REAL_MARKET_STREAMER',
  'NSE_OPTION_PROVIDER',
]);

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

  if (quote.provenance !== 'LIVE_PROVIDER') {
    return {
      valid: false,
      reason: `Quote provenance '${quote.provenance}' is not LIVE_PROVIDER`,
      errorType: 'NOT_LIVE_PROVIDER',
    };
  }

  if (!quote.providerId || typeof quote.providerId !== 'string' || quote.providerId.trim().length === 0) {
    return {
      valid: false,
      reason: 'Quote is missing authenticated providerId',
      errorType: 'MISSING_PROVIDER_ID',
    };
  }

  let normProviderId: string;
  try {
    normProviderId = normalizeCanonicalProviderId(quote.providerId);
  } catch (err: any) {
    return {
      valid: false,
      reason: `Quote providerId '${quote.providerId}' is unknown or non-canonical`,
      errorType: 'UNKNOWN_PROVIDER_ID_REJECTED',
    };
  }

  if (!normProviderId || !CANONICAL_PROVIDER_IDS.has(normProviderId)) {
    return {
      valid: false,
      reason: `Quote providerId '${quote.providerId}' is unknown or non-canonical`,
      errorType: 'UNKNOWN_PROVIDER_ID_REJECTED',
    };
  }

  if (quote.providerTransport !== 'WEBSOCKET_STREAM' && quote.providerTransport !== 'REST_POLLING') {
    return {
      valid: false,
      reason: `Quote providerTransport '${quote.providerTransport}' is invalid or missing`,
      errorType: 'PROVIDER_TRANSPORT_MISMATCH',
    };
  }

  if (ctx.runtimeState) {
    const rs = ctx.runtimeState;
    if (quote.providerTransport !== rs.providerTransport) {
      return {
        valid: false,
        reason: `Quote transport '${quote.providerTransport}' does not match runtime transport '${rs.providerTransport}'`,
        errorType: 'PROVIDER_TRANSPORT_MISMATCH',
      };
    }
    const rsNormId = normalizeCanonicalProviderId(rs.providerId);
    if (normProviderId !== rsNormId) {
      return {
        valid: false,
        reason: `Quote providerId '${quote.providerId}' (canonical: '${normProviderId}') does not match runtime providerId '${rs.providerId}' (canonical: '${rsNormId}')`,
        errorType: 'UNKNOWN_PROVIDER_ID_REJECTED',
      };
    }
    if (rs.connectionState === 'RECONNECTING') {
      return {
        valid: false,
        reason: 'Market data provider is in RECONNECTING state. Trade execution blocked.',
        errorType: 'PROVIDER_RECONNECTING',
      };
    }
    if (!rs.providerConnected || rs.connectionState === 'DISCONNECTED') {
      return {
        valid: false,
        reason: `Market data provider is in '${rs.connectionState || 'DISCONNECTED'}' state. Trade execution blocked.`,
        errorType: 'PROVIDER_DISCONNECTED',
      };
    }
    const conn = rs.currentConnection;
    if (conn) {
      if (quote.connectionEpoch !== conn.connectionEpoch) {
        return {
          valid: false,
          reason: `Market quote is from connection epoch ${quote.connectionEpoch ?? 'none'} (active connection epoch: ${conn.connectionEpoch}). A fresh tick from the active connection is required.`,
          errorType: 'EPOCH_MISMATCH',
        };
      }
      if (quote.providerConnectionId !== conn.providerConnectionId) {
        return {
          valid: false,
          reason: `Market quote is from provider connection '${quote.providerConnectionId ?? 'none'}' (active provider connection: ${conn.providerConnectionId}).`,
          errorType: 'EPOCH_MISMATCH',
        };
      }
      if (quote.providerInstanceId !== conn.providerInstanceId) {
        return {
          valid: false,
          reason: `Market quote is from provider instance '${quote.providerInstanceId ?? 'none'}' (active provider instance: ${conn.providerInstanceId}).`,
          errorType: 'EPOCH_MISMATCH',
        };
      }
    }
  }

  if (ctx.isProviderHealthy === false) {
    return {
      valid: false,
      reason: 'Market data provider is in an unhealthy execution state. Trade execution blocked.',
      errorType: 'PROVIDER_DISCONNECTED',
    };
  }

  // Check transport-specific health state
  const isStream = quote.providerTransport === 'WEBSOCKET_STREAM';
  const streamState = ctx.streamConnectionState ?? ctx.providerState;
  const isStreamConn = ctx.isStreamConnected ?? ctx.isProviderConnected;

  if (isStream) {
    if (streamState === 'RECONNECTING') {
      return {
        valid: false,
        reason: 'Market data stream provider is in RECONNECTING state. Trade execution blocked.',
        errorType: 'PROVIDER_RECONNECTING',
      };
    }
    if (
      streamState === 'DISCONNECTED' ||
      isStreamConn === false ||
      (streamState && !isProviderExecutionHealthy(streamState, isStreamConn))
    ) {
      return {
        valid: false,
        reason: `Market data stream provider is in '${streamState || 'DISCONNECTED'}' state. Trade execution blocked.`,
        errorType: 'PROVIDER_DISCONNECTED',
      };
    }
  } else {
    // REST transport
    const restState = ctx.restHealthState;
    if (restState === 'UNAVAILABLE' || restState === 'DEGRADED') {
      return {
        valid: false,
        reason: `Market data REST provider is in '${restState}' health state. Trade execution blocked.`,
        errorType: 'PROVIDER_DISCONNECTED',
      };
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
      ctx.isProviderConnected === false
    ) {
      return {
        valid: false,
        reason: `Market data provider is in '${ctx.providerState || 'DISCONNECTED'}' state. Trade execution blocked.`,
        errorType: 'PROVIDER_DISCONNECTED',
      };
    }
  }

  // Transport-specific Connection Identity Validation
  const targetConnection = isStream
    ? (ctx.activeStreamConnection || ctx.activeConnection)
    : (ctx.activeRestConnection || ctx.activeConnection);

  if (targetConnection) {
    const targetNormProviderId = normalizeCanonicalProviderId(targetConnection.providerId);
    if (targetConnection.providerTransport && quote.providerTransport !== targetConnection.providerTransport) {
      return {
        valid: false,
        reason: `Quote transport '${quote.providerTransport}' does not match active target connection transport '${targetConnection.providerTransport}'`,
        errorType: 'PROVIDER_TRANSPORT_MISMATCH',
      };
    }
    if (normProviderId !== targetNormProviderId) {
      return {
        valid: false,
        reason: `Quote providerId '${quote.providerId}' (canonical: '${normProviderId}') does not match target connection providerId '${targetConnection.providerId}' (canonical: '${targetNormProviderId}')`,
        errorType: 'UNKNOWN_PROVIDER_ID_REJECTED',
      };
    }
    if (quote.connectionEpoch !== targetConnection.connectionEpoch) {
      return {
        valid: false,
        reason: `Market quote is from connection epoch ${quote.connectionEpoch ?? 'none'} (active connection epoch: ${targetConnection.connectionEpoch}). A fresh tick from the active connection is required.`,
        errorType: 'EPOCH_MISMATCH',
      };
    }
    if (quote.providerConnectionId !== targetConnection.providerConnectionId) {
      return {
        valid: false,
        reason: `Market quote is from provider connection '${quote.providerConnectionId ?? 'none'}' (active provider connection: ${targetConnection.providerConnectionId}).`,
        errorType: 'EPOCH_MISMATCH',
      };
    }
    if (quote.providerInstanceId !== targetConnection.providerInstanceId) {
      return {
        valid: false,
        reason: `Market quote is from provider instance '${quote.providerInstanceId ?? 'none'}' (active provider instance: ${targetConnection.providerInstanceId}).`,
        errorType: 'EPOCH_MISMATCH',
      };
    }
  } else if (!isStream && ctx.activeStreamConnection && !ctx.activeRestConnection && !ctx.activeConnection) {
    // REST quote tested against ONLY stream connection
    return {
      valid: false,
      reason: 'REST quote cannot be validated against a stream connection authority',
      errorType: 'PROVIDER_TRANSPORT_MISMATCH',
    };
  } else if (isStream && ctx.activeRestConnection && !ctx.activeStreamConnection && !ctx.activeConnection) {
    // Stream quote tested against ONLY REST connection
    return {
      valid: false,
      reason: 'Stream quote cannot be validated against a REST connection authority',
      errorType: 'PROVIDER_TRANSPORT_MISMATCH',
    };
  } else {
    // Direct epoch/ID field validation fallback
    if (ctx.activeConnectionEpoch !== undefined) {
      if (quote.connectionEpoch !== ctx.activeConnectionEpoch) {
        return {
          valid: false,
          reason: `Market quote is from connection epoch ${quote.connectionEpoch ?? 'none'} (active connection epoch: ${ctx.activeConnectionEpoch}). A fresh tick from the active connection is required.`,
          errorType: 'EPOCH_MISMATCH',
        };
      }
    }
    if (ctx.activeProviderConnectionId !== undefined && quote.providerConnectionId !== ctx.activeProviderConnectionId) {
      return {
        valid: false,
        reason: `Market quote is from provider connection '${quote.providerConnectionId ?? 'none'}' (active provider connection: ${ctx.activeProviderConnectionId}).`,
        errorType: 'EPOCH_MISMATCH',
      };
    }
    if (ctx.activeProviderInstanceId !== undefined && quote.providerInstanceId !== ctx.activeProviderInstanceId) {
      return {
        valid: false,
        reason: `Market quote is from provider instance '${quote.providerInstanceId ?? 'none'}' (active provider instance: ${ctx.activeProviderInstanceId}).`,
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

export function validateCurrentProviderExecutionQuote(
  quote: any,
  ctx: IExecutionQuoteValidationContext = {},
): IExecutionQuoteValidationResult {
  return validateAuthoritativeExecutionQuote(quote, ctx);
}


export function parseAndValidateRedisOptionQuote(
  rawJson: string | null | undefined,
  expectedContractSymbol: string,
  activeConnectionOrEpoch: any,
  isStreamerHealthy: boolean,
  currentTimeMs = Date.now(),
  activeProviderConnectionId?: string,
  activeProviderInstanceId?: string,
): { valid: boolean; quote?: any; reason?: string; errorType?: string } {
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

  if (parsed.providerTransport !== 'WEBSOCKET_STREAM' && parsed.providerTransport !== 'REST_POLLING') {
    return { valid: false, reason: `Redis option quote has invalid providerTransport: ${parsed.providerTransport}`, errorType: 'PROVIDER_TRANSPORT_MISMATCH' };
  }

  if (!parsed.providerId || !SUPPORTED_PROVIDER_IDS.has(parsed.providerId)) {
    return { valid: false, reason: `Redis option quote providerId '${parsed.providerId}' is unknown or unsupported`, errorType: 'UNKNOWN_PROVIDER_ID_REJECTED' };
  }

  // Streamer health check
  if (!isStreamerHealthy) {
    return { valid: false, reason: 'Underlying market streamer is not in an execution-healthy state' };
  }

  // Active Connection Identity / Epoch Check
  if (typeof activeConnectionOrEpoch === 'object' && activeConnectionOrEpoch !== null) {
    if (activeConnectionOrEpoch.providerTransport) {
      if (parsed.providerTransport !== activeConnectionOrEpoch.providerTransport) {
        return {
          valid: false,
          reason: `Redis option quote providerTransport '${parsed.providerTransport}' does not match active connection transport '${activeConnectionOrEpoch.providerTransport}'`,
          errorType: 'PROVIDER_TRANSPORT_MISMATCH',
        };
      }
      if (parsed.providerId !== activeConnectionOrEpoch.providerId) {
        return {
          valid: false,
          reason: `Redis option quote providerId '${parsed.providerId}' does not match active connection providerId '${activeConnectionOrEpoch.providerId}'`,
          errorType: 'UNKNOWN_PROVIDER_ID_REJECTED',
        };
      }
      if (parsed.connectionEpoch !== activeConnectionOrEpoch.connectionEpoch) {
        return {
          valid: false,
          reason: `Redis option quote is from obsolete connection epoch ${parsed.connectionEpoch} (active epoch: ${activeConnectionOrEpoch.connectionEpoch})`,
          errorType: 'EPOCH_MISMATCH',
        };
      }
      if (parsed.providerConnectionId !== activeConnectionOrEpoch.providerConnectionId) {
        return {
          valid: false,
          reason: `Redis option quote is from provider connection '${parsed.providerConnectionId ?? 'none'}' (active provider connection: '${activeConnectionOrEpoch.providerConnectionId}')`,
          errorType: 'EPOCH_MISMATCH',
        };
      }
      if (parsed.providerInstanceId !== activeConnectionOrEpoch.providerInstanceId) {
        return {
          valid: false,
          reason: `Redis option quote is from provider instance '${parsed.providerInstanceId ?? 'none'}' (active provider instance: '${activeConnectionOrEpoch.providerInstanceId}')`,
          errorType: 'EPOCH_MISMATCH',
        };
      }
    }
  } else if (typeof activeConnectionOrEpoch === 'number') {
    const activeEpoch = activeConnectionOrEpoch;
    if (parsed.connectionEpoch !== activeEpoch) {
      return {
        valid: false,
        reason: `Redis option quote is from obsolete connection epoch ${parsed.connectionEpoch} (active epoch: ${activeEpoch})`,
        errorType: 'EPOCH_MISMATCH',
      };
    }
    if (activeProviderConnectionId !== undefined && parsed.providerConnectionId !== activeProviderConnectionId) {
      return {
        valid: false,
        reason: `Redis option quote is from obsolete provider connection ${parsed.providerConnectionId ?? 'none'} (active provider connection: ${activeProviderConnectionId})`,
        errorType: 'EPOCH_MISMATCH',
      };
    }
    if (activeProviderInstanceId !== undefined && parsed.providerInstanceId !== activeProviderInstanceId) {
      return {
        valid: false,
        reason: `Redis option quote is from provider instance ${parsed.providerInstanceId ?? 'none'} (active provider instance: ${activeProviderInstanceId})`,
        errorType: 'EPOCH_MISMATCH',
      };
    }
  }

  // Signature verification to prevent arbitrary/forged Redis JSON elevation
  const expectedSig = computeCanonicalSignature(
    expectedContract,
    parsed.price,
    parsed.marketEventTime,
    parsed.connectionEpoch,
    parsed.providerId,
    parsed.providerInstanceId,
    parsed.providerConnectionId,
    parsed.providerTransport,
  );
  if (!timingSafeSignatureEqual(parsed.signatureToken, expectedSig)) {
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
      providerInstanceId: parsed.providerInstanceId,
      providerConnectionId: parsed.providerConnectionId,
      providerTransport: parsed.providerTransport,
    },
  };
}
