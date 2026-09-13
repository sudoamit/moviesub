import { MarketDataSourceMode } from '../enums';
import { DataProvenance } from '../interfaces';

export interface ISourceResolutionContext {
  hasLiveFeed: boolean;
  symbol: string;
  isRangeQuery?: boolean;
  asOfTimestamp?: Date;
  timeframeDurationMs?: number;
  providerId?: string;
}

export interface ISourceResolutionResult {
  useLiveFeed: boolean;
  useDatabase: boolean;
  dataProvenance: DataProvenance;
  sourceIdentity: string;
}

export class MarketDataSourcePolicy {
  /**
   * Authoritative resolution of market data source policy.
   * Strictly enforces fail-closed behavior for live trading/decisions.
   */
  static resolveSource(
    mode: MarketDataSourceMode,
    context: ISourceResolutionContext,
  ): ISourceResolutionResult {
    const symbol = context.symbol.toUpperCase();
    const getIdentity = (defaultLive: string, defaultDb: string): string => {
      if (context.providerId) return context.providerId;
      if (context.hasLiveFeed) return defaultLive;
      return defaultDb;
    };

    if (mode === MarketDataSourceMode.LIVE_DECISION) {
      if (context.isRangeQuery) {
        throw new Error(
          `[MARKET DATA FAIL-CLOSED] Range queries ('from' / 'to') are incompatible with LIVE_DECISION mode for '${symbol}'. Use HISTORICAL or BACKTEST mode for historical intervals.`,
        );
      }

      if (context.asOfTimestamp) {
        const asOfMs = new Date(context.asOfTimestamp).getTime();
        const serverNow = Date.now();
        const bufferMs = (context.timeframeDurationMs || 15 * 60 * 1000) * 2;
        if (serverNow - asOfMs > bufferMs) {
          throw new Error(
            `[LIVE_DECISION AS-OF REJECTED] LIVE_DECISION mode cannot be queried with a historical asOfTimestamp (${new Date(asOfMs).toISOString()}). Use BACKTEST or HISTORICAL mode for historical point-in-time evaluations.`,
          );
        }
      }

      if (!context.hasLiveFeed) {
        throw new Error(
          `[MARKET DATA FAIL-CLOSED] Authoritative live exchange stream unavailable for '${symbol}'. Under LIVE_DECISION policy, silent DB or synthetic fallback is strictly prohibited.`,
        );
      }

      const liveIdentity = symbol.includes('USDT') ? 'BINANCE_SPOT' : symbol === 'XAUUSD' || symbol === 'GOLD' ? 'COMEX_GOLD_STREAM' : 'NSE_LIVE_STREAM';
      return { useLiveFeed: true, useDatabase: false, dataProvenance: 'LIVE', sourceIdentity: getIdentity(liveIdentity, 'DB_CANONICAL_STORE') };
    }

    if (mode === MarketDataSourceMode.CHART) {
      if (context.isRangeQuery) {
        return { useLiveFeed: false, useDatabase: true, dataProvenance: 'HISTORICAL', sourceIdentity: getIdentity('NSE_LIVE_STREAM', 'DB_HISTORICAL_STORE') };
      }
      if (context.hasLiveFeed) {
        const liveIdentity = symbol.includes('USDT') ? 'BINANCE_SPOT' : symbol === 'XAUUSD' || symbol === 'GOLD' ? 'COMEX_GOLD_STREAM' : 'NSE_LIVE_STREAM';
        return { useLiveFeed: true, useDatabase: false, dataProvenance: 'LIVE', sourceIdentity: getIdentity(liveIdentity, 'DB_CANONICAL_STORE') };
      }
      return { useLiveFeed: false, useDatabase: true, dataProvenance: 'DELAYED', sourceIdentity: getIdentity('LIVE_STREAM', 'DB_DELAYED_CACHE') };
    }

    if (mode === MarketDataSourceMode.BACKTEST) {
      return { useLiveFeed: false, useDatabase: true, dataProvenance: 'BACKTEST', sourceIdentity: getIdentity('SIMULATION_STREAM', 'BACKTEST_ENGINE_DB') };
    }

    if (mode === MarketDataSourceMode.LEARNING) {
      return { useLiveFeed: false, useDatabase: true, dataProvenance: 'LEARNING', sourceIdentity: getIdentity('LEARNING_STREAM', 'LEARNING_ENGINE_DB') };
    }

    // Default to HISTORICAL
    return { useLiveFeed: false, useDatabase: true, dataProvenance: 'HISTORICAL', sourceIdentity: getIdentity('HISTORICAL_FEED', 'DB_HISTORICAL_STORE') };
  }

  static validate(
    mode: MarketDataSourceMode,
    hasLiveFeed: boolean,
    symbol: string,
    asOfTimestamp?: Date,
    timeframeDurationMs?: number,
  ): ISourceResolutionResult {
    return this.resolveSource(mode, {
      hasLiveFeed,
      symbol,
      asOfTimestamp,
      timeframeDurationMs,
    });
  }

  static assertAllowedSource(mode: MarketDataSourceMode, source: string): void {
    if (mode === MarketDataSourceMode.LIVE_DECISION && source !== 'LIVE') {
      throw new Error(`[MARKET DATA FAIL-CLOSED] Source '${source}' is prohibited under LIVE_DECISION.`);
    }
    if (mode === MarketDataSourceMode.BACKTEST && source === 'LIVE') {
      throw new Error(`[MARKET DATA FAIL-CLOSED] Live feed is prohibited under BACKTEST mode.`);
    }
    if (mode === MarketDataSourceMode.LEARNING && source === 'LIVE') {
      throw new Error(`[MARKET DATA FAIL-CLOSED] Live feed is prohibited under LEARNING mode.`);
    }
  }
}
