import { AlternativeDataState } from './quant-types';

export interface IAlternativeDataInputs {
  symbol: string;
  indiaVix?: number;
  putCallRatio?: number;
  openInterestChangePct?: number;
  marketAdvanceDeclineRatio?: number;
  cryptoFundingRate?: number;
  cryptoOpenInterest?: number;
  btcDominance?: number;
  timestamp?: Date;
}

export class AlternativeDataEngine {
  private static cachedData: Map<string, { data: AlternativeDataState; receivedAt: number }> =
    new Map();

  /**
   * Registers latest alternative market data feed for a symbol.
   */
  public static updateData(inputs: IAlternativeDataInputs): AlternativeDataState {
    const sym = inputs.symbol.toUpperCase();
    const now = Date.now();
    const ts = inputs.timestamp || new Date(now);

    let vixPct = 50;
    if (inputs.indiaVix !== undefined) {
      // Historical India VIX range roughly 10 (low) to 28 (high)
      vixPct = Math.max(0, Math.min(100, Math.round(((inputs.indiaVix - 10) / 18) * 100)));
    }

    const state: AlternativeDataState = {
      indiaVix: inputs.indiaVix,
      vixPercentile: vixPct,
      putCallRatio: inputs.putCallRatio,
      openInterestChangePct: inputs.openInterestChangePct,
      marketAdvanceDeclineRatio: inputs.marketAdvanceDeclineRatio,
      cryptoFundingRate: inputs.cryptoFundingRate,
      cryptoOpenInterest: inputs.cryptoOpenInterest,
      btcDominance: inputs.btcDominance,
      isStale: false,
      timestamp: ts,
    };

    this.cachedData.set(sym, { data: state, receivedAt: now });
    return state;
  }

  /**
   * Retrieves alternative market data for a symbol with staleness checking (30 minute TTL).
   */
  public static getData(
    symbol: string,
    asOfTimestamp?: Date,
    maxLatencyMs = 30 * 60 * 1000,
  ): AlternativeDataState {
    const sym = symbol.toUpperCase();
    const cached = this.cachedData.get(sym);
    const ts = asOfTimestamp || (cached ? cached.data.timestamp : new Date(0));

    if (!cached) {
      // Return default neutral point-in-time state
      const isCrypto = sym.includes('BTC') || sym.includes('ETH') || sym.includes('USDT');
      return {
        indiaVix: isCrypto ? undefined : 14.5,
        vixPercentile: 45,
        putCallRatio: isCrypto ? undefined : 1.05,
        openInterestChangePct: 0.0,
        marketAdvanceDeclineRatio: 1.1,
        cryptoFundingRate: isCrypto ? 0.0001 : undefined,
        cryptoOpenInterest: isCrypto ? 15000000000 : undefined,
        btcDominance: isCrypto ? 54.2 : undefined,
        isStale: false,
        timestamp: ts,
      };
    }

    const age = ts.getTime() - cached.receivedAt;
    const isStale = age > maxLatencyMs;

    return {
      ...cached.data,
      isStale,
      timestamp: ts,
    };
  }
}
