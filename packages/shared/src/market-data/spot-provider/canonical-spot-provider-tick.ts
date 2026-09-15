import * as crypto from 'crypto';
import {
  CanonicalProviderTransport,
  validateExecutionQuoteTimestamp,
} from '../execution-quote-validator';
import { RawSpotProviderEvent } from './raw-spot-provider-event';
import {
  BINANCE_REST_SPOT_PROVIDER_VALIDATOR,
  BINANCE_SPOT_PROVIDER_VALIDATOR,
  ISpotProviderValidator,
  isValidatedSpotProviderEvent,
  NSE_STREAM_SPOT_PROVIDER_VALIDATOR,
  NSE_YAHOO_REST_SPOT_PROVIDER_VALIDATOR,
  ValidatedSpotProviderEvent,
} from './spot-provider-validators';
import {
  isProviderConnectionIdentity,
  mintProviderConnectionIdentityForAdapter,
  ProviderConnectionIdentity,
} from '../option-provider/provider-connection-identity';

/**
 * AI FIX 161 — ValidatedCanonicalSpotProviderTick
 *
 * Sealed branded spot provider canonical execution tick.
 * Cannot be constructed or manufactured outside the sealed spot adapter path.
 */

const BRANDED_CANONICAL_SPOT_PROVIDER_TICKS = new WeakSet<object>();
const CANONICAL_SPOT_TICK_CREATION_SEAL: unique symbol = Symbol(
  'quant.canonical.spot.provider.tick.seal',
);

export interface ICanonicalSpotProviderTickInput {
  readonly symbol: string;
  readonly price: number;
  readonly marketEventTime: number;
  readonly providerId: string;
  readonly connectionEpoch: number;
  readonly providerInstanceId: string;
  readonly providerConnectionId: string;
  readonly providerTransport: CanonicalProviderTransport;
  readonly observedAt?: number;
  readonly receivedAt?: number;
  readonly sequence?: number;
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
}

interface ISealedCanonicalSpotProviderTickConstructor {
  new (seal: symbol, input: ICanonicalSpotProviderTickInput): ValidatedCanonicalSpotProviderTick;
}

export class ValidatedCanonicalSpotProviderTick {
  private readonly fields: Readonly<ICanonicalSpotProviderTickInput>;

  private constructor(seal: symbol, input: ICanonicalSpotProviderTickInput) {
    if (seal !== CANONICAL_SPOT_TICK_CREATION_SEAL) {
      throw new Error(
        '[UNBRANDED_SPOT_TICK_REJECTED] ValidatedCanonicalSpotProviderTick cannot be constructed outside the sealed spot provider adapter path',
      );
    }
    this.fields = Object.freeze({ ...input });
    BRANDED_CANONICAL_SPOT_PROVIDER_TICKS.add(this);
    Object.freeze(this);
  }

  public get symbol(): string {
    return this.fields.symbol;
  }

  public toRecordInput(): Readonly<ICanonicalSpotProviderTickInput> {
    return this.fields;
  }
}

const SealedCanonicalSpotProviderTick =
  ValidatedCanonicalSpotProviderTick as unknown as ISealedCanonicalSpotProviderTickConstructor;

export function isValidatedCanonicalSpotProviderTick(
  value: unknown,
): value is ValidatedCanonicalSpotProviderTick {
  return (
    typeof value === 'object' &&
    value !== null &&
    BRANDED_CANONICAL_SPOT_PROVIDER_TICKS.has(value)
  );
}

