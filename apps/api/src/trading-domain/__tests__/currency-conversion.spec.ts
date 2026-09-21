import { CurrencyConversionService } from '../currency-conversion.service';
import { AccountingService } from '../accounting.service';
import { Direction, FxRateSnapshot } from '@quant/shared';
import { BadRequestException } from '@nestjs/common';

describe('Phase 4 — Currency / FX Engine Domain Suite', () => {
  let service: CurrencyConversionService;
  let accountingService: AccountingService;

  const mockPrisma: any = {
    paperAccount: {
      update: jest.fn(),
    },
  };

  beforeAll(() => {
    service = new CurrencyConversionService();
    accountingService = new AccountingService(mockPrisma);

    // Register test point-in-time rates
    service.registerRate({
      pair: 'USDT/INR',
      rate: 85.0,
      timestamp: 1000000,
      source: 'BINANCE_P2P',
      version: '1.0',
    });
    service.registerRate({
      pair: 'USDT/INR',
      rate: 90.0,
      timestamp: 2000000,
      source: 'BINANCE_P2P',
      version: '1.1',
    });

    service.registerRate({
      pair: 'BTC/USDT',
      rate: 60000.0,
      timestamp: 1500000,
      source: 'BINANCE_SPOT',
      version: '1.0',
    });
  });

  describe('1. Explicit Financial Identification & Identity Conversion', () => {
    it('returns identity rate 1.0 for same-currency conversions with explicit identification', () => {
      const snap = service.getRate('INR', 'INR');

      expect(snap.sourceCurrency).toBe('INR');
      expect(snap.targetCurrency).toBe('INR');
      expect(snap.rate).toBe(1.0);
      expect(snap.rateSource).toBe('IDENTITY');
      expect(snap.pair).toBe('INR/INR');
      expect(typeof snap.snapshotHash).toBe('string');
      expect(snap.snapshotHash.length).toBe(64); // SHA-256 length
      expect(service.verifySnapshot(snap)).toBe(true);
    });

    it('returns identity rate for USDT to USDT', () => {
      const snap = service.getRate('USDT', 'USDT');
      expect(snap.rate).toBe(1.0);
      expect(snap.rateSource).toBe('IDENTITY');
    });
  });

  describe('2. Point-in-Time Zero Lookahead Rate Resolution', () => {
    it('returns historical rate at timestamp before update (zero lookahead)', () => {
      // Query at timestamp 1500000: should match 85.0 (timestamp 1000000) not 90.0 (timestamp 2000000)
      const snap = service.getRate('USDT', 'INR', 1500000);

      expect(snap.rate).toBe(85.0);
      expect(snap.rateTimestamp).toBe(1000000);
      expect(snap.rateSource).toBe('BINANCE_P2P');
      expect(service.verifySnapshot(snap)).toBe(true);
    });

    it('returns updated rate at timestamp after update', () => {
      const snap = service.getRate('USDT', 'INR', 2500000);

      expect(snap.rate).toBe(90.0);
      expect(snap.rateTimestamp).toBe(2000000);
      expect(snap.rateSource).toBe('BINANCE_P2P');
    });

    it('converts amount and returns both convertedAmount and full fxSnapshot', () => {
      const result = service.convert(100, 'USDT', 'INR', 2500000);

      expect(result.convertedAmount).toBe(9000); // 100 * 90
      expect(result.fxSnapshot.rate).toBe(90.0);
      expect(result.fxSnapshot.sourceCurrency).toBe('USDT');
      expect(result.fxSnapshot.targetCurrency).toBe('INR');
    });
  });

  describe('3. Inverse Rate Resolution', () => {
    it('resolves inverse rates when only direct pair is registered', () => {
      // Query INR -> USDT at timestamp 2500000: should be 1 / 90.0 = 0.011111
      const snap = service.getRate('INR', 'USDT', 2500000);

      expect(snap.sourceCurrency).toBe('INR');
      expect(snap.targetCurrency).toBe('USDT');
      expect(snap.rate).toBeCloseTo(1 / 90.0, 4);
      expect(snap.rateSource).toContain('INVERTED');
      expect(service.verifySnapshot(snap)).toBe(true);
    });
  });

  describe('4. Multi-Leg Triangulation (BTC -> USDT -> INR)', () => {
    it('triangulates chained currency pairs with explicit audit provenance', () => {
      // BTC -> USDT (60,000) and USDT -> INR (90) => BTC -> INR (5,400,000)
      const snap = service.triangulateRate('BTC', 'USDT', 'INR', 2500000);

      expect(snap.sourceCurrency).toBe('BTC');
      expect(snap.targetCurrency).toBe('INR');
      expect(snap.pair).toBe('BTC/INR');
      expect(snap.rate).toBe(5400000);
      expect(snap.rateSource).toBe('BINANCE_SPOT*BINANCE_P2P');
      expect(service.verifySnapshot(snap)).toBe(true);
    });
  });

  describe('5. Cryptographic Snapshot Hash & Tamper Detection', () => {
    it('verifies valid snapshot hash', () => {
      const snap = service.getRate('USDT', 'INR', 2500000);
      expect(service.verifySnapshot(snap)).toBe(true);
    });

    it('detects tampering when rate or currency is modified without re-hashing', () => {
      const snap = service.getRate('USDT', 'INR', 2500000);
      const tampered: FxRateSnapshot = {
        ...snap,
        rate: 95.0, // Modified rate without updating snapshotHash
      };

      expect(service.verifySnapshot(tampered)).toBe(false);
    });
  });

  describe('6. Historical Immutability (Never Recalculate Historical Trades)', () => {
    it('preserves historical snapshot rate for trade P&L rather than querying current rate', () => {
      // Historical trade executed when USDT/INR was 82.5
      const historicalSnapshot: FxRateSnapshot = {
        sourceCurrency: 'USDT',
        targetCurrency: 'INR',
        rate: 82.5,
        rateTimestamp: 500000,
        rateSource: 'HISTORICAL_ARCHIVE',
        pair: 'USDT/INR',
        snapshotHash: service.generateSnapshotHash('USDT', 'INR', 82.5, 500000, 'HISTORICAL_ARCHIVE'),
      };

      // Realized P&L in USDT: Entry 50,000, Exit 51,000, Qty 0.1 => Gross PnL = 100 USDT
      // With historical rate 82.5 => 8,250 INR (NOT current 90.0 => 9,000 INR)
      const pnlResult = accountingService.calculateRealizedPnL({
        direction: Direction.BULLISH,
        entryPrice: 50000,
        exitPrice: 51000,
        quantity: 0.1,
        contractSize: 1,
        fxSnapshot: historicalSnapshot,
        entryFees: 0,
        exitFees: 0,
      });

      expect(pnlResult.grossPnLQuote).toBe(100);
      expect(pnlResult.grossPnLAccount).toBe(8250); // 100 * 82.5
      expect(pnlResult.netPnLAccount).toBe(8250);
      expect(pnlResult.fxSnapshot).toBe(historicalSnapshot);
    });

    it('uses convertWithHistoricalSnapshot to replay historical calculations immutably', () => {
      const historicalSnapshot: FxRateSnapshot = {
        sourceCurrency: 'USDT',
        targetCurrency: 'INR',
        rate: 80.0,
        rateTimestamp: 100000,
        rateSource: 'ARCHIVE',
        pair: 'USDT/INR',
        snapshotHash: service.generateSnapshotHash('USDT', 'INR', 80.0, 100000, 'ARCHIVE'),
      };

      const converted = service.convertWithHistoricalSnapshot(500, historicalSnapshot);
      expect(converted).toBe(40000); // 500 * 80.0
    });
  });

  describe('7. Fail-Closed On Missing Rates', () => {
    it('throws BadRequestException if non-identical pair rate is missing', () => {
      expect(() => service.getRate('EUR', 'JPY')).toThrow(BadRequestException);
    });

    it('throws BadRequestException for empty currency specifications', () => {
      expect(() => service.getRate('', 'INR')).toThrow(BadRequestException);
      expect(() => service.getRate('INR', '')).toThrow(BadRequestException);
    });
  });
});
