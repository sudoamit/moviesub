import { Injectable, Logger } from '@nestjs/common';
import { RealMarketStreamerService } from '../market-data/real-market-streamer.service';
import {
  MarketDataUnavailableError,
  normalizeCanonicalExecutionSymbol,
} from '@quant/shared';

export interface LivePositionQuote {
  price: number;
  timestamp: Date;
  provenance: string;
  isFresh: boolean;
  providerId?: string;
  providerTransport?: string;
}

export interface ValuatablePosition {
  id?: string;
  symbol: string;
  contractSymbol?: string | null;
  instrumentType?: string | null;
  currentPrice?: number | null;
}

@Injectable()
export class PositionValuationService {
  private readonly logger = new Logger(PositionValuationService.name);

  constructor(private readonly streamerService: RealMarketStreamerService) {}

  /**
   * Authoritative single valuation authority for active positions.
   * Strictly resolves live quotes without synthetic fallback, parent index fallback,
   * stale getTicker() fallback, or position.currentPrice reuse.
   * 
   * Strict fail-closed semantics: Throws MarketDataUnavailableError if quote is missing,
   * stale, non-positive, or from synthetic sources.
   */
  public resolveLivePositionQuote(position: ValuatablePosition): LivePositionQuote {
    const rawSymbol = position.symbol.toUpperCase();
    const contractSymbol = (position.contractSymbol || position.symbol).toUpperCase();
    const isOption =
      position.instrumentType === 'OPTION' ||
      contractSymbol.includes(' CE') ||
      contractSymbol.includes(' PE');

    const now = Date.now();

    // 1. OPTION VALUATION: Exact contract quote via getOptionTicker
    if (isOption) {
      const optionTicker = this.streamerService.getOptionTicker(contractSymbol);
      if (!optionTicker) {
        throw new MarketDataUnavailableError(
          contractSymbol,
          `[OPTION_QUOTE_UNAVAILABLE] No authoritative live option quote found for contract '${contractSymbol}'. Derivative positions cannot execute or value using synthetic premiums or parent underlying fallback.`,
        );
      }

      if (optionTicker.price <= 0) {
        throw new MarketDataUnavailableError(
          contractSymbol,
          `[INVALID_OPTION_PRICE] Authoritative quote for contract '${contractSymbol}' has non-positive price: ${optionTicker.price}`,
        );
      }

      if (optionTicker.provenance !== 'LIVE_PROVIDER') {
        throw new MarketDataUnavailableError(
          contractSymbol,
          `[UNAUTHORITATIVE_OPTION_PROVENANCE] Authoritative quote for contract '${contractSymbol}' has invalid provenance '${optionTicker.provenance}'. Only 'LIVE_PROVIDER' is authorized.`,
        );
      }

      if (!optionTicker.marketEventTime || optionTicker.marketEventTime <= 0) {
        throw new MarketDataUnavailableError(
          contractSymbol,
          `[MISSING_OPTION_MARKET_TIME] Authoritative quote for contract '${contractSymbol}' is missing valid marketEventTime.`,
        );
      }

      const eventTime = optionTicker.marketEventTime;
      const ageMs = now - eventTime;

      // Freshness check: within 10 seconds for option quotes, future tolerance <= 5000ms
      if (ageMs > 10000 || eventTime > now + 5000) {
        throw new MarketDataUnavailableError(
          contractSymbol,
          `[STALE_OPTION_QUOTE] Authoritative quote for contract '${contractSymbol}' is stale or invalid (age: ${ageMs}ms, eventTime: ${eventTime}, now: ${now}). Execution rejected.`,
        );
      }

      return {
        price: optionTicker.price,
        timestamp: new Date(eventTime),
        provenance: optionTicker.provenance,
        isFresh: true,
        providerId: optionTicker.providerId,
        providerTransport: optionTicker.providerTransport,
      };
    }

    // 2. SPOT VALUATION: Canonical Crypto, Commodity, and Equities
    const canonicalSymbol = normalizeCanonicalExecutionSymbol(rawSymbol);

    try {
      const ticker = this.streamerService.getValidatedTicker(canonicalSymbol, 5);
      if (!ticker || ticker.price <= 0) {
        throw new MarketDataUnavailableError(
          canonicalSymbol,
          `[INVALID_SPOT_PRICE] Authoritative spot quote for '${canonicalSymbol}' has non-positive price.`,
        );
      }

      if (ticker.provenance !== 'LIVE_PROVIDER') {
        throw new MarketDataUnavailableError(
          canonicalSymbol,
          `[UNAUTHORITATIVE_SPOT_PROVENANCE] Authoritative spot quote for '${canonicalSymbol}' has invalid provenance '${ticker.provenance}'. Only 'LIVE_PROVIDER' is authorized.`,
        );
      }

      const eventTime = ticker.marketEventTime || ticker.lastUpdated;
      if (!eventTime || eventTime <= 0) {
        throw new MarketDataUnavailableError(
          canonicalSymbol,
          `[MISSING_SPOT_MARKET_TIME] Authoritative quote for '${canonicalSymbol}' is missing valid marketEventTime.`,
        );
      }

      const ageMs = now - eventTime;
      if (ageMs > 10000 || eventTime > now + 5000) {
        throw new MarketDataUnavailableError(
          canonicalSymbol,
          `[STALE_SPOT_QUOTE] Authoritative quote for '${canonicalSymbol}' is stale (age: ${ageMs}ms, eventTime: ${eventTime}, now: ${now}). Execution rejected.`,
        );
      }

      return {
        price: ticker.price,
        timestamp: new Date(eventTime),
        provenance: ticker.provenance,
        isFresh: true,
        providerId: ticker.providerId,
        providerTransport: ticker.providerTransport,
      };
    } catch (err: any) {
      if (err instanceof MarketDataUnavailableError) {
        throw err;
      }
      throw new MarketDataUnavailableError(
        canonicalSymbol,
        `[SPOT_QUOTE_UNAVAILABLE] Failed to resolve validated spot quote for '${canonicalSymbol}': ${err.message}`,
      );
    }
  }

  /**
   * Separate non-authoritative informational method strictly for UI display of stale/historical marks.
   * NEVER use on execution, close, TP/SL, or portfolio margin paths.
   */
  public getInformationalPositionMark(position: ValuatablePosition): LivePositionQuote {
    try {
      return this.resolveLivePositionQuote(position);
    } catch (err: any) {
      return {
        price: Number(position.currentPrice || 0),
        timestamp: new Date(),
        provenance: 'DEGRADED',
        isFresh: false,
      };
    }
  }
}
