import { Test, TestingModule } from '@nestjs/testing';
import { PaperTradingService } from '../paper-trading.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CandlesService } from '../../candles/candles.service';
import { RealMarketStreamerService } from '../../market-data/real-market-streamer.service';

describe('PaperTradingService Immutability & Lifecycle', () => {
  let service: PaperTradingService;
  let mockPrisma: any;
  let mockCandlesService: any;
  let mockRealMarketStreamer: any;

  beforeEach(async () => {
    mockPrisma = {
      instrument: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'inst-1', symbol: 'NIFTY', name: 'Nifty 50', currency: 'INR' }),
      },
      signal: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation((args) => Promise.resolve({ id: 'sig-1', ...args.data })),
      },
    };

    mockCandlesService = {
      getLatestCandle: jest.fn().mockResolvedValue({ close: 24150.0 }),
    };

    mockRealMarketStreamer = {
      getTicker: jest.fn().mockReturnValue({ price: 24180.0 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CandlesService, useValue: mockCandlesService },
        { provide: RealMarketStreamerService, useValue: mockRealMarketStreamer },
      ],
    }).compile();

    service = module.get<PaperTradingService>(PaperTradingService);
    await service.resetPortfolio();
  });

  it('should place an order and preserve immutable entryPrice and entryTime', async () => {
    const order = await service.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 65,
      orderType: 'MARKET',
      price: 24100.0,
      stopLoss: 24050.0,
      target1: 24175.0,
      target2: 24225.0,
      leverage: 5,
    });

    expect(order.entryPrice).toBe(24100.0);
    expect(order.entryTime).toBeDefined();
    expect(new Date(order.entryTime).getTime()).toBeGreaterThan(0);

    // Verify immutability: entryPrice property is non-writable
    expect(() => {
      (order as any).entryPrice = 24500.0;
    }).toThrow();
  });

  it('should NOT mutate entryPrice or entryTime across multiple getPortfolio price updates', async () => {
    const order = await service.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 65,
      orderType: 'MARKET',
      price: 24100.0,
      stopLoss: 24050.0,
      target2: 24250.0,
    });

    const initialEntryPrice = order.entryPrice;
    const initialEntryTime = order.entryTime;

    // Simulate 5 consecutive market price movements
    const priceTicks = [24120.0, 24150.0, 24180.0, 24140.0, 24190.0];
    for (const tick of priceTicks) {
      mockRealMarketStreamer.getTicker.mockReturnValue({ price: tick });
      const portfolio = await service.getPortfolio();
      const pos = portfolio.openPositions.find((p) => p.id === order.id)!;

      // entryPrice & entryTime must NEVER change
      expect(pos.entryPrice).toBe(initialEntryPrice);
      expect(pos.entryTime).toBe(initialEntryTime);

      // currentPrice and unrealizedPnL must update dynamically
      expect(pos.currentPrice).toBe(tick);
      expect(pos.unrealizedPnL).toBeGreaterThan(0);
    }
  });

  it('should support Option Contract trading with locked strike and premium', async () => {
    mockPrisma.instrument.findUnique.mockResolvedValue({ id: 'inst-nifty', symbol: 'NIFTY' });

    const optionOrder = await service.placeOrder({
      symbol: 'NIFTY',
      contractSymbol: 'NIFTY 24100 PE',
      instrumentType: 'OPTION',
      strike: 24100,
      optionType: 'PE',
      direction: 'BUY',
      quantity: 65,
      orderType: 'MARKET',
      price: 50.0, // Option entry premium ₹50.00
      stopLoss: 30.0,
      target1: 80.0,
      target2: 110.0,
    });

    expect(optionOrder.contractSymbol).toBe('NIFTY 24100 PE');
    expect(optionOrder.entryPrice).toBe(50.0);
    expect(optionOrder.instrumentType).toBe('OPTION');
    expect(optionOrder.strike).toBe(24100);
    expect(optionOrder.optionType).toBe('PE');

    // Portfolio update for option: ensure spot market streamer does NOT overwrite option premium
    const portfolio = await service.getPortfolio();
    const pos = portfolio.openPositions.find((p) => p.id === optionOrder.id)!;
    expect(pos.entryPrice).toBe(50.0);
    expect(pos.contractSymbol).toBe('NIFTY 24100 PE');
  });

  it('should support BTCUSDT trading with fixed entry price and live price tracking', async () => {
    mockPrisma.instrument.findUnique.mockResolvedValue({ id: 'inst-btc', symbol: 'BTCUSDT' });
    mockRealMarketStreamer.getTicker.mockReturnValue({ price: 79500.0 });

    const btcOrder = await service.placeOrder({
      symbol: 'BTCUSDT',
      direction: 'BUY',
      quantity: 0.2,
      orderType: 'MARKET',
      price: 79230.0,
      stopLoss: 79050.0,
      target1: 79500.0,
      target2: 79800.0,
    });

    expect(btcOrder.entryPrice).toBe(79230.0);
    expect(btcOrder.symbol).toBe('BTCUSDT');

    mockRealMarketStreamer.getTicker.mockReturnValue({ price: 79600.0 });
    const portfolio = await service.getPortfolio();
    const pos = portfolio.openPositions.find((p) => p.id === btcOrder.id)!;

    expect(pos).toBeDefined();
    expect(pos.entryPrice).toBe(79230.0);
    expect(pos.currentPrice).toBe(79600.0);
    expect(pos.unrealizedPnL).toBeGreaterThan(0);
  });

  it('should close position, calculate accurate realized PnL and persist to journal', async () => {
    mockPrisma.instrument.findUnique.mockResolvedValue({ id: 'inst-nifty', symbol: 'NIFTY' });

    const order = await service.placeOrder({
      symbol: 'NIFTY',
      contractSymbol: 'NIFTY 24100 PE',
      instrumentType: 'OPTION',
      strike: 24100,
      optionType: 'PE',
      direction: 'BUY',
      quantity: 65,
      orderType: 'MARKET',
      price: 50.0,
      stopLoss: 30.0,
      target2: 110.0,
    });

    // Close position at exit price 90.0 (gain of 40 pts * 65 qty = 2600 gross PnL)
    const closedRecord = await service.closePosition(order.id, 'Target 2 Achieved', 90.0);

    expect(closedRecord.entryPrice).toBe(50.0);
    expect(closedRecord.exitPrice).toBe(90.0);
    expect(closedRecord.realizedPnL).toBeGreaterThan(2500);
    expect(closedRecord.realizedR).toBe(2.0);
    expect(closedRecord.openedAt).toBe(order.entryTime);
    expect(closedRecord.closedAt).toBeDefined();

    // Verify journal persistence was called with immutable data
    expect(mockPrisma.signal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entryPrice: 50.0,
          exitPrice: 90.0,
          activatedAt: new Date(order.entryTime),
        }),
      }),
    );
  });
});
