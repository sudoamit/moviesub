import { ValidationPipe } from '@nestjs/common';
import { PointInTimeCurrencyConverter } from '@quant/shared';
import { PaperTradingService } from '../paper-trading.service';
import { ClosePositionDto, PlaceOrderDto, ScaleOutDto } from '../dto/paper-trading.dto';

/**
 * Regression suite for the execution-boundary audit fixes:
 * - BTC aliases execute as true spot (1x, long-only), never the leveraged perpetual spec
 * - leverage > 1 on spot is rejected, never silently clamped
 * - position risk is enforced in account currency (INR), not quote currency (USDT)
 * - insufficient cash is rejected before any position exists
 * - clients cannot choose fill prices (LIMIT must be marketable and fills at the quote; options fill at the quote)
 * - the HTTP contract rejects price-override and exit-price fields
 */
describe('Execution boundary is fail-closed', () => {
  const pitConverter = PointInTimeCurrencyConverter.getInstance();
  const fx = pitConverter.getRate('USDT', 'INR', Date.now()).fxRate;

  let service: PaperTradingService;
  let mockPrisma: any;
  let btcPrice: number;
  let optionPrice: number;

  const account = {
    id: 'acc-boundary',
    currency: 'INR',
    initialCapital: 1000000,
    cashBalance: 1000000,
    usedMargin: 0,
  };

  beforeEach(() => {
    btcPrice = 60000;
    optionPrice = 56.63;

    mockPrisma = {
      paperAccount: {
        findFirst: jest.fn().mockResolvedValue(account),
        findUnique: jest.fn().mockResolvedValue(account),
        update: jest.fn().mockResolvedValue(account),
      },
      paperOrder: {
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockImplementation((args) => Promise.resolve({ id: 'ord-1', ...args.data })),
      },
      paperPosition: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation((args) => Promise.resolve({ id: 'pos-1', ...args.data })),
      },
      paperTrade: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      paperFill: {
        create: jest.fn().mockImplementation((args) => Promise.resolve({ id: 'fill-1', ...args.data })),
      },
      auditEvent: {
        create: jest.fn().mockResolvedValue({}),
        createMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      $transaction: jest.fn().mockImplementation(async (callback) => callback(mockPrisma)),
    };

    const streamer = {
      getValidatedTicker: (sym: string) => {
        if (!['BTCUSDT', 'BTCUSDT_SPOT'].includes(sym)) throw new Error(`no quote for ${sym}`);
        return { price: btcPrice, marketEventTime: Date.now() };
      },
      getOptionTicker: (contract: string) => ({
        symbol: contract,
        price: optionPrice,
        marketEventTime: Date.now(),
      }),
    } as any;

    service = new PaperTradingService(mockPrisma, {} as any, streamer);
    jest.spyOn(service as any, 'getOrCreateAccount').mockResolvedValue(account);
    jest.spyOn(service as any, 'getSystemConfig').mockResolvedValue({
      emergencyStop: false,
      maxOpenPositions: 5,
      maxTradesPerDay: 20,
      maxConsecutiveLosses: 3,
      maxPositionRiskPercent: 1.0, // ₹10,000 on ₹10L capital
      maxDailyLossPercent: 3.0,
      maxTotalExposurePercent: 100.0,
      maxLeverage: 5,
      maxSlippageBps: 0,
      maxMarketDataAgeSeconds: 5,
    });
    jest.spyOn(service as any, 'rejectOrder').mockResolvedValue(undefined as any);
  });

  const btcBuy = (overrides: Record<string, any> = {}) => ({
    symbol: 'BTCUSDT',
    direction: 'BUY' as const,
    quantity: 0.01,
    orderType: 'MARKET' as const,
    stopLoss: 59500,
    target1: 61000,
    ...overrides,
  });

  describe('BTC is true spot', () => {
    it('rejects a SELL entry on the legacy BTCUSDT alias (no short on spot)', async () => {
      await expect(
        service.placeOrder(btcBuy({ direction: 'SELL', stopLoss: 60500, target1: 59000 })),
      ).rejects.toThrow(/SPOT_SHORT_SELLING_FORBIDDEN/);
      expect(mockPrisma.paperPosition.create).not.toHaveBeenCalled();
    });

    it('rejects 20x on the legacy BTCUSDT alias instead of using the perpetual spec', async () => {
      await expect(service.placeOrder(btcBuy({ leverage: 20 }))).rejects.toThrow(
        /LEVERAGE_EXCEEDS_MAX/,
      );
      expect(mockPrisma.paperPosition.create).not.toHaveBeenCalled();
    });

    it('rejects 50x on BTCUSDT_SPOT (never silently converted to 1x)', async () => {
      await expect(
        service.placeOrder(btcBuy({ symbol: 'BTCUSDT_SPOT', leverage: 50 })),
      ).rejects.toThrow(/LEVERAGE_EXCEEDS_MAX/);
    });

    it('opens a BTCUSDT order as BTCUSDT_SPOT at 1x with margin = full INR notional', async () => {
      await service.placeOrder(btcBuy());
      const created = mockPrisma.paperPosition.create.mock.calls[0][0].data;
      expect(created.symbol).toBe('BTCUSDT_SPOT');
      expect(Number(created.leverage)).toBe(1);
      expect(Number(created.usedMargin)).toBeCloseTo(60000 * 0.01 * fx, 0);
    });
  });

  describe('Risk and cash are enforced before any fill', () => {
    it('enforces the position risk limit in INR, not USDT', async () => {
      // Risk = (60000 - 58000) x 0.1 = 200 USDT ≈ ₹18,400 at fx 92 > ₹10,000 cap.
      // Compared in USDT (the old bug) it would be 200 < 10,000 and pass.
      await expect(
        service.placeOrder(btcBuy({ quantity: 0.1, stopLoss: 58000, target1: 64000 })),
      ).rejects.toThrow(/POSITION_RISK_LIMIT/);
      expect(mockPrisma.paperPosition.create).not.toHaveBeenCalled();
    });

    it('rejects insufficient cash before creating a position', async () => {
      // 1 BTC ≈ ₹55L notional vs ₹10L cash. Tight stop keeps risk under the cap so cash is the binding rule.
      await expect(
        service.placeOrder(btcBuy({ quantity: 1, stopLoss: 59995, target1: 61000 })),
      ).rejects.toThrow(/INSUFFICIENT_(MARGIN|FUNDS)/);
      expect(mockPrisma.paperPosition.create).not.toHaveBeenCalled();
      expect(mockPrisma.paperFill.create).not.toHaveBeenCalled();
    });
  });

  describe('Clients cannot choose fill prices', () => {
    it('rejects a non-marketable BUY LIMIT instead of filling at the limit price', async () => {
      await expect(
        service.placeOrder(btcBuy({ orderType: 'LIMIT', price: 55000, stopLoss: 54000, target1: 56000 })),
      ).rejects.toThrow(/LIMIT_NOT_MARKETABLE/);
      expect(mockPrisma.paperPosition.create).not.toHaveBeenCalled();
    });

    it('fills a marketable BUY LIMIT at the validated quote, not at the limit', async () => {
      await service.placeOrder(btcBuy({ orderType: 'LIMIT', price: 65000 }));
      const created = mockPrisma.paperPosition.create.mock.calls[0][0].data;
      expect(Number(created.entryPrice)).toBe(60000);
    });

    it('fills an option at the validated premium even when the client sends a nearby price', async () => {
      await service.placeOrder({
        symbol: 'NIFTY',
        contractSymbol: 'NIFTY 24200 CE',
        instrumentType: 'OPTION',
        strike: 24200,
        optionType: 'CE',
        direction: 'BUY',
        quantity: 65,
        orderType: 'MARKET',
        price: 57.5, // within the 5% sanity band, but must not become the fill price
        stopLoss: 36.81,
        target1: 86.36,
      });
      const created = mockPrisma.paperPosition.create.mock.calls[0][0].data;
      expect(Number(created.entryPrice)).toBe(56.63);
    });

    it('rejects an option quote without a provider timestamp (freshness unprovable)', async () => {
      (service as any).realMarketStreamer.getOptionTicker = (contract: string) => ({
        symbol: contract,
        price: optionPrice,
      });
      await expect(
        service.placeOrder({
          symbol: 'NIFTY',
          contractSymbol: 'NIFTY 24200 CE',
          instrumentType: 'OPTION',
          strike: 24200,
          optionType: 'CE',
          direction: 'BUY',
          quantity: 65,
          orderType: 'MARKET',
          stopLoss: 36.81,
          target1: 86.36,
        }),
      ).rejects.toThrow(/no provider timestamp/);
    });
  });

  describe('HTTP contract rejects client price authority', () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

    it('rejects allowPriceOverride / executionMode / accountBalance on orders', async () => {
      for (const field of ['allowPriceOverride', 'executionMode', 'accountBalance', 'accountId']) {
        await expect(
          pipe.transform(
            { symbol: 'BTCUSDT_SPOT', direction: 'BUY', quantity: 0.01, [field]: true },
            { type: 'body', metatype: PlaceOrderDto },
          ),
        ).rejects.toBeDefined();
      }
    });

    it('rejects exitPrice / allowPriceOverride on close and scale-out requests', async () => {
      await expect(
        pipe.transform({ reason: 'x', exitPrice: 100 }, { type: 'body', metatype: ClosePositionDto }),
      ).rejects.toBeDefined();
      await expect(
        pipe.transform(
          { reason: 'x', allowPriceOverride: true },
          { type: 'body', metatype: ClosePositionDto },
        ),
      ).rejects.toBeDefined();
      await expect(
        pipe.transform({ ratio: 0.5, exitPrice: 100 }, { type: 'body', metatype: ScaleOutDto }),
      ).rejects.toBeDefined();
    });

    it('accepts a normal MARKET order body', async () => {
      const dto = await pipe.transform(
        { symbol: 'BTCUSDT_SPOT', direction: 'BUY', quantity: 0.01, stopLoss: 59000, target1: 61000 },
        { type: 'body', metatype: PlaceOrderDto },
      );
      expect(dto.orderType).toBe('MARKET');
    });
  });
});
