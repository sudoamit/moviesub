import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import {
  IMarketDataSafetyDomainService,
  MarketDataSafetyConfig,
  MarketDataSource,
  MarketQuote,
  MarketQuoteValidationResult,
  QuoteUsageContext,
} from '@quant/shared';

@Injectable()
export class MarketDataSafetyService implements IMarketDataSafetyDomainService {
  private readonly logger = new Logger(MarketDataSafetyService.name);

  public static readonly DEFAULT_MAX_STALE_AGE_MS = 5000;
  public static readonly DEFAULT_MAX_CLOCK_SKEW_MS = 5000;
  public static readonly DEFAULT_MAX_FUTURE_SKEW_MS = 3000;

  private static readonly VALID_SOURCES = new Set<MarketDataSource>([
    'LIVE',
    'CACHE',
    'SIMULATION',
    'BACKTEST',
    'MANUAL',
  ]);

  /**
   * Detects clock drift between provider timestamp and server arrival timestamp
   */
  detectClockSkew(
    marketEventTime: number,
    receivedAt: number,
    maxClockSkewMs = MarketDataSafetyService.DEFAULT_MAX_CLOCK_SKEW_MS,
    maxFutureSkewMs = MarketDataSafetyService.DEFAULT_MAX_FUTURE_SKEW_MS,
  ): { isSkewed: boolean; skewMs: number; direction: 'AHEAD' | 'BEHIND' | 'IN_TOLERANCE' } {
    if (!Number.isFinite(marketEventTime) || !Number.isFinite(receivedAt)) {
      return { isSkewed: true, skewMs: Infinity, direction: 'BEHIND' };
    }

    const diff = marketEventTime - receivedAt;

    // Provider timestamp ahead of server arrival (claiming to be from the future)
    if (diff > maxFutureSkewMs) {
      return {
        isSkewed: true,
        skewMs: diff,
        direction: 'AHEAD',
      };
    }

    // Provider timestamp lagging severely behind server arrival
    if (receivedAt - marketEventTime > maxClockSkewMs) {
      return {
        isSkewed: true,
        skewMs: receivedAt - marketEventTime,
        direction: 'BEHIND',
      };
    }

    return {
      isSkewed: false,
      skewMs: Math.abs(diff),
      direction: 'IN_TOLERANCE',
    };
  }

