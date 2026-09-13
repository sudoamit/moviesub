import { MarketDataSourceMode } from '../enums';
import { DataProvenance } from '../interfaces';

export interface ISourceResolutionContext {
  hasLiveFeed: boolean;
  symbol: string;
  isRangeQuery?: boolean;
  asOfTimestamp?: Date;
  timeframeDurationMs?: number;
}

export interface ISourceResolutionResult {
  useLiveFeed: boolean;
  useDatabase: boolean;
  dataProvenance: DataProvenance;
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

      return { useLiveFeed: true, useDatabase: false, dataProvenance: 'LIVE' };
    }

    if (mode === MarketDataSourceMode.CHART) {
      if (context.isRangeQuery) {
        return { useLiveFeed: false, useDatabase: true, dataProvenance: 'HISTORICAL' };
      }
      if (context.hasLiveFeed) {
        return { useLiveFeed: true, useDatabase: false, dataProvenance: 'LIVE' };
      }
      return { useLiveFeed: false, useDatabase: true, dataProvenance: 'DELAYED' };
    }

    if (mode === MarketDataSourceMode.BACKTEST) {
      return { useLiveFeed: false, useDatabase: true, dataProvenance: 'BACKTEST' };
    }

    if (mode === MarketDataSourceMode.LEARNING) {
      return { useLiveFeed: false, useDatabase: true, dataProvenance: 'LEARNING' };
    }

    // Default to HISTORICAL
    return { useLiveFeed: false, useDatabase: true, dataProvenance: 'HISTORICAL' };
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