export function validateCanonicalSpotProviderTickInput(input: ICanonicalSpotProviderTickInput): void {
  if (!input || !input.symbol || typeof input.symbol !== 'string') {
    throw new Error('Canonical spot quote requires valid symbol');
  }
  if (typeof input.price !== 'number' || !Number.isFinite(input.price) || input.price <= 0) {
    throw new Error(`Canonical spot quote requires positive finite price, got: ${input.price}`);
  }
  if (
    !input.providerId ||
    typeof input.providerId !== 'string' ||
    input.providerId.trim().length === 0
  ) {
    throw new Error('Canonical spot quote requires non-empty authenticated providerId');
  }
  if (
    typeof input.connectionEpoch !== 'number' ||
    !Number.isFinite(input.connectionEpoch) ||
    input.connectionEpoch <= 0
  ) {
    throw new Error(
      `Canonical spot quote requires positive connectionEpoch, got: ${input.connectionEpoch}`,
    );
  }
  if (
    !input.providerInstanceId ||
    typeof input.providerInstanceId !== 'string' ||
    input.providerInstanceId.trim().length === 0
  ) {
    throw new Error('Canonical spot quote requires non-empty providerInstanceId');
  }
  if (
    !input.providerConnectionId ||
    typeof input.providerConnectionId !== 'string' ||
    input.providerConnectionId.trim().length === 0
  ) {
    throw new Error('Canonical spot quote requires non-empty providerConnectionId');
  }
  if (
    input.providerTransport !== 'WEBSOCKET_STREAM' &&
    input.providerTransport !== 'REST_POLLING'
  ) {
    throw new Error(
      `Canonical spot quote requires explicit providerTransport, got: ${input.providerTransport}`,
    );
  }

  const tsValidation = validateExecutionQuoteTimestamp(input.marketEventTime, Date.now());
  if (!tsValidation.valid) {
    throw new Error(`Canonical spot quote timestamp rejected: ${tsValidation.reason}`);
  }
}

function brandCanonicalSpotProviderTick(
  event: ValidatedSpotProviderEvent,
  connection: ProviderConnectionIdentity,
): ValidatedCanonicalSpotProviderTick {
  if (!isValidatedSpotProviderEvent(event)) {
    throw new Error(
      '[UNBRANDED_SPOT_EVENT_REJECTED] Canonical spot tick requires a validated spot event from a provider-specific validator',
    );
  }
  if (!isProviderConnectionIdentity(connection)) {
    throw new Error(
      '[UNBRANDED_CONNECTION_IDENTITY_REJECTED] Canonical spot tick requires a branded provider connection identity',
    );
  }
  if (event.providerId !== connection.providerId) {
    throw new Error(
      `[PROVIDER_CONNECTION_IDENTITY_MISMATCH] Validated spot event providerId ${event.providerId} does not match branded connection providerId ${connection.providerId}`,
    );
  }
  const now = Date.now();
  const canonicalInput: ICanonicalSpotProviderTickInput = {
    symbol: event.symbol,
    price: event.price,
    marketEventTime: event.marketEventTime,
    providerId: event.providerId,
    connectionEpoch: connection.connectionEpoch,
    providerInstanceId: connection.providerInstanceId,
    providerConnectionId: connection.providerConnectionId,
    providerTransport: event.providerTransport,
    observedAt: now,
    receivedAt: now,
    sequence: event.sequence,
    open: event.open,
    high: event.high,
    low: event.low,
    close: event.close,
    volume: event.volume,
    prevClose: event.prevClose,
    changePercent: event.changePercent,
    changeAmount: event.changeAmount,
    volatility: event.volatility,
    tickSize: event.tickSize,
  };

  validateCanonicalSpotProviderTickInput(canonicalInput);

  return new SealedCanonicalSpotProviderTick(CANONICAL_SPOT_TICK_CREATION_SEAL, canonicalInput);
}

export interface ISpotProviderAdapter {
  readonly providerId: string;
  readonly providerTransport: CanonicalProviderTransport;
  beginProviderConnection(options?: {
    readonly providerInstanceId?: string;
    readonly existingConnection?: ProviderConnectionIdentity;
  }): ProviderConnectionIdentity;
  getCurrentProviderConnection(): ProviderConnectionIdentity | null;
  validateProviderEvent(raw: RawSpotProviderEvent): ValidatedSpotProviderEvent;
  toCanonicalExecutionTick(
    raw: RawSpotProviderEvent,
    connectionGuard?: ProviderConnectionIdentity,
  ): ValidatedCanonicalSpotProviderTick;
  resetForTests(): void;
}

