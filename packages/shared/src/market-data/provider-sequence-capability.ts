/**
 * Formal Provider Capabilities Registry
 *
 * Encodes formal provider capability groups:
 * - Sequence Capabilities (ordering, scoping, reconnect policies)
 * - Volume Capabilities (support for session volume, bucket cumulative, incremental)
 * - Session Capabilities (24/7 continuous vs exchange session calendar)
 */
export type SequenceScope = 'CONNECTION_SCOPED' | 'PROVIDER_SCOPED' | 'GLOBALLY_MONOTONIC' | 'NONE';

export interface ProviderSequenceCapabilities {
  readonly scope: SequenceScope;
  readonly resetOnReconnect: boolean;
  readonly supportsSequenceNumber: boolean;
}

export interface ProviderVolumeCapabilities {
  readonly supportsSessionVolume: boolean;
  readonly supportsBucketCumulative: boolean;
  readonly supportsIncremental: boolean;
}

export interface ProviderSessionCapabilities {
  readonly isContinuous247: boolean;
  readonly requiresVenueCalendar: boolean;
}

export interface ProviderCapabilities {
  readonly providerId: string;
  readonly sequence: ProviderSequenceCapabilities;
  readonly volume: ProviderVolumeCapabilities;
  readonly session: ProviderSessionCapabilities;
}

// Backwards-compatibility alias
export type ProviderSequencePolicy = ProviderCapabilities;

export class ProviderIdentityNormalizer {
  private static canonicalAliases: Record<string, string> = {
    BINANCE: 'BINANCE_REALTIME',
    BINANCE_REALTIME: 'BINANCE_REALTIME',
    BINANCE_WS: 'BINANCE_REALTIME',
    'BINANCE-1': 'BINANCE_REALTIME',
    NSE: 'NSE_TRUE_DATA',
    NSE_TRUE_DATA: 'NSE_TRUE_DATA',
    NSE_REALTIME: 'NSE_TRUE_DATA',
    NSE_LIVE: 'NSE_TRUE_DATA',
    COMEX: 'COMEX_GOLD',
    COMEX_GOLD: 'COMEX_GOLD',
    GOLD: 'COMEX_GOLD',
    YAHOO: 'YAHOO_FINANCE',
    YAHOO_FINANCE: 'YAHOO_FINANCE',
    REST_BOOTSTRAP: 'REST_BOOTSTRAP',
    UNKNOWN_PROVIDER: 'UNKNOWN_PROVIDER',
    UNKNOWN_SOURCE: 'UNKNOWN_PROVIDER',
  };

  public static registerAlias(rawAlias: string, canonicalId: string): void {
    if (rawAlias && canonicalId) {
      this.canonicalAliases[rawAlias.toUpperCase().trim()] = canonicalId.toUpperCase().trim();
    }
  }

  public static toCanonicalId(providerId?: string): string {
    if (!providerId || providerId.trim() === '') {
      return 'UNKNOWN_PROVIDER';
    }
    const key = providerId.toUpperCase().trim();
    if (this.canonicalAliases[key]) {
      return this.canonicalAliases[key];
    }
    if (key.startsWith('BINANCE')) return 'BINANCE_REALTIME';
    if (key.startsWith('NSE')) return 'NSE_TRUE_DATA';
    if (key.startsWith('COMEX') || key.startsWith('GOLD')) return 'COMEX_GOLD';
    if (key.startsWith('YAHOO')) return 'YAHOO_FINANCE';
    return 'UNKNOWN_PROVIDER';
  }
}

export class ProviderSequenceCapabilityRegistry {
  private static capabilities: Record<string, ProviderCapabilities> = {
    BINANCE_REALTIME: {
      providerId: 'BINANCE_REALTIME',
      sequence: {
        scope: 'CONNECTION_SCOPED',
        resetOnReconnect: true,
        supportsSequenceNumber: true,
      },
      volume: {
        supportsSessionVolume: false,
        supportsBucketCumulative: true,
        supportsIncremental: true,
      },
      session: {
        isContinuous247: true,
        requiresVenueCalendar: false,
      },
    },
    NSE_TRUE_DATA: {
      providerId: 'NSE_TRUE_DATA',
      sequence: {
        scope: 'CONNECTION_SCOPED',
        resetOnReconnect: true,
        supportsSequenceNumber: true,
      },
      volume: {
        supportsSessionVolume: true,
        supportsBucketCumulative: true,
        supportsIncremental: true,
      },
      session: {
        isContinuous247: false,
        requiresVenueCalendar: true,
      },
    },
    COMEX_GOLD: {
      providerId: 'COMEX_GOLD',
      sequence: {
        scope: 'CONNECTION_SCOPED',
        resetOnReconnect: true,
        supportsSequenceNumber: true,
      },
      volume: {
        supportsSessionVolume: true,
        supportsBucketCumulative: true,
        supportsIncremental: true,
      },
      session: {
        isContinuous247: false,
        requiresVenueCalendar: true,
      },
    },
    YAHOO_FINANCE: {
      providerId: 'YAHOO_FINANCE',
      sequence: {
        scope: 'NONE',
        resetOnReconnect: true,
        supportsSequenceNumber: false,
      },
      volume: {
        supportsSessionVolume: false,
        supportsBucketCumulative: true,
        supportsIncremental: true,
      },
      session: {
        isContinuous247: false,
        requiresVenueCalendar: true,
      },
    },
    UNKNOWN_PROVIDER: {
      providerId: 'UNKNOWN_PROVIDER',
      sequence: {
        scope: 'NONE',
        resetOnReconnect: true,
        supportsSequenceNumber: false,
      },
      volume: {
        supportsSessionVolume: false,
        supportsBucketCumulative: false,
        supportsIncremental: false,
      },
      session: {
        isContinuous247: false,
        requiresVenueCalendar: true,
      },
    },
    REST_BOOTSTRAP: {
      providerId: 'REST_BOOTSTRAP',
      sequence: {
        scope: 'NONE',
        resetOnReconnect: true,
        supportsSequenceNumber: false,
      },
      volume: {
        supportsSessionVolume: false,
        supportsBucketCumulative: true,
        supportsIncremental: false,
      },
      session: {
        isContinuous247: false,
        requiresVenueCalendar: true,
      },
    },
  };

  /**
   * Registers custom provider capabilities from adapter definitions.
   */
  public static registerCapabilities(capabilities: ProviderCapabilities): void {
    if (capabilities && capabilities.providerId) {
      const key = capabilities.providerId.toUpperCase().trim();
      this.capabilities[key] = capabilities;
      ProviderIdentityNormalizer.registerAlias(key, key);
    }
  }

  /**
   * Retrieves formal provider capabilities for a given canonical provider identifier.
   * Exact lookup & Canonical resolution via ProviderIdentityNormalizer.
   * Fails closed to UNKNOWN_PROVIDER when provider identifier is missing or unknown.
   */
  public static getPolicy(providerId?: string): ProviderCapabilities {
    const canonicalId = ProviderIdentityNormalizer.toCanonicalId(providerId);
    return this.capabilities[canonicalId] || this.capabilities['UNKNOWN_PROVIDER'];
  }
}
