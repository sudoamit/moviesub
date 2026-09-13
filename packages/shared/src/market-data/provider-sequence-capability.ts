/**
 * Formal Provider Sequence & Watermark Capabilities Registry
 *
 * Encodes formal provider sequence scoping rules and reconnect behavior.
 */
export type SequenceScope = 'CONNECTION_SCOPED' | 'PROVIDER_SCOPED' | 'GLOBALLY_MONOTONIC' | 'NONE';

export interface ProviderSequencePolicy {
  readonly scope: SequenceScope;
  readonly resetOnReconnect: boolean;
  readonly supportsSequenceNumber: boolean;
  readonly supportsSessionVolume: boolean;
}

export class ProviderSequenceCapabilityRegistry {
  private static policies: Record<string, ProviderSequencePolicy> = {
    BINANCE: {
      scope: 'CONNECTION_SCOPED',
      resetOnReconnect: true,
      supportsSequenceNumber: true,
      supportsSessionVolume: false,
    },
    NSE_TRUE_DATA: {
      scope: 'CONNECTION_SCOPED',
      resetOnReconnect: true,
      supportsSequenceNumber: true,
      supportsSessionVolume: true,
    },
    COMEX_GOLD: {
      scope: 'CONNECTION_SCOPED',
      resetOnReconnect: true,
      supportsSequenceNumber: true,
      supportsSessionVolume: true,
    },
    UNKNOWN_PROVIDER: {
      scope: 'NONE',
      resetOnReconnect: true,
      supportsSequenceNumber: false,
      supportsSessionVolume: false,
    },
  };

  /**
   * Retrieves sequence capability policy for a given provider identifier.
   */
  public static getPolicy(providerId?: string): ProviderSequencePolicy {
    if (!providerId || providerId.trim() === '' || providerId === 'UNKNOWN_PROVIDER') {
      return this.policies['UNKNOWN_PROVIDER'];
    }

    const key = providerId.toUpperCase().trim();
    if (this.policies[key]) {
      return this.policies[key];
    }

    if (key.includes('BINANCE')) return this.policies['BINANCE'];
    if (key.includes('NSE') || key.includes('INDIA')) return this.policies['NSE_TRUE_DATA'];
    if (key.includes('COMEX') || key.includes('METALS')) return this.policies['COMEX_GOLD'];

    // Default unknown policy
    return {
      scope: 'CONNECTION_SCOPED',
      resetOnReconnect: true,
      supportsSequenceNumber: false,
      supportsSessionVolume: false,
    };
  }
}
