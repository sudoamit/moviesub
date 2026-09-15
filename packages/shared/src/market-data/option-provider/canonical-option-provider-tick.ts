import * as crypto from 'crypto';
import {
  CanonicalProviderTransport,
  validateExecutionQuoteTimestamp,
  normalizeCanonicalProviderId,
} from '../execution-quote-validator';
import { RawOptionProviderEvent } from './raw-option-provider-event';
import {
  BINANCE_OPTION_PROVIDER_VALIDATOR,
  BINANCE_REST_PROVIDER_VALIDATOR,
  BINANCE_SPOT_PROVIDER_VALIDATOR,
  IOptionProviderValidator,
  isValidatedOptionProviderEvent,
  NSE_REST_OPTION_PROVIDER_VALIDATOR,
  NSE_STREAM_OPTION_PROVIDER_VALIDATOR,
  NSE_YAHOO_REST_PROVIDER_VALIDATOR,
  ValidatedOptionProviderEvent,
} from './option-provider-validators';
import {
  isProviderConnectionIdentity,
  mintProviderConnectionIdentityForAdapter,
  ProviderConnectionIdentity,
} from './provider-connection-identity';

/**
 * AI FIX 156 — Canonical execution tick (branded provider-origin tick).
 *
 * ValidatedCanonicalOptionProviderTick is the canonical, execution-grade tick. It
 * cannot be fabricated by arbitrary application code:
 *   - the constructor is private,
 *   - construction is sealed behind a module-private `unique symbol`,
 *   - every instance is recorded in a module-private WeakSet brand,
 *   - all fields (and the instance itself) are frozen,
 *   - the ONLY production path is a provider-specific adapter factory in this
 *     module, which validates the raw provider event before branding,
 *
 * There is intentionally NO generic public `fromProviderEvent()` factory.
 */

const BRANDED_CANONICAL_OPTION_PROVIDER_TICKS = new WeakSet<object>();
const CANONICAL_TICK_CREATION_SEAL: unique symbol = Symbol(
  'quant.canonical.option.provider.tick.seal',
);

export interface ICanonicalOptionProviderTickInput {
  readonly contractSymbol: string;
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

interface ISealedCanonicalOptionProviderTickConstructor {
  new (seal: symbol, input: ICanonicalOptionProviderTickInput): ValidatedCanonicalOptionProviderTick;
}

export class ValidatedCanonicalOptionProviderTick {
  private readonly fields: Readonly<ICanonicalOptionProviderTickInput>;

  private constructor(seal: symbol, input: ICanonicalOptionProviderTickInput) {
    if (seal !== CANONICAL_TICK_CREATION_SEAL) {
      throw new Error(
        '[UNBRANDED_PROVIDER_TICK_REJECTED] ValidatedCanonicalOptionProviderTick cannot be constructed outside the sealed provider adapter path',
      );
    }
    this.fields = Object.freeze({ ...input });
    BRANDED_CANONICAL_OPTION_PROVIDER_TICKS.add(this);
    Object.freeze(this);
  }

  public get contractSymbol(): string {
    return this.fields.contractSymbol;
  }

