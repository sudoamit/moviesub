import {
  CanonicalProviderTransport,
  validateExecutionQuoteTimestamp,
} from '../execution-quote-validator';
import { RawSpotProviderEvent } from './raw-spot-provider-event';

/**
 * AI FIX 161 — Validated spot provider event layer + spot provider validators.
 *
 * A ValidatedSpotProviderEvent is a branded, immutable record proving that a raw
 * spot provider event passed a provider-specific validator.
 */

const BRANDED_VALIDATED_SPOT_PROVIDER_EVENTS = new WeakSet<object>();
const VALIDATED_SPOT_EVENT_CREATION_SEAL: unique symbol = Symbol(
  'quant.validated.spot.provider.event.seal',
);

export interface IValidatedSpotProviderEventFields {
  readonly providerId: string;
  readonly providerTransport: CanonicalProviderTransport;
  readonly symbol: string;
  readonly price: number;
  readonly marketEventTime: number;
  readonly open?: number;
  readonly high?: number;
  readonly low?: number;
  readonly close?: number;
  readonly volume?: number;
  readonly prevClose?: number;
  readonly changePercent?: number;
  readonly changeAmount?: number;
  readonly volatility?: number;
  readonly tickSize?: number;
  readonly sequence?: number;
}

interface ISealedValidatedSpotProviderEventConstructor {
  new (seal: symbol, fields: IValidatedSpotProviderEventFields): ValidatedSpotProviderEvent;
}

export class ValidatedSpotProviderEvent {
  public readonly providerId: string;
  public readonly providerTransport: CanonicalProviderTransport;
  public readonly symbol: string;
  public readonly price: number;
  public readonly marketEventTime: number;
  public readonly open?: number;
  public readonly high?: number;
  public readonly low?: number;
  public readonly close?: number;
  public readonly volume?: number;
  public readonly prevClose?: number;
  public readonly changePercent?: number;
  public readonly changeAmount?: number;
  public readonly volatility?: number;
  public readonly tickSize?: number;
  public readonly sequence?: number;

  private constructor(seal: symbol, fields: IValidatedSpotProviderEventFields) {
    if (seal !== VALIDATED_SPOT_EVENT_CREATION_SEAL) {
      throw new Error(
        '[UNBRANDED_VALIDATED_SPOT_EVENT_REJECTED] ValidatedSpotProviderEvent cannot be constructed outside a spot provider-specific validator',
      );
    }
    this.providerId = fields.providerId;
    this.providerTransport = fields.providerTransport;
    this.symbol = fields.symbol;
    this.price = fields.price;
    this.marketEventTime = fields.marketEventTime;
    this.open = fields.open;
    this.high = fields.high;
    this.low = fields.low;
    this.close = fields.close;
    this.volume = fields.volume;
    this.prevClose = fields.prevClose;
    this.changePercent = fields.changePercent;
    this.changeAmount = fields.changeAmount;
    this.volatility = fields.volatility;
    this.tickSize = fields.tickSize;
    this.sequence = fields.sequence;

    BRANDED_VALIDATED_SPOT_PROVIDER_EVENTS.add(this);
    Object.freeze(this);
  }
}

const SealedValidatedSpotProviderEvent =
  ValidatedSpotProviderEvent as unknown as ISealedValidatedSpotProviderEventConstructor;

export function isValidatedSpotProviderEvent(
  value: unknown,
): value is ValidatedSpotProviderEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    BRANDED_VALIDATED_SPOT_PROVIDER_EVENTS.has(value)
  );
}