  /**
   * Comprehensive validation of market quotes for risk, execution, or UI presentation
   */
  validateQuote(
    rawQuote: any,
    context: QuoteUsageContext,
    config?: MarketDataSafetyConfig,
    serverTimeMs = Date.now(),
  ): MarketQuoteValidationResult {
    if (!rawQuote || typeof rawQuote !== 'object') {
      return {
        isValid: false,
        isStale: false,
        isClockSkewed: false,
        ageMs: 0,
        skewMs: 0,
        rejectionCode: 'MISSING_FIELDS',
        rejectionReason: 'Quote object is null, undefined, or not an object',
        displayStatus: 'UNAVAILABLE',
      };
    }

    const maxStaleAgeMs = config?.maxStaleAgeMs ?? MarketDataSafetyService.DEFAULT_MAX_STALE_AGE_MS;
    const maxClockSkewMs =
      config?.maxClockSkewMs ?? MarketDataSafetyService.DEFAULT_MAX_CLOCK_SKEW_MS;
    const maxFutureSkewMs =
      config?.maxFutureSkewMs ?? MarketDataSafetyService.DEFAULT_MAX_FUTURE_SKEW_MS;
    const allowedSources = config?.allowedSourcesForExecution ?? ['LIVE'];

    // 1. Validate required canonical fields
    const symbol = String(rawQuote.symbol || '').trim().toUpperCase();
    if (!symbol) {
      return {
        isValid: false,
        isStale: false,
        isClockSkewed: false,
        ageMs: 0,
        skewMs: 0,
        rejectionCode: 'MISSING_FIELDS',
        rejectionReason: "Quote missing mandatory 'symbol'",
        displayStatus: 'UNAVAILABLE',
      };
    }

    const instrumentId = String(rawQuote.instrumentId || symbol).trim();

    const price = Number(rawQuote.price);
    if (!Number.isFinite(price) || price <= 0) {
      return {
        isValid: false,
        isStale: false,
        isClockSkewed: false,
        ageMs: 0,
        skewMs: 0,
        rejectionCode: 'INVALID_PRICE',
        rejectionReason: `Quote price must be a positive finite number (received: ${rawQuote.price})`,
        displayStatus: 'UNAVAILABLE',
      };
    }

    // Validate Bid & Ask (if not provided, default safely to price)
    const bid = rawQuote.bid !== undefined ? Number(rawQuote.bid) : price;
    const ask = rawQuote.ask !== undefined ? Number(rawQuote.ask) : price;

    if (!Number.isFinite(bid) || bid <= 0 || !Number.isFinite(ask) || ask <= 0) {
      return {
        isValid: false,
        isStale: false,
        isClockSkewed: false,
        ageMs: 0,
        skewMs: 0,
        rejectionCode: 'INVALID_PRICE',
        rejectionReason: `Bid (${bid}) and ask (${ask}) must be positive finite numbers`,
        displayStatus: 'UNAVAILABLE',
      };
    }

    // Crossed book check (bid > ask is an inverted/corrupted order book anomaly)
    if (bid > ask) {
      return {
        isValid: false,
        isStale: false,
        isClockSkewed: false,
        ageMs: 0,
        skewMs: 0,
        rejectionCode: 'CROSSED_BOOK',
        rejectionReason: `Crossed book detected: bid (${bid}) exceeds ask (${ask})`,
        displayStatus: 'DEGRADED',
      };
    }

    // Timestamps
    const marketEventTime =
      rawQuote.marketEventTime instanceof Date
        ? rawQuote.marketEventTime.getTime()
        : Number(rawQuote.marketEventTime);

    const receivedAt =
      rawQuote.receivedAt instanceof Date
        ? rawQuote.receivedAt.getTime()
        : rawQuote.receivedAt !== undefined
        ? Number(rawQuote.receivedAt)
        : serverTimeMs;

    if (!Number.isFinite(marketEventTime) || marketEventTime <= 0) {
      return {
        isValid: false,
        isStale: false,
        isClockSkewed: false,
        ageMs: 0,
        skewMs: 0,
        rejectionCode: 'MISSING_FIELDS',
        rejectionReason: `Invalid or missing 'marketEventTime' (${rawQuote.marketEventTime})`,
        displayStatus: 'UNAVAILABLE',
      };
    }

    const provider = String(rawQuote.provider || 'UNKNOWN').trim();
    if (!provider || provider === 'UNKNOWN') {
      return {
        isValid: false,
        isStale: false,
        isClockSkewed: false,
        ageMs: 0,
        skewMs: 0,
        rejectionCode: 'MISSING_FIELDS',
        rejectionReason: "Quote missing mandatory 'provider'",
        displayStatus: 'UNAVAILABLE',
      };
    }

    const source: MarketDataSource = String(rawQuote.source || '').toUpperCase() as MarketDataSource;
    if (!MarketDataSafetyService.VALID_SOURCES.has(source)) {
      return {
        isValid: false,
        isStale: false,
        isClockSkewed: false,
        ageMs: 0,
        skewMs: 0,
        rejectionCode: 'MISSING_FIELDS',
        rejectionReason: `Invalid quote source '${rawQuote.source}'. Must be one of: LIVE, CACHE, SIMULATION, BACKTEST, MANUAL`,
        displayStatus: 'UNAVAILABLE',
      };
    }

    const canonicalQuote: MarketQuote = {
      symbol,
      instrumentId,
      price,
      bid,
      ask,
      marketEventTime,
      receivedAt,
      provider,
      source,
      sequence: rawQuote.sequence !== undefined ? Number(rawQuote.sequence) : undefined,
      metadata: rawQuote.metadata,
    };

    // 2. Staleness Check
    const ageMs = serverTimeMs - marketEventTime;
    const isStale = ageMs > maxStaleAgeMs;

    // 3. Detect Clock Skew
    const skewResult = this.detectClockSkew(
      marketEventTime,
      receivedAt,
      maxClockSkewMs,
      maxFutureSkewMs,
    );

    if (isStale) {
      // In RISK or EXECUTION context, stale quote MUST FAIL CLOSED
      if (context === 'RISK' || context === 'EXECUTION') {
        this.logger.error(
          `🚨 [STALE MARKET DATA REJECTED] Symbol: ${symbol} age ${ageMs}ms exceeds max ${maxStaleAgeMs}ms for ${context}. Failing closed.`,
        );
        return {
          isValid: false,
          isStale: true,
          isClockSkewed: skewResult.isSkewed,
          ageMs,
          skewMs: skewResult.skewMs,
          quote: canonicalQuote,
          rejectionCode: 'STALE_QUOTE',
          rejectionReason: `Stale quote rejected for ${context}: age ${ageMs}ms exceeds limit of ${maxStaleAgeMs}ms`,
          displayStatus: 'STALE',
          staleIndicatorText: `⚠️ Stale (${(ageMs / 1000).toFixed(1)}s ago)`,
        };
      }

      // In UI context, stale quotes are permitted with explicit stale indicator
      if (context === 'UI') {
        return {
          isValid: true,
          isStale: true,
          isClockSkewed: skewResult.isSkewed,
          ageMs,
          skewMs: skewResult.skewMs,
          quote: canonicalQuote,
          displayStatus: 'STALE',
          staleIndicatorText: `⚠️ Stale (${(ageMs / 1000).toFixed(1)}s ago)`,
        };
      }
    }

    if (skewResult.isSkewed) {
      this.logger.warn(
        `🚨 [CLOCK SKEW DETECTED] Symbol: ${symbol}, Provider: ${provider}, Skew: ${skewResult.skewMs}ms (${skewResult.direction})`,
      );

      // In risk and execution contexts, clock skew is fatal -> FAIL CLOSED
      if (context === 'RISK' || context === 'EXECUTION') {
        return {
          isValid: false,
          isStale: false,
          isClockSkewed: true,
          ageMs,
          skewMs: skewResult.skewMs,
          quote: canonicalQuote,
          rejectionCode: 'CLOCK_SKEW',
          rejectionReason: `Clock skew tolerance exceeded: provider timestamp is ${skewResult.skewMs}ms ${skewResult.direction} (limit: ${
            skewResult.direction === 'AHEAD' ? maxFutureSkewMs : maxClockSkewMs
          }ms)`,
          displayStatus: 'DEGRADED',
        };
      }
    }

    // 4. Source Authorization Rule
    if (context === 'RISK' || context === 'EXECUTION') {
      if (!allowedSources.includes(source)) {
        return {
          isValid: false,
          isStale,
          isClockSkewed: skewResult.isSkewed,
          ageMs,
          skewMs: skewResult.skewMs,
          quote: canonicalQuote,
          rejectionCode: 'UNAUTHORIZED_SOURCE',
          rejectionReason: `Quote source '${source}' is unauthorized for live ${context}. Allowed: ${allowedSources.join(
            ', ',
          )}`,
          displayStatus: 'DEGRADED',
        };
      }
    }

    // Quote is fresh and authorized
    return {
      isValid: true,
      isStale: false,
      isClockSkewed: skewResult.isSkewed,
      ageMs,
      skewMs: skewResult.skewMs,
      quote: canonicalQuote,
      displayStatus: 'FRESH',
    };
  }

  /**
   * Asserts quote safety for risk gating or order execution. Throws BadRequestException on any violation.
   */
  assertSafeForRiskOrExecution(
    quote: any,
    config?: MarketDataSafetyConfig,
    serverTimeMs = Date.now(),
  ): MarketQuote {
    const result = this.validateQuote(quote, 'EXECUTION', config, serverTimeMs);
    if (!result.isValid) {
      throw new BadRequestException(
        `[MARKET_DATA_UNSAFE] ${result.rejectionCode}: ${result.rejectionReason}`,
      );
    }
    return result.quote!;
  }

  /**
   * Formats quote for UI presentation, attaching human-readable stale indicators without failing closed
   */
  formatForUI(
    quote: any,
    config?: MarketDataSafetyConfig,
    serverTimeMs = Date.now(),
  ): MarketQuoteValidationResult {
    return this.validateQuote(quote, 'UI', config, serverTimeMs);
  }
}
