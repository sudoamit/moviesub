import {
  CanonicalProviderTransport,
  validateExecutionQuoteTimestamp,
} from '../execution-quote-validator';
import { RawOptionProviderEvent } from './raw-option-provider-event';

/**
 * AI FIX 156 — Validated provider event layer + provider-specific validators.
 *
 * A ValidatedOptionProviderEvent is a branded, immutable record proving that a raw
 * provider event passed a *provider-specific* validator (providerId, transport,
 * symbol, price and genuine provider event time all verified against that provider's
 * rules). It is the ONLY input accepted by the canonical execution tick brander.
 */

const BRANDED_VALIDATED_OPTION_PROVIDER_EVENTS = new WeakSet<object>();
const VALIDATED_EVENT_CREATION_SEAL: unique symbol = Symbol(
  'quant.validated.option.provider.event.seal',
);

export interface IValidatedOptionProviderEventFields {
  readonly providerId: string;
  readonly providerTransport: CanonicalProviderTransport;
  readonly contractSymbol: string;
  readonly price: number;
  readonly marketEventTime: number;
  readonly connectionEpoch: number;
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

interface ISealedValidatedOptionProviderEventConstructor {
  new (seal: symbol, fields: IValidatedOptionProviderEventFields): ValidatedOptionProviderEvent;
}

export class ValidatedOptionProviderEvent {
  public readonly providerId: string;
  public readonly providerTransport: CanonicalProviderTransport;
  public readonly contractSymbol: string;
  public readonly price: number;
  public readonly marketEventTime: number;
  public readonly connectionEpoch: number;
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

  private constructor(seal: symbol, fields: IValidatedOptionProviderEventFields) {
    if (seal !== VALIDATED_EVENT_CREATION_SEAL) {
      throw new Error(
        '[UNBRANDED_VALIDATED_EVENT_REJECTED] ValidatedOptionProviderEvent cannot be constructed outside a provider-specific validator',
      );
    }
    this.providerId = fields.providerId;
    this.providerTransport = fields.providerTransport;
    this.contractSymbol = fields.contractSymbol;
    this.price = fields.price;
    this.marketEventTime = fields.marketEventTime;
    this.connectionEpoch = fields.connectionEpoch;
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

    BRANDED_VALIDATED_OPTION_PROVIDER_EVENTS.add(this);
    Object.freeze(this);
  }
}

const SealedValidatedOptionProviderEvent =
  ValidatedOptionProviderEvent as unknown as ISealedValidatedOptionProviderEventConstructor;

export function isValidatedOptionProviderEvent(
  value: unknown,
): value is ValidatedOptionProviderEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    BRANDED_VALIDATED_OPTION_PROVIDER_EVENTS.has(value)
  );
}

export interface IOptionProviderValidator {
  readonly providerId: string;
  readonly providerTransport: CanonicalProviderTransport;
  validate(raw: RawOptionProviderEvent): ValidatedOptionProviderEvent;
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

function requireMatchingClaim(value: unknown, expected: string, label: string): void {
  const actual = typeof value === 'string' ? value.trim() : '';
  if (actual !== expected) {
    throw new Error(
      `[PROVIDER_EVENT_REJECTED] Raw provider event ${label} '${String(
        value,
      )}' does not match the validating adapter claim '${expected}'`,
    );
  }
}

/**
 * Builds a provider-specific validator. The returned validator hard-binds the
 * providerId + transport it accepts, validates the *original* provider event before
 * branding, and is the sole producer of a branded ValidatedOptionProviderEvent.
 */
export function createOptionProviderValidator(
  providerId: string,
  providerTransport: CanonicalProviderTransport,
): IOptionProviderValidator {
  return Object.freeze({
    providerId,
    providerTransport,
    validate(raw: RawOptionProviderEvent): ValidatedOptionProviderEvent {
      if (!raw || typeof raw !== 'object') {
        throw new Error('[PROVIDER_EVENT_REJECTED] Raw provider event must be an object');
      }
      if (raw.isSynthetic === true) {
        throw new Error('[PROVIDER_EVENT_REJECTED] Synthetic provider events cannot be branded');
      }

      requireMatchingClaim(raw.providerId, providerId, 'providerId');
      requireMatchingClaim(raw.providerTransport, providerTransport, 'providerTransport');

      const providerSymbol =
        typeof raw.providerSymbol === 'string' ? raw.providerSymbol.trim() : '';
      if (providerSymbol.length === 0) {
        throw new Error('[PROVIDER_EVENT_REJECTED] Provider event requires a non-empty contract symbol');
      }

      const price = toFiniteNumber(raw.price);
      if (price === undefined || price <= 0) {
        throw new Error(
          `[PROVIDER_EVENT_REJECTED] Provider event requires a positive finite price, got: ${String(
            raw.price,
          )}`,
        );
      }

      const marketEventTime = toEventTimeMs(raw.providerEventTime);
      if (marketEventTime === undefined) {
        throw new Error(
          '[PROVIDER_EVENT_REJECTED] Provider event requires a genuine provider event time',
        );
      }
      const tsValidation = validateExecutionQuoteTimestamp(marketEventTime, Date.now());
      if (!tsValidation.valid) {
        throw new Error(
          `[PROVIDER_EVENT_REJECTED] Provider event timestamp rejected: ${tsValidation.reason}`,
        );
      }

      if (
        typeof raw.connectionEpoch !== 'number' ||
        !Number.isFinite(raw.connectionEpoch) ||
        raw.connectionEpoch <= 0
      ) {
        throw new Error(
          `[PROVIDER_EVENT_REJECTED] Provider event requires a positive finite connectionEpoch, got: ${raw.connectionEpoch}`,
        );
      }

      return new SealedValidatedOptionProviderEvent(VALIDATED_EVENT_CREATION_SEAL, {
        providerId,
        providerTransport,
        contractSymbol: providerSymbol.toUpperCase(),
        price,
        marketEventTime,
        connectionEpoch: raw.connectionEpoch,
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

export const NSE_STREAM_OPTION_PROVIDER_VALIDATOR = createOptionProviderValidator(
  'NSE_STREAM_GATEWAY',
  'WEBSOCKET_STREAM',
);

export const NSE_REST_OPTION_PROVIDER_VALIDATOR = createOptionProviderValidator(
  'NSE_YAHOO_REST',
  'REST_POLLING',
);

export const BINANCE_OPTION_PROVIDER_VALIDATOR = createOptionProviderValidator(
  'BINANCE_DIRECT',
  'WEBSOCKET_STREAM',
);
