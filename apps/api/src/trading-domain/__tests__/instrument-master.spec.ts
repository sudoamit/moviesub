import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { InstrumentMasterService } from '../instrument-master.service';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('Phase 2 — Instrument Master Domain Suite', () => {
  let service: InstrumentMasterService;

  const mockPrisma = {
    instrument: {
      findUnique: jest.fn(({ where }) => {
        if (where.symbol === 'RELIANCE') {
          return {
            id: 'inst_rel',
            symbol: 'RELIANCE',
            exchange: 'NSE',
            assetType: 'EQUITY',
            currency: 'INR',
            tickSize: new Decimal('0.05'),
            lotSize: 1,
            contractSize: new Decimal(1),
            isActive: true,
          };
        }
        return null;
      }),
    },
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InstrumentMasterService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<InstrumentMasterService>(InstrumentMasterService);
  });

  describe('1. Canonical Symbol & Identity Mapping', () => {
    it('canonicalizes BTCUSDT to explicit BTCUSDT_SPOT by default', () => {
      expect(service.canonicalizeSymbol('BTCUSDT')).toBe('BTCUSDT_SPOT');
      expect(service.canonicalizeSymbol('btcusdt')).toBe('BTCUSDT_SPOT');
    });

    it('canonicalizes BTCUSDT to BTCUSDT_PERP when defaultType is PERPETUAL', () => {
      expect(service.canonicalizeSymbol('BTCUSDT', 'PERPETUAL')).toBe('BTCUSDT_PERP');
    });

    it('preserves already explicit BTCUSDT_SPOT and BTCUSDT_PERP', () => {
      expect(service.canonicalizeSymbol('BTCUSDT_SPOT')).toBe('BTCUSDT_SPOT');
      expect(service.canonicalizeSymbol('BTCUSDT_PERP')).toBe('BTCUSDT_PERP');
    });

    it('canonicalizes NIFTY and BANKNIFTY to explicit spot symbols', () => {
      expect(service.canonicalizeSymbol('NIFTY')).toBe('NIFTY_SPOT');
      expect(service.canonicalizeSymbol('BANKNIFTY')).toBe('BANKNIFTY_SPOT');
    });

    it('throws BadRequestException for empty or invalid symbol', () => {
      expect(() => service.canonicalizeSymbol('')).toThrow(BadRequestException);
      expect(() => service.canonicalizeSymbol(null as any)).toThrow(BadRequestException);
    });
  });

  describe('2. BTC Spot vs Perpetual Separation & Invariants', () => {
    it('enforces SPOT invariants for BTCUSDT_SPOT: leverage=1, no liquidation, spot margin model', async () => {
      const inst = await service.getInstrument('BTCUSDT_SPOT');

      expect(inst.symbol).toBe('BTCUSDT_SPOT');
      expect(inst.exchange).toBe('BINANCE');
      expect(inst.instrumentType).toBe('SPOT');
      expect(inst.marginModel).toBe('SPOT');
      expect(inst.leverageAllowed).toBe(false);
      expect(inst.maxLeverage?.toString()).toBe('1');
      expect(inst.baseCurrency).toBe('BTC');
      expect(inst.quoteCurrency).toBe('USDT');
      expect(inst.contractSize.toString()).toBe('1');
      expect(inst.lotSize?.toString()).toBe('0.0001');
      expect(inst.minQuantity.toString()).toBe('0.0001');
      expect(inst.quantityStep.toString()).toBe('0.0001');
      expect(inst.tickSize.toString()).toBe('0.01');
      expect(inst.tradingTimezone).toBe('UTC');
    });

    it('handles BTCUSDT_PERP with isolated margin and leverage allowance', async () => {
      const inst = await service.getInstrument('BTCUSDT_PERP');

      expect(inst.symbol).toBe('BTCUSDT_PERP');
      expect(inst.exchange).toBe('BINANCE');
      expect(inst.instrumentType).toBe('PERPETUAL');
      expect(inst.underlyingSymbol).toBe('BTCUSDT');
      expect(inst.marginModel).toBe('ISOLATED');
      expect(inst.leverageAllowed).toBe(true);
      expect(inst.maxLeverage?.toString()).toBe('20');
      expect(inst.contractSize.toString()).toBe('1');
      expect(inst.minQuantity.toString()).toBe('0.001');
      expect(inst.quantityStep.toString()).toBe('0.001');
      expect(inst.tickSize.toString()).toBe('0.1');
    });

    it('confirms perpetual execution is disabled in the spot-only trading architecture', () => {
      expect(service.isPerpetualExecutionSupported()).toBe(false);
    });
  });

  describe('3. Indian Spot Indices Invariants', () => {
    it('returns authoritative definition for NIFTY_SPOT', async () => {
      const inst = await service.getInstrument('NIFTY_SPOT');

      expect(inst.symbol).toBe('NIFTY_SPOT');
      expect(inst.exchange).toBe('NSE');
      expect(inst.instrumentType).toBe('SPOT');
      expect(inst.quoteCurrency).toBe('INR');
      expect(inst.contractSize.toString()).toBe('1');
      expect(inst.tickSize.toString()).toBe('0.05');
      expect(inst.marginModel).toBe('SPOT');
      expect(inst.tradingTimezone).toBe('Asia/Kolkata');
    });

    it('returns authoritative definition for BANKNIFTY_SPOT', async () => {
      const inst = await service.getInstrument('BANKNIFTY_SPOT');

      expect(inst.symbol).toBe('BANKNIFTY_SPOT');
      expect(inst.exchange).toBe('NSE');
      expect(inst.instrumentType).toBe('SPOT');
      expect(inst.quoteCurrency).toBe('INR');
      expect(inst.contractSize.toString()).toBe('1');
      expect(inst.tickSize.toString()).toBe('0.05');
      expect(inst.marginModel).toBe('SPOT');
      expect(inst.tradingTimezone).toBe('Asia/Kolkata');
    });
  });

  describe('4. Option Identity & Invariants', () => {
    it('rejects option identification attempted with ONLY underlying symbol', () => {
      expect(() => service.parseAndBuildOptionDefinition('NIFTY')).toThrow(BadRequestException);
      expect(() => service.parseAndBuildOptionDefinition('BANKNIFTY')).toThrow(BadRequestException);
      expect(() => service.parseAndBuildOptionDefinition('NIFTY_SPOT')).toThrow(BadRequestException);
    });

    it('requires exchange, underlying, expiry, strike, optionType, contractSize, and lotSize', () => {
      const futureDate = new Date(Date.now() + 7 * 86400000);
      const opt = service.resolveOptionInstrument({
        exchange: 'NSE',
        underlying: 'NIFTY',
        expiry: futureDate,
        strike: 24500,
        optionType: 'CE',
      });

      expect(opt.instrumentType).toBe('OPTION');
      expect(opt.exchange).toBe('NSE');
      expect(opt.underlyingSymbol).toBe('NIFTY_SPOT');
      expect(opt.strike?.toString()).toBe('24500');
      expect(opt.optionType).toBe('CE');
      expect(opt.contractSize.toString()).toBe('1');
      expect(opt.lotSize?.toString()).toBe('65'); // NIFTY lot size
      expect(opt.minQuantity.toString()).toBe('65');
      expect(opt.quantityStep.toString()).toBe('65');
      expect(opt.marginModel).toBe('OPTION_PREMIUM');
      expect(opt.leverageAllowed).toBe(false);
      expect(opt.tradingTimezone).toBe('Asia/Kolkata');
    });

    it('enforces lot size of 15 for BANKNIFTY options', () => {
      const futureDate = new Date(Date.now() + 7 * 86400000);
      const opt = service.resolveOptionInstrument({
        exchange: 'NSE',
        underlying: 'BANKNIFTY',
        expiry: futureDate,
        strike: 51200,
        optionType: 'PE',
      });

      expect(opt.lotSize?.toString()).toBe('15');
      expect(opt.minQuantity.toString()).toBe('15');
      expect(opt.quantityStep.toString()).toBe('15');
      expect(opt.optionType).toBe('PE');
    });

    it('rejects unsupported options underlyings', () => {
      const futureDate = new Date(Date.now() + 7 * 86400000);
      expect(() =>
        service.resolveOptionInstrument({
          underlying: 'BTCUSDT',
          expiry: futureDate,
          strike: 60000,
          optionType: 'CE',
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects invalid optionType', () => {
      const futureDate = new Date(Date.now() + 7 * 86400000);
      expect(() =>
        service.resolveOptionInstrument({
          underlying: 'NIFTY',
          expiry: futureDate,
          strike: 24500,
          optionType: 'INVALID' as any,
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects zero or negative strike', () => {
      const futureDate = new Date(Date.now() + 7 * 86400000);
      expect(() =>
        service.resolveOptionInstrument({
          underlying: 'NIFTY',
          expiry: futureDate,
          strike: 0,
          optionType: 'CE',
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('5. Option Expiry & Local Timezone Rejection', () => {
    it('strictly rejects expired contracts using exchange-local timezone (Asia/Kolkata)', () => {
      // Create an expiry date in the past
      const pastExpiry = new Date('2026-09-10T10:00:00Z');
      const now = new Date('2026-09-20T12:00:00Z');

      const check = service.validateOptionExpiry(pastExpiry, 'Asia/Kolkata', now);
      expect(check.isValid).toBe(false);
      expect(check.reason).toContain('[EXPIRED_OPTION_CONTRACT]');

      expect(() =>
        service.resolveOptionInstrument(
          {
            underlying: 'NIFTY',
            expiry: pastExpiry,
            strike: 24500,
            optionType: 'CE',
          },
          now,
        ),
      ).toThrow(BadRequestException);
    });

    it('strictly rejects option expiring today if reference time is past 15:30 IST (10:00 UTC)', () => {
      // Expiry on 2026-09-20
      const todayExpiry = new Date('2026-09-20T00:00:00Z');
      // Reference time at 15:31 IST = 10:01 UTC
      const pastClose = new Date('2026-09-20T10:01:00Z');

      const check = service.validateOptionExpiry(todayExpiry, 'Asia/Kolkata', pastClose);
      expect(check.isValid).toBe(false);
      expect(check.reason).toContain('[EXPIRED_OPTION_CONTRACT]');
    });

    it('accepts option expiring today if reference time is before 15:30 IST (10:00 UTC)', () => {
      const todayExpiry = new Date('2026-09-20T00:00:00Z');
      // Reference time at 14:00 IST = 08:30 UTC
      const beforeClose = new Date('2026-09-20T08:30:00Z');

      const check = service.validateOptionExpiry(todayExpiry, 'Asia/Kolkata', beforeClose);
      expect(check.isValid).toBe(true);
    });
  });

  describe('6. Fail-Closed on Unregistered Instruments', () => {
    it('throws NotFoundException when an unknown instrument is queried', async () => {
      await expect(service.getInstrument('NON_EXISTENT_COIN')).rejects.toThrow(NotFoundException);
    });

    it('falls back to database when instrument is in Prisma database', async () => {
      const inst = await service.getInstrument('RELIANCE');
      expect(inst.symbol).toBe('RELIANCE');
      expect(inst.exchange).toBe('NSE');
    });
  });
});
