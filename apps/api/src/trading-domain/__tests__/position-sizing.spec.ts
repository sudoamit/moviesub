import { PositionSizingService } from '../position-sizing.service';
import { InstrumentDefinition } from '@quant/shared';
import { Decimal } from '@prisma/client/runtime/library';

describe('Phase 3 — Position Sizing Engine Domain Suite', () => {
  let service: PositionSizingService;

  beforeAll(() => {
    service = new PositionSizingService();
  });

  describe('1. Authoritative Step Flooring Utility (floorToStep)', () => {
    it('strictly floors downward and never rounds upward across step sizes', () => {
      // Step 0.5
      expect(service.floorToStep(1.49, 0.5)).toBe(1.0);
      expect(service.floorToStep(1.999, 0.5)).toBe(1.5);
      expect(service.floorToStep(2.0, 0.5)).toBe(2.0);

      // Crypto precision step 0.0001
      expect(service.floorToStep(0.12349, 0.0001)).toBe(0.1234);
      expect(service.floorToStep(0.12341, 0.0001)).toBe(0.1234);

      // NIFTY lot step 65
      expect(service.floorToStep(64.99, 65)).toBe(0);
      expect(service.floorToStep(65, 65)).toBe(65);
      expect(service.floorToStep(129.9, 65)).toBe(65);
      expect(service.floorToStep(130, 65)).toBe(130);

      // BANKNIFTY lot step 15
      expect(service.floorToStep(14.9, 15)).toBe(0);
      expect(service.floorToStep(15, 15)).toBe(15);
      expect(service.floorToStep(29.9, 15)).toBe(15);
      expect(service.floorToStep(30, 15)).toBe(30);
    });

    it('handles zero or negative or non-finite inputs safely', () => {
      expect(service.floorToStep(0, 1)).toBe(0);
      expect(service.floorToStep(-5, 1)).toBe(0);
      expect(service.floorToStep(NaN, 1)).toBe(0);
      expect(service.floorToStep(10, 0)).toBe(10);
    });
  });

  describe('2. Authoritative Price Normalization (normalizePriceToTick)', () => {
    it('normalizes prices to the nearest tick interval', () => {
      // 0.05 tick (NSE)
      expect(service.normalizePriceToTick(24123.42, 0.05)).toBe(24123.40);
      expect(service.normalizePriceToTick(24123.44, 0.05)).toBe(24123.45);
      expect(service.normalizePriceToTick(24123.48, 0.05)).toBe(24123.50);

      // 0.01 tick (Crypto/Binance)
      expect(service.normalizePriceToTick(65432.124, 0.01)).toBe(65432.12);
      expect(service.normalizePriceToTick(65432.126, 0.01)).toBe(65432.13);

      // 1.0 tick (MCX Gold)
      expect(service.normalizePriceToTick(74523.4, 1.0)).toBe(74523);
      expect(service.normalizePriceToTick(74523.6, 1.0)).toBe(74524);
    });

    it('validates price via validatePrice', () => {
      const valid = service.validatePrice(100.024, 0.05);
      expect(valid.isValid).toBe(true);
      expect(valid.normalizedPrice).toBe(100.0);

      const invalid = service.validatePrice(-10, 0.05);
      expect(invalid.isValid).toBe(false);
      expect(invalid.code).toBe('ZERO_OR_NEGATIVE');
    });
  });

  describe('3. Quantity Validation & Strict MinQuantity Enforcement', () => {
    it('STRICTLY REJECTS when quantity is below minQuantity (never clamps up)', () => {
      const result = service.validateQuantity(0.0005, 0.001, 0.001);
      expect(result.isValid).toBe(false);
      expect(result.code).toBe('BELOW_MIN_QUANTITY');
      expect(result.normalizedQuantity).toBe(0);
    });

    it('rejects when floored quantity falls below minQuantity', () => {
      // 60 units with lot step 65 and minQuantity 65 floors to 0
      const result = service.validateQuantity(60, 65, 65);
      expect(result.isValid).toBe(false);
      expect(result.code).toBe('BELOW_MIN_QUANTITY');
      expect(result.normalizedQuantity).toBe(0);
    });

    it('rejects when quantity exceeds maxQuantity', () => {
      const result = service.validateQuantity(150, 1, 1, 100);
      expect(result.isValid).toBe(false);
      expect(result.code).toBe('EXCEEDS_MAX_QUANTITY');
    });

    it('accepts and floors valid quantity above minQuantity', () => {
      const result = service.validateQuantity(135, 65, 65, 1000);
      expect(result.isValid).toBe(true);
      expect(result.normalizedQuantity).toBe(130);
    });
  });

  describe('4. Notional Validation (validateNotional)', () => {
    it('validates minimum notional requirement', () => {
      const pass = service.validateNotional(100, 50);
      expect(pass.isValid).toBe(true);

      const fail = service.validateNotional(40, 50);
      expect(fail.isValid).toBe(false);
      expect(fail.code).toBe('BELOW_MIN_NOTIONAL');
    });
  });

  describe('5. Position Sizing Model: FIXED_LOTS', () => {
    const niftyInstrument: any = {
      symbol: 'NIFTY_SPOT',
      contractSize: 1,
      lotSize: 65,
      minimumQuantity: 65,
      quantityStep: 65,
      minNotional: 100,
    };

    it('calculates fixed lot sizing: lots * lotSize', () => {
      const result = service.calculateSizing({
        sizingModel: 'FIXED_LOTS',
        accountBalance: 100000,
        entryPrice: 24000,
        stopLoss: 23800,
        symbol: 'NIFTY_SPOT',
        instrument: niftyInstrument,
        lots: 2,
      });

      expect(result.isValid).toBe(true);
      expect(result.quantity).toBe(130);
      expect(result.lotCount).toBe(2);
      expect(result.notionalQuote).toBe(130 * 24000);
    });

    it('rejects non-positive lots', () => {
      const result = service.calculateSizing({
        sizingModel: 'FIXED_LOTS',
        accountBalance: 100000,
        entryPrice: 24000,
        stopLoss: 23800,
        symbol: 'NIFTY_SPOT',
        instrument: niftyInstrument,
        lots: 0,
      });

      expect(result.isValid).toBe(false);
      expect(result.code).toBe('INVALID_LOTS');
    });
  });

  describe('6. Position Sizing Model: RISK_PERCENT', () => {
    it('calculates risk percentage sizing accurately for linear instrument', () => {
      // Account balance: 100,000 INR
      // Risk percent: 1% = 1,000 INR
      // Entry: 1000 INR, Stop: 950 INR -> Risk per unit: 50 INR
      // Expected units: 1000 / 50 = 20 units
      const instrument: any = {
        symbol: 'STOCK_ABC',
        contractSize: 1,
        lotSize: 1,
        minimumQuantity: 1,
        quantityStep: 1,
      };

      const result = service.calculateSizing({
        sizingModel: 'RISK_PERCENT',
        accountBalance: 100000,
        riskPercentage: 1.0,
        entryPrice: 1000,
        stopLoss: 950,
        symbol: 'STOCK_ABC',
        instrument,
      });

      expect(result.isValid).toBe(true);
      expect(result.quantity).toBe(20);
      expect(result.riskAmountAccount).toBe(1000);
      expect(result.riskPerUnitAccount).toBe(50);
    });

    it('STRICTLY REJECTS when risk percentage sizing results in sub-minimum quantity', () => {
      // Account balance: 10,000 INR
      // Risk percent: 0.5% = 50 INR
      // Entry: 1000 INR, Stop: 900 INR -> Risk per unit: 100 INR
      // Units by risk: 50 / 100 = 0.5 units
      // Minimum quantity: 1 unit
      // Must REJECT, never round up to 1 unit!
      const instrument: any = {
        symbol: 'STOCK_ABC',
        contractSize: 1,
        lotSize: 1,
        minimumQuantity: 1,
        quantityStep: 1,
      };

      const result = service.calculateSizing({
        sizingModel: 'RISK_PERCENT',
        accountBalance: 10000,
        riskPercentage: 0.5,
        entryPrice: 1000,
        stopLoss: 900,
        symbol: 'STOCK_ABC',
        instrument,
      });

      expect(result.isValid).toBe(false);
      expect(result.code).toBe('BELOW_MIN_QUANTITY');
      expect(result.quantity).toBe(0);
    });

    it('converts foreign quote currency risk to account currency via fxRate', () => {
      // Crypto: BTCUSDT
      // Account in INR: 1,000,000 INR
      // Risk: 1% = 10,000 INR
      // Entry: 60,000 USDT, Stop: 59,000 USDT -> Stop distance = 1,000 USDT
      // FX Rate USDT/INR = 90
      // Risk per unit in INR = 1,000 * 90 = 90,000 INR
      // Units: 10,000 / 90,000 = 0.11111... BTC
      // Step: 0.001 BTC
      // Expected floored quantity = 0.111 BTC
      const instrument: any = {
        symbol: 'BTCUSDT_SPOT',
        contractSize: 1,
        lotSize: 0.001,
        minimumQuantity: 0.001,
        quantityStep: 0.001,
      };

      const result = service.calculateSizing({
        sizingModel: 'RISK_PERCENT',
        accountBalance: 1000000,
        riskPercentage: 1.0,
        entryPrice: 60000,
        stopLoss: 59000,
        symbol: 'BTCUSDT_SPOT',
        instrument,
        fxRate: 90.0,
      });

      expect(result.isValid).toBe(true);
      expect(result.quantity).toBe(0.111);
      expect(result.riskPerUnitAccount).toBe(90000);
    });
  });

  describe('7. Position Sizing Model: FIXED_NOTIONAL', () => {
    it('sizes based on target account notional', () => {
      // Target notional: 50,000 INR
      // Entry: 500 INR, contractSize: 1, fxRate: 1
      // Expected quantity: 50000 / 500 = 100 units
      const instrument: any = {
        symbol: 'STOCK_XYZ',
        contractSize: 1,
        lotSize: 5,
        minimumQuantity: 5,
        quantityStep: 5,
      };

      const result = service.calculateSizing({
        sizingModel: 'FIXED_NOTIONAL',
        accountBalance: 200000,
        entryPrice: 500,
        stopLoss: 480,
        symbol: 'STOCK_XYZ',
        instrument,
        fixedNotional: 50000,
      });

      expect(result.isValid).toBe(true);
      expect(result.quantity).toBe(100);
      expect(result.notionalAccount).toBe(50000);
    });
  });

  describe('8. Position Sizing Model: VOLATILITY_TARGET', () => {
    it('sizes inversely proportional to asset volatility', () => {
      // Account balance: 1,000,000 INR
      // Target Vol: 10% annual = 100,000 INR
      // Asset price: 1000 INR, contractSize: 1, AnnVol: 20%
      // Dollar vol per unit = 1000 * 0.20 = 200 INR
      // Expected quantity: 100,000 / 200 = 500 units
      const instrument: any = {
        symbol: 'STOCK_VOL',
        contractSize: 1,
        lotSize: 10,
        minimumQuantity: 10,
        quantityStep: 10,
      };

      const result = service.calculateSizing({
        sizingModel: 'VOLATILITY_TARGET',
        accountBalance: 1000000,
        entryPrice: 1000,
        stopLoss: 950,
        symbol: 'STOCK_VOL',
        instrument,
        targetVolatility: 10,
        annualizedVol: 0.20,
      });

      expect(result.isValid).toBe(true);
      expect(result.quantity).toBe(500);
    });
  });

  describe('9. Seamless Compatibility with InstrumentDefinition (Prisma Decimals)', () => {
    it('accepts InstrumentDefinition with Prisma Decimal fields', () => {
      const def: InstrumentDefinition = {
        id: 'inst_btc_test',
        symbol: 'BTCUSDT_SPOT',
        exchange: 'BINANCE',
        instrumentType: 'SPOT',
        baseCurrency: 'BTC',
        quoteCurrency: 'USDT',
        contractSize: new Decimal(1),
        lotSize: new Decimal('0.0001'),
        minQuantity: new Decimal('0.0001'),
        quantityStep: new Decimal('0.0001'),
        tickSize: new Decimal('0.01'),
        minNotional: new Decimal('5.0'),
        leverageAllowed: false,
        marginModel: 'SPOT',
        tradingTimezone: 'UTC',
      };

      const result = service.calculateSizing({
        sizingModel: 'FIXED_LOTS',
        accountBalance: 100000,
        entryPrice: 50000,
        stopLoss: 49000,
        symbol: 'BTCUSDT_SPOT',
        instrument: def,
        lots: 10, // 10 * 0.0001 = 0.001 BTC
      });

      expect(result.isValid).toBe(true);
      expect(result.quantity).toBe(0.001);
      expect(result.notionalQuote).toBe(50);
    });
  });
});