function createSpotProviderAdapter(
  validator: ISpotProviderValidator,
): ISpotProviderAdapter {
  if (!validator || typeof validator.validate !== 'function') {
    throw new Error('Spot provider adapter requires a provider-specific validator');
  }
  let connectionEpoch = 0;
  let currentConnection: ProviderConnectionIdentity | null = null;
  return Object.freeze({
    providerId: validator.providerId,
    providerTransport: validator.providerTransport,
    beginProviderConnection(options?: {
      readonly providerInstanceId?: string;
      readonly existingConnection?: ProviderConnectionIdentity;
    }): ProviderConnectionIdentity {
      if (options?.existingConnection && isProviderConnectionIdentity(options.existingConnection)) {
        currentConnection = options.existingConnection;
        connectionEpoch = currentConnection.connectionEpoch;
        return currentConnection;
      }
      const providerInstanceId =
        typeof options?.providerInstanceId === 'string' && options.providerInstanceId.trim().length > 0
          ? options.providerInstanceId.trim()
          : crypto.randomUUID();
      connectionEpoch += 1;
      currentConnection = mintProviderConnectionIdentityForAdapter({
        providerId: validator.providerId,
        providerInstanceId,
        connectionEpoch,
        providerTransport: validator.providerTransport,
      });
      return currentConnection;
    },
    getCurrentProviderConnection(): ProviderConnectionIdentity | null {
      return currentConnection;
    },
    validateProviderEvent(raw: RawSpotProviderEvent): ValidatedSpotProviderEvent {
      return validator.validate(raw);
    },
    toCanonicalExecutionTick(
      raw: RawSpotProviderEvent,
      connectionGuard?: ProviderConnectionIdentity,
    ): ValidatedCanonicalSpotProviderTick {
      if (!currentConnection) {
        throw new Error(
          '[PROVIDER_CONNECTION_REQUIRED] Spot provider adapter must have a current provider connection before minting canonical ticks',
        );
      }
      if (connectionGuard !== undefined) {
        if (!isProviderConnectionIdentity(connectionGuard)) {
          throw new Error(
            '[UNBRANDED_CONNECTION_IDENTITY_REJECTED] Spot provider adapter rejected a fabricated provider connection identity',
          );
        }
        if (connectionGuard !== currentConnection) {
          throw new Error(
            '[STALE_PROVIDER_CONNECTION_REJECTED] Spot provider adapter rejected a non-current provider connection identity',
          );
        }
      }
      const validated = validator.validate(raw);
      if (!isValidatedSpotProviderEvent(validated)) {
        throw new Error(
          '[PROVIDER_ADAPTER_INTEGRITY] Spot provider validator did not yield a branded validated event',
        );
      }
      return brandCanonicalSpotProviderTick(validated, currentConnection);
    },
    resetForTests(): void {
      connectionEpoch = 0;
      currentConnection = null;
    },
  });
}

export const BINANCE_SPOT_PROVIDER_ADAPTER = createSpotProviderAdapter(
  BINANCE_SPOT_PROVIDER_VALIDATOR,
);

export const BINANCE_REST_SPOT_PROVIDER_ADAPTER = createSpotProviderAdapter(
  BINANCE_REST_SPOT_PROVIDER_VALIDATOR,
);

export const NSE_YAHOO_REST_SPOT_PROVIDER_ADAPTER = createSpotProviderAdapter(
  NSE_YAHOO_REST_SPOT_PROVIDER_VALIDATOR,
);

export const NSE_STREAM_SPOT_PROVIDER_ADAPTER = createSpotProviderAdapter(
  NSE_STREAM_SPOT_PROVIDER_VALIDATOR,
);

export function resetAllSpotProviderAdaptersForTests(): void {
  BINANCE_SPOT_PROVIDER_ADAPTER.resetForTests();
  BINANCE_REST_SPOT_PROVIDER_ADAPTER.resetForTests();
  NSE_YAHOO_REST_SPOT_PROVIDER_ADAPTER.resetForTests();
  NSE_STREAM_SPOT_PROVIDER_ADAPTER.resetForTests();
}
