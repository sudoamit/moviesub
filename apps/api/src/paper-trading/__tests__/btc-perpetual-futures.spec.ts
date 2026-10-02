import { Direction, PositionState } from '@quant/shared';
import { PaperTradingService } from '../paper-trading.service';
import { PaperPositionMonitorService } from '../paper-position-monitor.service';

/**
 * BTCUSDT_PERP: Binance USDⓈ-M perpetual traded as an isolated-margin future.
 * - long AND short allowed (BTCUSDT_SPOT stays long-only)
 * - margin = notional / leverage (default 5x), 0.05% taker fees
 * - the stop must sit before the liquidation price
 * - funding settles from exchange-settled rates; liquidation closes at the bankruptcy price
 */
describe('BTC perpetual futures (BTCUSDT_PERP)', () => {
  let btc = 60000;
  const account = { id: 'acc-perp', currency: 'INR', initialCapital: 1000000, cashBalance: 1000000, usedMargin: 0 };

  const buildService = (prisma: any, streamerExtras: Record<string, any> = {}) => {
    const streamer = {
      getValidatedTicker: () => ({ price: btc, marketEventTime: Date.now() }),
      ...streamerExtras,
    } as any;
    const service = new PaperTradingService(prisma, {} as any, streamer);
    jest.spyOn(service as any, 'getOrCreateAccount').mockResolvedValue(account);
    jest.spyOn(service as any, 'getSystemConfig').mockResolvedValue({
      emergencyStop: false, maxOpenPositions: 5, maxTradesPerDay: 20, maxConsecutiveLosses: 3,
      maxPositionRiskPercent: 1.0, maxDailyLossPercent: 3.0, maxTotalExposurePercent: 100.0,
      maxLeverage: 5, maxSlippageBps: 0, maxMarketDataAgeSeconds: 5,
    });
    jest.spyOn(service as any, 'rejectOrder').mockResolvedValue(undefined as any);
    jest.spyOn(service as any, 'recordAudit').mockResolvedValue(undefined as any);
    return service;
  };

  const orderPrisma = () => {
    const created: any[] = [];
    const prisma: any = {
      paperOrder: {
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(async ({ data }: any) => ({ id: 'ord-1', ...data, positions: [] })),
      },
      paperPosition: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(async ({ data }: any) => {
          created.push(data);
          return { id: 'pos-1', ...data };
        }),
      },
      paperTrade: { findMany: jest.fn().mockResolvedValue([]) },
      paperFill: { create: jest.fn(async ({ data }: any) => ({ id: 'fill-1', ...data })) },
      paperAccount: { findUnique: jest.fn().mockResolvedValue(account), update: jest.fn() },
      auditEvent: { createMany: jest.fn() },
      $transaction: jest.fn(async (cb: any) => cb(prisma)),
    };
    return { prisma, created };
  };

  beforeEach(() => {
    btc = 60000;
  });

  it('charges the 0.05% futures taker fee (half the 0.1% spot fee)', () => {
    const service = buildService({});
    const perp = service.calculateCharges(600, 'CRYPTO', 1, Date.now(), 'ENTRY', 'BTCUSDT_PERP');
    const spot = service.calculateCharges(600, 'CRYPTO', 1, Date.now(), 'ENTRY', 'BTCUSDT_SPOT');
    expect(perp.totalChargesQuote).toBeCloseTo(0.3, 6);
    expect(spot.totalChargesQuote).toBeCloseTo(0.6, 6);
  });

  it('opens a SHORT with margin = notional / 5x and records the liquidation price', async () => {
    const { prisma, created } = orderPrisma();
    const service = buildService(prisma);

    await service.placeOrder({
      symbol: 'BTCUSDT_PERP', direction: 'SELL', quantity: 0.01, orderType: 'MARKET',
      stopLoss: 60600, target1: 59100, idempotencyKey: 'perp-short-1',
    });

    expect(created).toHaveLength(1);
    const pos = created[0];
    expect(pos.direction).toBe(Direction.BEARISH);
    expect(Number(pos.leverage)).toBe(5);
    const fx = pos.executionEventsJson.accountingSnapshot.fxRate;
    expect(Number(pos.usedMargin)).toBeCloseTo((60000 * 0.01 * fx) / 5, 0);
    // short liquidation = entry x (1 + 1/5 - 0.004)
    expect(pos.executionEventsJson.liquidationPrice).toBeCloseTo(60000 * 1.196, 2);
  });

  it('rejects a stop beyond the liquidation price (20x long with a 6% stop)', async () => {
    const { prisma } = orderPrisma();
    const service = buildService(prisma);

    await expect(
      service.placeOrder({
        symbol: 'BTCUSDT_PERP', direction: 'BUY', quantity: 0.001, orderType: 'MARKET', leverage: 20,
        stopLoss: 56400, target1: 63000, idempotencyKey: 'perp-long-20x',
      }),
    ).rejects.toThrow(/STOP_BEYOND_LIQUIDATION/);
    expect(prisma.paperPosition.create).not.toHaveBeenCalled();
  });

  it('refuses a chased manual entry: long planned at 83,250 (1.5R), market at 83,700 leaves TP1 ~0.21R', async () => {
    btc = 83700;
    const { prisma } = orderPrisma();
    const service = buildService(prisma);
    await expect(
      service.placeOrder({
        symbol: 'BTCUSDT_PERP', direction: 'BUY', quantity: 0.01, orderType: 'MARKET',
        stopLoss: 82826.06, target1: 83886.33, signalPrice: 83250, idempotencyKey: 'perp-chase',
      } as any),
    ).rejects.toThrow(/ENTRY_MISSED_RR_DEGRADED/);
    expect(prisma.paperPosition.create).not.toHaveBeenCalled();
  });

  it('accepts the same setup when the market is at the planned entry', async () => {
    btc = 83260;
    const { prisma } = orderPrisma();
    const service = buildService(prisma);
    await service.placeOrder({
      symbol: 'BTCUSDT_PERP', direction: 'BUY', quantity: 0.01, orderType: 'MARKET',
      stopLoss: 82826.06, target1: 83886.33, signalPrice: 83250, idempotencyKey: 'perp-at-entry',
    } as any);
    expect(prisma.paperPosition.create).toHaveBeenCalledTimes(1);
  });

  it('opens at 50x with margin = notional / 50, and refuses more than 50x', async () => {
    const { prisma, created } = orderPrisma();
    const service = buildService(prisma);
    await service.placeOrder({
      symbol: 'BTCUSDT_PERP', direction: 'SELL', quantity: 0.01, orderType: 'MARKET', leverage: 50,
      stopLoss: 60300, target1: 59550, idempotencyKey: 'perp-50x',
    });
    const pos = created[0];
    expect(Number(pos.leverage)).toBe(50);
    const fx = pos.executionEventsJson.accountingSnapshot.fxRate;
    expect(Number(pos.usedMargin)).toBeCloseTo((60000 * 0.01 * fx) / 50, 0);
    // short liquidation at 50x = entry x (1 + 1/50 - 0.004) = 60,960
    expect(pos.executionEventsJson.liquidationPrice).toBeCloseTo(60960, 2);

    const second = orderPrisma();
    await expect(
      buildService(second.prisma).placeOrder({
        symbol: 'BTCUSDT_PERP', direction: 'SELL', quantity: 0.01, orderType: 'MARKET', leverage: 75,
        stopLoss: 60300, target1: 59550, idempotencyKey: 'perp-75x',
      }),
    ).rejects.toThrow(/LEVERAGE/);
  });

  it('keeps BTC spot long-only', async () => {
    const { prisma } = orderPrisma();
    const service = buildService(prisma);
    await expect(
      service.placeOrder({
        symbol: 'BTCUSDT_SPOT', direction: 'SELL', quantity: 0.01, orderType: 'MARKET',
        stopLoss: 60600, target1: 59100, idempotencyKey: 'spot-short',
      }),
    ).rejects.toThrow(/SPOT_SHORT_SELLING_FORBIDDEN/);
  });

  describe('funding', () => {
    const entry = Date.UTC(2026, 8, 30, 1, 0, 0);
    const settlements = [
      { fundingTime: Date.UTC(2026, 8, 30, 0, 0, 0), fundingRate: 0.001, markPrice: 60000 }, // before entry
      { fundingTime: Date.UTC(2026, 8, 30, 8, 0, 0), fundingRate: 0.0001, markPrice: 60000 },
      { fundingTime: Date.UTC(2026, 8, 30, 16, 0, 0), fundingRate: -0.0002, markPrice: 61000 },
    ];
    const service = buildService({}, { getPerpFundingSettlements: () => settlements });
    const position = (direction: Direction, partialLegs: any[] = []) => ({
      symbol: 'BTCUSDT_PERP',
      direction,
      quantity: 0.01,
      entryTime: new Date(entry),
      executionEventsJson: { initialQuantity: 0.02, partialLegs, accountingSnapshot: { contractSize: 1 } },
    });

    it('a long pays positive funding and receives negative funding, only for events after entry', () => {
      const res = service.computePerpFunding(position(Direction.BULLISH), Date.UTC(2026, 8, 30, 20), 1);
      // 0.02 x 60000 x 0.0001 = 0.12 paid; 0.02 x 61000 x -0.0002 = -0.244 received
      expect(res.events.map((e) => e.amountAccount)).toEqual([0.12, -0.24]);
      expect(res.totalAccount).toBeCloseTo(-0.12, 2);
    });

    it('a short has the opposite sign, and partial exits reduce the quantity charged afterwards', () => {
      const legs = [{ quantity: 0.01, fillTimestamp: new Date(Date.UTC(2026, 8, 30, 10)).toISOString() }];
      const res = service.computePerpFunding(position(Direction.BEARISH, legs), Date.UTC(2026, 8, 30, 20), 1);
      expect(res.events.map((e) => e.quantity)).toEqual([0.02, 0.01]);
      // short: -(0.02 x 60000 x 0.0001) = -0.12 ; -(0.01 x 61000 x -0.0002) = +0.12
      expect(res.events.map((e) => e.amountAccount)).toEqual([-0.12, 0.12]);
    });

    it('flags missing settlement history instead of estimating', () => {
      const noHistory = buildService({}, { getPerpFundingSettlements: () => [] });
      const res = noHistory.computePerpFunding(position(Direction.BULLISH), Date.now(), 1);
      expect(res).toEqual({ totalAccount: 0, events: [], historyAvailable: false });
    });
  });

  it('liquidates at the bankruptcy price when price gaps through the liquidation level', async () => {
    const closePosition = jest.fn().mockResolvedValue({ id: 'trade-1' });
    const paperTradingService: any = { closePosition };
    const streamer: any = {
      getValidatedTicker: () => ({ price: 47000, provenance: 'LIVE_PROVIDER', marketEventTime: Date.now() }),
    };
    const monitor = new PaperPositionMonitorService({} as any, paperTradingService, streamer);
    jest.spyOn(monitor as any, 'publishTradeClosedEvent').mockResolvedValue(undefined);

    await monitor.evaluateSinglePosition({
      id: 'pos-liq',
      symbol: 'BTCUSDT_PERP',
      contractSymbol: 'BTCUSDT_PERP',
      instrumentType: 'SPOT',
      direction: Direction.BULLISH,
      status: PositionState.OPEN,
      quantity: 0.01,
      entryPrice: 60000,
      leverage: 5,
      stopLoss: 59400,
      target1: 61000,
      correlationId: 'corr-liq',
      executionEventsJson: { liquidationPrice: 48240 },
    });

    expect(closePosition).toHaveBeenCalledTimes(1);
    const [id, reason, opts] = closePosition.mock.calls[0];
    expect(id).toBe('pos-liq');
    expect(reason).toBe('Liquidation');
    // long bankruptcy = 60000 x (1 - 1/5)
    expect(opts.exitPriceOverride).toBe(48000);
    expect(opts.outcomeClassification).toBe('LOSS_SL');
  });
});