export interface ISpotProviderValidator {
  readonly providerId: string;
  readonly providerTransport: CanonicalProviderTransport;
  validate(raw: RawSpotProviderEvent): ValidatedSpotProviderEvent;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function toNonNegativeOrUndefined(value: unknown): number | undefined {
  const num = toFiniteNumber(value);
  return num !== undefined && num >= 0 ? num : undefined;
}

function toEventTimeMs(value: unknown): number | undefined {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  return toFiniteNumber(value);
}

function rejectMismatchedClaim(value: unknown, expected: string, label: string): void {
  if (value === undefined || value === null) return;
  const actual = typeof value === 'string' ? value.trim() : '';
  if (actual !== expected) {
    throw new Error(
      `[PROVIDER_EVENT_REJECTED] Raw spot provider event ${label} '${String(
        value,
      )}' conflicts with the validating adapter identity '${expected}'`,
    );
  }
}

function createSpotProviderValidator(
  providerId: string,
  providerTransport: CanonicalProviderTransport,
): ISpotProviderValidator {
  return Object.freeze({
    providerId,
    providerTransport,
    validate(raw: RawSpotProviderEvent): ValidatedSpotProviderEvent {
      if (!raw || typeof raw !== 'object') {
        throw new Error('[PROVIDER_EVENT_REJECTED] Raw spot provider event must be an object');
      }
      if (raw.isSynthetic === true) {
        throw new Error('[PROVIDER_EVENT_REJECTED] Synthetic spot provider events cannot be branded');
      }

      rejectMismatchedClaim(raw.providerId, providerId, 'providerId');
      rejectMismatchedClaim(raw.providerTransport, providerTransport, 'providerTransport');

      const providerSymbol =
        typeof raw.providerSymbol === 'string' ? raw.providerSymbol.trim() : '';
      if (providerSymbol.length === 0) {
        throw new Error('[PROVIDER_EVENT_REJECTED] Spot provider event requires a non-empty symbol');
      }

      const price = toFiniteNumber(raw.price);
      if (price === undefined || price <= 0) {
        throw new Error(
          `[PROVIDER_EVENT_REJECTED] Spot provider event requires a positive finite price, got: ${String(
            raw.price,
          )}`,
        );
      }

      const marketEventTime = toEventTimeMs(raw.providerEventTime);
      if (marketEventTime === undefined) {
        throw new Error(
          '[PROVIDER_EVENT_REJECTED] Spot provider event requires a genuine provider event time',
        );
      }
      const tsValidation = validateExecutionQuoteTimestamp(marketEventTime, Date.now());
      if (!tsValidation.valid) {
        throw new Error(
          `[PROVIDER_EVENT_REJECTED] Spot provider event timestamp rejected: ${tsValidation.reason}`,
        );
      }

      if (raw.connectionEpoch !== undefined && raw.connectionEpoch !== null) {
        throw new Error(
          '[PROVIDER_EVENT_REJECTED] Spot provider event cannot supply trusted connectionEpoch; the adapter derives it from the current provider connection',
        );
      }

      return new SealedValidatedSpotProviderEvent(VALIDATED_SPOT_EVENT_CREATION_SEAL, {
        providerId,
        providerTransport,
        symbol: providerSymbol.toUpperCase(),
        price,
        marketEventTime,
        open: toNonNegativeOrUndefined(raw.open),
        high: toNonNegativeOrUndefined(raw.high),
        low: toNonNegativeOrUndefined(raw.low),
        close: toNonNegativeOrUndefined(raw.close),
        volume: toNonNegativeOrUndefined(raw.volume),
        prevClose: toNonNegativeOrUndefined(raw.prevClose),
        changePercent: toFiniteNumber(raw.changePercent),
        changeAmount: toFiniteNumber(raw.changeAmount),
        volatility: toNonNegativeOrUndefined(raw.volatility),
        tickSize: toNonNegativeOrUndefined(raw.tickSize),
        sequence: toFiniteNumber(raw.sequence),
      });
    },
  });
}

export const BINANCE_SPOT_PROVIDER_VALIDATOR = createSpotProviderValidator(
  'BINANCE_DIRECT',
  'WEBSOCKET_STREAM',
);

export const BINANCE_REST_SPOT_PROVIDER_VALIDATOR = createSpotProviderValidator(
  'BINANCE_REST',
  'REST_POLLING',
);

export const NSE_YAHOO_REST_SPOT_PROVIDER_VALIDATOR = createSpotProviderValidator(
  'NSE_YAHOO_REST',
  'REST_POLLING',
);

export const NSE_STREAM_SPOT_PROVIDER_VALIDATOR = createSpotProviderValidator(
  'NSE_STREAM_GATEWAY',
  'WEBSOCKET_STREAM',
);
