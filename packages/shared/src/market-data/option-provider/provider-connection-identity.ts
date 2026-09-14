import * as crypto from 'crypto';

/**
 * AI FIX 156 — Provider connection identity authority.
 *
 * A ProviderConnectionIdentity is a branded, immutable descriptor of one concrete
 * provider connection lifecycle. It can only be minted through
 * `mintProviderConnectionIdentity`, which assigns a fresh RFC-4122 UUID
 * `providerConnectionId` per actual provider connection — never a derived
 * `instance:epoch` string.
 */

const BRANDED_PROVIDER_CONNECTION_IDENTITIES = new WeakSet<object>();
const CONNECTION_IDENTITY_CREATION_SEAL: unique symbol = Symbol(
  'quant.provider.connection.identity.seal',
);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isProviderConnectionIdUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export interface IProviderConnectionIdentityInit {
  readonly providerId: string;
  readonly providerInstanceId: string;
  readonly connectionEpoch: number;
  readonly providerConnectionId?: string;
}

interface ISealedProviderConnectionIdentityConstructor {
  new (seal: symbol, init: IProviderConnectionIdentityInit): ProviderConnectionIdentity;
}

export class ProviderConnectionIdentity {
  public readonly providerId: string;
  public readonly providerInstanceId: string;
  public readonly providerConnectionId: string;
  public readonly connectionEpoch: number;

  private constructor(seal: symbol, init: IProviderConnectionIdentityInit) {
    if (seal !== CONNECTION_IDENTITY_CREATION_SEAL) {
      throw new Error(
        '[UNBRANDED_CONNECTION_IDENTITY_REJECTED] ProviderConnectionIdentity cannot be constructed outside mintProviderConnectionIdentity()',
      );
    }

    const providerId = typeof init?.providerId === 'string' ? init.providerId.trim() : '';
    if (providerId.length === 0) {
      throw new Error('ProviderConnectionIdentity requires a non-empty providerId');
    }

    const providerInstanceId =
      typeof init.providerInstanceId === 'string' ? init.providerInstanceId.trim() : '';
    if (providerInstanceId.length === 0) {
      throw new Error('ProviderConnectionIdentity requires a non-empty providerInstanceId');
    }

    if (
      typeof init.connectionEpoch !== 'number' ||
      !Number.isFinite(init.connectionEpoch) ||
      init.connectionEpoch <= 0
    ) {
      throw new Error(
        `ProviderConnectionIdentity requires a positive finite connectionEpoch, got: ${init.connectionEpoch}`,
      );
    }

    const providerConnectionId = init.providerConnectionId ?? crypto.randomUUID();
    if (!isProviderConnectionIdUuid(providerConnectionId)) {
      throw new Error(
        `ProviderConnectionIdentity requires a unique UUID providerConnectionId, got: ${providerConnectionId}`,
      );
    }

    this.providerId = providerId;
    this.providerInstanceId = providerInstanceId;
    this.providerConnectionId = providerConnectionId;
    this.connectionEpoch = init.connectionEpoch;

    BRANDED_PROVIDER_CONNECTION_IDENTITIES.add(this);
    Object.freeze(this);
  }
}

const SealedProviderConnectionIdentity =
  ProviderConnectionIdentity as unknown as ISealedProviderConnectionIdentityConstructor;

export function mintProviderConnectionIdentity(
  init: IProviderConnectionIdentityInit,
): ProviderConnectionIdentity {
  return new SealedProviderConnectionIdentity(CONNECTION_IDENTITY_CREATION_SEAL, init);
}

export function isProviderConnectionIdentity(
  value: unknown,
): value is ProviderConnectionIdentity {
  return (
    typeof value === 'object' &&
    value !== null &&
    BRANDED_PROVIDER_CONNECTION_IDENTITIES.has(value)
  );
}
