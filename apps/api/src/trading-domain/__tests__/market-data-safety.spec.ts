import { MarketDataSafetyService } from '../market-data-safety.service';
import { MarketQuote, MarketDataSource } from '@quant/shared';
import { BadRequestException } from '@nestjs/common';

describe('Phase 21 — Market Data Safety & Clock Skew Engine', () => {
  let service: MarketDataSafetyService;
  const now = 1726915000000; // Fixed server timestamp

  beforeEach(() => {
    service = new MarketDataSafetyService();
  });

  const createValidQuote = (overrides: Partial<MarketQuote> = {}): MarketQuote => ({
    symbol: 'NIFTY',
    instrumentId: 'inst_nifty_50',
    price: 24200.5,
    bid: 24200.0,
    ask: 24201.0,
    marketEventTime: now - 1000, // 1s ago (fresh)
    receivedAt: now - 950,       // Arrived at server 950ms ago
    provider: 'NSE_STREAM_GATEWAY',
    source: 'LIVE',
    ...overrides,
  });

  describe('1. Canonical Quote Schema & Field Validation', () => {
    it('should validate and accept a complete canonical market quote', () => {
      const quote = createValidQuote();
      const res = service.validateQuote(quote, 'EXECUTION', undefined, now);

      expect(res.isValid).toBe(true);
      expect(res.isStale).toBe(false);
      expect(res.isClockSkewed).toBe(false);
      expect(res.displayStatus).toBe('FRESH');
      expect(res.quote?.symbol).toBe('NIFTY');
      expect(res.quote?.instrumentId).toBe('inst_nifty_50');
      expect(res.quote?.price).toBe(24200.5);
      expect(res.quote?.bid).toBe(24200.0);
      expect(res.quote?.ask).toBe(24201.0);
      expect(res.quote?.provider).toBe('NSE_STREAM_GATEWAY');
      expect(res.quote?.source).toBe('LIVE');
    });

    it('should reject quotes missing mandatory symbol, price, or provider', () => {
      expect(service.validateQuote(null, 'RISK', undefined, now).isValid).toBe(false);
      expect(service.validateQuote({ price: 100 }, 'RISK', undefined, now).rejectionCode).toBe('MISSING_FIELDS');
      expect(service.validateQuote({ symbol: 'NIFTY', price: 0 }, 'RISK', undefined, now).rejectionCode).toBe('INVALID_PRICE');
      expect(service.validateQuote({ symbol: 'NIFTY', price: -5 }, 'RISK', undefined, now).rejectionCode).toBe('INVALID_PRICE');
      expect(
        service.validateQuote(
          { symbol: 'NIFTY', price: 100, marketEventTime: now, provider: '' },
          'RISK',
          undefined,
          now,
        ).rejectionCode,
      ).toBe('MISSING_FIELDS');
    });

    it('should support all 5 canonical sources', () => {
      const sources: MarketDataSource[] = ['LIVE', 'CACHE', 'SIMULATION', 'BACKTEST', 'MANUAL'];

      for (const src of sources) {
        const quote = createValidQuote({ source: src });
        // Under UI context all 5 sources are valid
        const res = service.validateQuote(quote, 'UI', undefined, now);
        expect(res.isValid).toBe(true);
        expect(res.quote?.source).toBe(src);
      }

      // Invalid source
      const invalidQuote = createValidQuote({ source: 'INVALID_SRC' as any });
      const resInvalid = service.validateQuote(invalidQuote, 'UI', undefined, now);
      expect(resInvalid.isValid).toBe(false);
      expect(resInvalid.rejectionCode).toBe('MISSING_FIELDS');
    });
  });

  describe('2. Order Book Integrity (Bid / Ask / Crossed Book)', () => {
    it('should reject inverted/crossed book where bid > ask', () => {
      const crossedQuote = createValidQuote({
        bid: 24205.0,
        ask: 24200.0, // bid > ask is an anomalous crossed book
      });

      const res = service.validateQuote(crossedQuote, 'EXECUTION', undefined, now);
      expect(res.isValid).toBe(false);
      expect(res.rejectionCode).toBe('CROSSED_BOOK');
      expect(res.rejectionReason).toContain('Crossed book detected');
    });

    it('should reject negative or zero bid/ask', () => {
      const badBid = createValidQuote({ bid: 0 });
      expect(service.validateQuote(badBid, 'EXECUTION', undefined, now).rejectionCode).toBe('INVALID_PRICE');

      const badAsk = createValidQuote({ ask: -10 });
      expect(service.validateQuote(badAsk, 'EXECUTION', undefined, now).rejectionCode).toBe('INVALID_PRICE');
    });
  });

  describe('3. Clock Skew Detection', () => {
    it('should detect provider clock claiming to be ahead into the future', () => {
      const futureQuote = createValidQuote({
        marketEventTime: now + 4000, // 4s ahead of server arrival (max future skew is 3s)
        receivedAt: now,
      });

      const res = service.validateQuote(futureQuote, 'EXECUTION', undefined, now);
      expect(res.isValid).toBe(false);
      expect(res.isClockSkewed).toBe(true);
      expect(res.rejectionCode).toBe('CLOCK_SKEW');
      expect(res.rejectionReason).toContain('AHEAD');
    });

    it('should detect provider clock lagging severely behind server arrival', () => {
      const laggingQuote = createValidQuote({
        marketEventTime: now - 8000, // 8s before arrival (skew tolerance 5s)
        receivedAt: now,
      });

      const res = service.validateQuote(
        laggingQuote,
        'RISK',
        { maxStaleAgeMs: 15000, maxClockSkewMs: 5000 },
        now,
      );
      expect(res.isValid).toBe(false);
      expect(res.isClockSkewed).toBe(true);
      expect(res.rejectionCode).toBe('CLOCK_SKEW');
      expect(res.rejectionReason).toContain('BEHIND');
    });

    it('should tolerate acceptable minor clock drift within limits', () => {
      const normalQuote = createValidQuote({
        marketEventTime: now - 500, // 500ms drift
        receivedAt: now - 450,
      });

      const skew = service.detectClockSkew(normalQuote.marketEventTime, normalQuote.receivedAt);
      expect(skew.isSkewed).toBe(false);
      expect(skew.direction).toBe('IN_TOLERANCE');
    });
  });

  describe('4. Stale Data Rule: Strict Fail-Closed for Risk & Execution', () => {
    it('should FAIL CLOSED for RISK context when quote age exceeds maxStaleAgeMs', () => {
      const staleQuote = createValidQuote({
        marketEventTime: now - 6000, // 6s old (limit is 5s)
        receivedAt: now - 5950,
      });

      const res = service.validateQuote(staleQuote, 'RISK', { maxStaleAgeMs: 5000 }, now);
      expect(res.isValid).toBe(false);
      expect(res.isStale).toBe(true);
      expect(res.rejectionCode).toBe('STALE_QUOTE');
      expect(res.rejectionReason).toContain('Stale quote rejected for RISK');
    });

    it('should FAIL CLOSED for EXECUTION context and throw in assertSafeForRiskOrExecution', () => {
      const staleQuote = createValidQuote({
        marketEventTime: now - 10000, // 10s old
        receivedAt: now - 9950,
      });

      // assertSafeForRiskOrExecution must throw BadRequestException
      expect(() => {
        service.assertSafeForRiskOrExecution(staleQuote, { maxStaleAgeMs: 5000 }, now);
      }).toThrow(BadRequestException);

      try {
        service.assertSafeForRiskOrExecution(staleQuote, { maxStaleAgeMs: 5000 }, now);
      } catch (err: any) {
        expect(err.message).toContain('[MARKET_DATA_UNSAFE] STALE_QUOTE');
      }
    });

    it('should successfully pass assertSafeForRiskOrExecution when quote is fresh and LIVE', () => {
      const freshQuote = createValidQuote({
        marketEventTime: now - 800,
        receivedAt: now - 750,
      });
      const validated = service.assertSafeForRiskOrExecution(freshQuote, { maxStaleAgeMs: 5000 }, now);
      expect(validated.symbol).toBe('NIFTY');
      expect(validated.price).toBe(24200.5);
    });
  });

  describe('5. UI Presentation Mode: Stale Indicators', () => {
    it('should ALLOW stale quotes for UI but attach explicit stale indicators', () => {
      const staleQuote = createValidQuote({
        marketEventTime: now - 7500, // 7.5s old
        receivedAt: now - 7450,
      });

      const res = service.formatForUI(staleQuote, { maxStaleAgeMs: 5000 }, now);
      expect(res.isValid).toBe(true); // Permitted for display
      expect(res.isStale).toBe(true);
      expect(res.displayStatus).toBe('STALE');
      expect(res.staleIndicatorText).toBe('⚠️ Stale (7.5s ago)');
      expect(res.quote?.price).toBe(24200.5);
    });

    it('should display FRESH status when quote is within freshness tolerance', () => {
      const freshQuote = createValidQuote({
        marketEventTime: now - 1500, // 1.5s old
      });

      const res = service.formatForUI(freshQuote, { maxStaleAgeMs: 5000 }, now);
      expect(res.isValid).toBe(true);
      expect(res.isStale).toBe(false);
      expect(res.displayStatus).toBe('FRESH');
      expect(res.staleIndicatorText).toBeUndefined();
    });
  });

  describe('6. Source Authorization for Live Risk & Execution', () => {
    it('should reject non-LIVE quotes when evaluated for live risk or execution', () => {
      const cachedQuote = createValidQuote({ source: 'CACHE' });
      const resRisk = service.validateQuote(cachedQuote, 'RISK', undefined, now);
      expect(resRisk.isValid).toBe(false);
      expect(resRisk.rejectionCode).toBe('UNAUTHORIZED_SOURCE');

      const backtestQuote = createValidQuote({ source: 'BACKTEST' });
      const resExec = service.validateQuote(backtestQuote, 'EXECUTION', undefined, now);
      expect(resExec.isValid).toBe(false);
      expect(resExec.rejectionCode).toBe('UNAUTHORIZED_SOURCE');
    });

    it('should allow SIMULATION source when explicitly configured for paper trading', () => {
      const simQuote = createValidQuote({ source: 'SIMULATION' });
      const res = service.validateQuote(
        simQuote,
        'EXECUTION',
        { allowedSourcesForExecution: ['LIVE', 'SIMULATION'] },
        now,
      );
      expect(res.isValid).toBe(true);
      expect(res.quote?.source).toBe('SIMULATION');
    });
  });
});
