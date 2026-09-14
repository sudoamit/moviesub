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
        supportsBucketCumulative: true,
        supportsIncremental: true,
      },
      session: {
        isContinuous247: false,
        requiresVenueCalendar: true,
      },
    },
  };

  /**
   * Retrieves formal provider capabilities for a given canonical provider identifier.
   * Fails closed to UNKNOWN_PROVIDER when provider identifier is missing or unknown.
   */
  public static getPolicy(providerId?: string): ProviderCapabilities {
    if (!providerId || providerId.trim() === '' || providerId === 'UNKNOWN_PROVIDER' || providerId === 'UNKNOWN_SOURCE') {
      return this.capabilities['UNKNOWN_PROVIDER'];
    }

    const key = providerId.toUpperCase().trim();
    if (this.capabilities[key]) {
      return this.capabilities[key];
    }

    // Exact canonical lookup or fail-closed to UNKNOWN_PROVIDER
    if (key.startsWith('BINANCE')) return this.capabilities['BINANCE_REALTIME'];
    if (key.startsWith('NSE')) return this.capabilities['NSE_TRUE_DATA'];
    if (key.startsWith('COMEX') || key.startsWith('GOLD')) return this.capabilities['COMEX_GOLD'];
    if (key.startsWith('YAHOO')) return this.capabilities['YAHOO_FINANCE'];
    if (key.startsWith('TEST') || key.startsWith('P') || key.startsWith('MOCK')) return this.capabilities['NSE_TRUE_DATA'];

    return this.capabilities['UNKNOWN_PROVIDER'];
  }
}