  public toRecordInput(): Readonly<ICanonicalOptionProviderTickInput> {
    return this.fields;
  }
}

const SealedCanonicalOptionProviderTick =
  ValidatedCanonicalOptionProviderTick as unknown as ISealedCanonicalOptionProviderTickConstructor;

export function isValidatedCanonicalOptionProviderTick(
  value: unknown,
): value is ValidatedCanonicalOptionProviderTick {
  return (
    typeof value === 'object' &&
    value !== null &&
    BRANDED_CANONICAL_OPTION_PROVIDER_TICKS.has(value)
  );
}

export function validateCanonicalProviderTickInput(input: ICanonicalOptionProviderTickInput): void {
  if (!input || !input.contractSymbol || typeof input.contractSymbol !== 'string') {
    throw new Error('Canonical option quote requires valid contractSymbol');
  }
  if (typeof input.price !== 'number' || !Number.isFinite(input.price) || input.price <= 0) {
    throw new Error(`Canonical option quote requires positive finite price, got: ${input.price}`);
  }
  if (
    !input.providerId ||
    typeof input.providerId !== 'string' ||
    input.providerId.trim().length === 0
  ) {
    throw new Error('Canonical option quote requires non-empty authenticated providerId');
  }
  if (
    typeof input.connectionEpoch !== 'number' ||
    !Number.isFinite(input.connectionEpoch) ||
    input.connectionEpoch <= 0
  ) {
    throw new Error(
      `Canonical option quote requires positive connectionEpoch, got: ${input.connectionEpoch}`,
    );
  }
  if (
    !input.providerInstanceId ||
    typeof input.providerInstanceId !== 'string' ||
    input.providerInstanceId.trim().length === 0
  ) {
    throw new Error('Canonical option quote requires non-empty providerInstanceId');
  }
  if (
    !input.providerConnectionId ||
    typeof input.providerConnectionId !== 'string' ||
    input.providerConnectionId.trim().length === 0
  ) {
    throw new Error('Canonical option quote requires non-empty providerConnectionId');
  }
  if (
    input.providerTransport !== 'WEBSOCKET_STREAM' &&
    input.providerTransport !== 'REST_POLLING'
  ) {
    throw new Error(
      `Canonical option quote requires explicit providerTransport, got: ${input.providerTransport}`,
    );
  }

  const tsValidation = validateExecutionQuoteTimestamp(input.marketEventTime, Date.now());
  if (!tsValidation.valid) {
    throw new Error(`Canonical option quote timestamp rejected: ${tsValidation.reason}`);
  }
}

/**
 * Sealed brander. Requires BOTH a branded validated provider event (produced only by a
 * provider-specific validator) and a branded provider connection identity. The
 * connection identity supplies epoch / instance / connection id, so callers cannot
 * inject arbitrary connection primitives.
 */
function brandCanonicalOptionProviderTick(
  event: ValidatedOptionProviderEvent,
  connection: ProviderConnectionIdentity,
): ValidatedCanonicalOptionProviderTick {
  if (!isValidatedOptionProviderEvent(event)) {
    throw new Error(
      '[UNBRANDED_PROVIDER_EVENT_REJECTED] Canonical execution tick requires a validated provider event from a provider-specific validator',
    );
  }
  if (!isProviderConnectionIdentity(connection)) {
    throw new Error(
      '[UNBRANDED_CONNECTION_IDENTITY_REJECTED] Canonical execution tick requires a branded provider connection identity',
    );
  }
  if (event.providerId !== connection.providerId) {
    throw new Error(
      `[PROVIDER_CONNECTION_IDENTITY_MISMATCH] Validated provider event providerId ${event.providerId} does not match branded connection providerId ${connection.providerId}`,
    );
  }
  const now = Date.now();
  const canonicalInput: ICanonicalOptionProviderTickInput = {
    contractSymbol: event.contractSymbol,
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

  validateCanonicalProviderTickInput(canonicalInput);

  return new SealedCanonicalOptionProviderTick(CANONICAL_TICK_CREATION_SEAL, canonicalInput);
}

export interface IOptionProviderAdapter {
  readonly providerId: string;
  readonly providerTransport: CanonicalProviderTransport;
  beginProviderConnection(options?: {
    readonly providerInstanceId?: string;
    readonly existingConnection?: ProviderConnectionIdentity;
  }): ProviderConnectionIdentity;
  getCurrentProviderConnection(): ProviderConnectionIdentity | null;
  validateProviderEvent(raw: RawOptionProviderEvent): ValidatedOptionProviderEvent;
  toCanonicalExecutionTick(
    raw: RawOptionProviderEvent,
    connectionGuard?: ProviderConnectionIdentity,
  ): ValidatedCanonicalOptionProviderTick;
  resetForTests(): void;
}

function createOptionProviderAdapter(
  validator: IOptionProviderValidator,
): IOptionProviderAdapter {
  if (!validator || typeof validator.validate !== 'function') {
    throw new Error('Provider adapter requires a provider-specific validator');
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
        if (
          normalizeCanonicalProviderId(options.existingConnection.providerId) !== normalizeCanonicalProviderId(validator.providerId) ||
          options.existingConnection.providerTransport !== validator.providerTransport
        ) {
          throw new Error(
            `[INVALID_SHARED_CONNECTION_IDENTITY] Existing connection providerId '${options.existingConnection.providerId}' or transport '${options.existingConnection.providerTransport}' does not match adapter provider '${validator.providerId}' (${validator.providerTransport})`,
          );
        }
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
    validateProviderEvent(raw: RawOptionProviderEvent): ValidatedOptionProviderEvent {
      return validator.validate(raw);
    },
    toCanonicalExecutionTick(
      raw: RawOptionProviderEvent,
      connectionGuard?: ProviderConnectionIdentity,
    ): ValidatedCanonicalOptionProviderTick {
      if (!currentConnection) {
        throw new Error(
          '[PROVIDER_CONNECTION_REQUIRED] Provider adapter must have a current provider connection before minting canonical ticks',
        );
      }
      if (connectionGuard !== undefined) {
        if (!isProviderConnectionIdentity(connectionGuard)) {
          throw new Error(
            '[UNBRANDED_CONNECTION_IDENTITY_REJECTED] Provider adapter rejected a fabricated provider connection identity',
          );
        }
        if (connectionGuard !== currentConnection) {
          throw new Error(
            '[STALE_PROVIDER_CONNECTION_REJECTED] Provider adapter rejected a non-current provider connection identity',
          );
        }
      }
      const validated = validator.validate(raw);
      if (!isValidatedOptionProviderEvent(validated)) {
        throw new Error(
          '[PROVIDER_ADAPTER_INTEGRITY] Provider validator did not yield a branded validated event',
        );
      }
      return brandCanonicalOptionProviderTick(validated, currentConnection);
    },
    resetForTests(): void {
      connectionEpoch = 0;
      currentConnection = null;
    },
  });
}

export const NSE_STREAM_OPTION_PROVIDER_ADAPTER = createOptionProviderAdapter(
  NSE_STREAM_OPTION_PROVIDER_VALIDATOR,
);

export const NSE_REST_OPTION_PROVIDER_ADAPTER = createOptionProviderAdapter(
  NSE_REST_OPTION_PROVIDER_VALIDATOR,
);

export const BINANCE_OPTION_PROVIDER_ADAPTER = createOptionProviderAdapter(
  BINANCE_OPTION_PROVIDER_VALIDATOR,
);

export const NSE_YAHOO_REST_PROVIDER_ADAPTER = createOptionProviderAdapter(
  NSE_YAHOO_REST_PROVIDER_VALIDATOR,
);

export const BINANCE_REST_PROVIDER_ADAPTER = createOptionProviderAdapter(
  BINANCE_REST_PROVIDER_VALIDATOR,
);

export function resetAllOptionProviderAdaptersForTests(): void {
  NSE_STREAM_OPTION_PROVIDER_ADAPTER.resetForTests();
  NSE_REST_OPTION_PROVIDER_ADAPTER.resetForTests();
  BINANCE_OPTION_PROVIDER_ADAPTER.resetForTests();
  NSE_YAHOO_REST_PROVIDER_ADAPTER.resetForTests();
  BINANCE_REST_PROVIDER_ADAPTER.resetForTests();
}

