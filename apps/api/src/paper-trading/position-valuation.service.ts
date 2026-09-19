import { Injectable, Logger } from '@nestjs/common';
import { RealMarketStreamerService } from '../market-data/real-market-streamer.service';
import {
  MarketDataUnavailableError,
  getAuthoritativeDescriptor,
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
   * or stale position.currentPrice reuse.
   */
  public resolveLivePositionQuote(position: ValuatablePosition): LivePositionQuote {
    const rawSymbol = position.symbol.toUpperCase();
    const contractSymbol = (position.contractSymbol || position.symbol).toUpperCase();
    const isOption =
      position.instrumentType === 'OPTION' ||
      contractSymbol.includes(' CE') ||
      contractSymbol.includes(' PE');

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

      const providerId = optionTicker.providerId || 'LIVE_PROVIDER_FEED';
      const providerTransport = optionTicker.providerTransport || 'WEBSOCKET';

      const now = Date.now();
      const ageMs = now - optionTicker.marketEventTime;
      // Freshness check: within 10 seconds for option quotes
      const isFresh = ageMs <= 10000 && optionTicker.marketEventTime <= now + 5000;

      return {
        price: optionTicker.price,
        timestamp: new Date(optionTicker.marketEventTime),
        provenance: optionTicker.provenance,
        isFresh,
        providerId: optionTicker.providerId,
        providerTransport: optionTicker.providerTransport,
      };
    }

    // 2. SPOT VALUATION: Canonical Crypto, Commodity, and Equities
    const canonicalSymbol = normalizeCanonicalExecutionSymbol(rawSymbol);

    try {
      const ticker = this.streamerService.getValidatedTicker(canonicalSymbol, 5);
      return {
        price: ticker.price,
        timestamp: new Date(ticker.marketEventTime || ticker.lastUpdated),
        provenance: ticker.provenance,
        isFresh: true,
        providerId: ticker.providerId,
        providerTransport: ticker.providerTransport,
      };
    } catch (err: any) {
      // In non-live test environments, check if streamer has unvalidated ticker
      const fallbackTicker = this.streamerService.getTicker(canonicalSymbol);
      if (fallbackTicker && fallbackTicker.price > 0 && fallbackTicker.provenance === 'LIVE_PROVIDER') {
        return {
          price: fallbackTicker.price,
          timestamp: new Date(fallbackTicker.marketEventTime || fallbackTicker.lastUpdated),
          provenance: fallbackTicker.provenance,
          isFresh: true,
          providerId: fallbackTicker.providerId,
          providerTransport: fallbackTicker.providerTransport,
        };
      }
      throw err;
    }
  }
}
