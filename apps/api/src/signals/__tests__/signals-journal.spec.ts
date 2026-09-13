import { Test, TestingModule } from '@nestjs/testing';
import { SignalsService } from '../signals.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CandlesService } from '../../candles/candles.service';
import { BadRequestException } from '@nestjs/common';

describe('SignalsService Journal Validation & Integrity', () => {
  let service: SignalsService;
  let mockPrisma: any;
  let mockCandlesService: any;

  beforeEach(async () => {
    mockPrisma = {
      instrument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'inst-nifty',
          symbol: 'NIFTY',
          name: 'Nifty 50',
          currency: 'INR',
        }),
      },
      signal: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest
          .fn()
          .mockImplementation((args) => Promise.resolve({ id: 'sig-rec-1', ...args.data })),
      },
      paperTrade: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };

    mockCandlesService = {
      getCandles: jest.fn().mockResolvedValue({ candles: [] }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SignalsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CandlesService, useValue: mockCandlesService },
      ],
    }).compile();

    service = module.get<SignalsService>(SignalsService);
  });

  describe('AI FIX 109: Verified vs Legacy Journal Data Selection', () => {
    const buildDataset = () => {
      const trades: any[] = [];
      // 60 legacy trades (missing entry fills / entry price / realized pnl)
      const baseLegacyTs = new Date('2026-09-10T10:00:00.000Z').getTime();
      for (let i = 1; i <= 60; i++) {
        trades.push({
          id: `legacy-pt-${i}`,
          symbol: i % 2 === 0 ? 'BTCUSDT' : 'NIFTY',
          direction: 'BULLISH',
          quantity: 1,
          entryPrice: null,
          entryTime: null,
          exitPrice: 95000,
          exitTime: new Date(baseLegacyTs + i * 60000),
          realizedPnL: null,
          realizedR: null,
          outcomeSnapshotJson: {
            isLegacyExecutionData: true,
            executionDataComplete: false,
            actualEntryPrice: null,
            entryTimeUtc: null,
            durationMs: null,
            netPnlAccount: null,
          },
        });
      }
      // 40 verified trades (complete authoritative fills, prices, timestamps, pnl)
      const baseVerifiedTs = new Date('2026-09-11T10:00:00.000Z').getTime();
      for (let i = 1; i <= 40; i++) {
        const symbol = i % 2 === 0 ? 'BTCUSDT' : 'NIFTY';
        const entryPrice = symbol === 'BTCUSDT' ? 95000 + i * 10 : 24000 + i * 5;
        const exitPrice = symbol === 'BTCUSDT' ? 95500 + i * 10 : 24200 + i * 5;
        const entryTime = new Date(baseVerifiedTs + i * 60000);
        const exitTime = new Date(baseVerifiedTs + (i + 15) * 60000);

        trades.push({
          id: `verified-pt-${i}`,
          symbol,
          direction: 'BULLISH',
          quantity: symbol === 'BTCUSDT' ? 0.05 : 50,
          entryPrice,
          entryTime,
          exitPrice,
          exitTime,
          realizedPnL: 500 * i,
          realizedR: 2.5,
          outcomeClassification: 'TP2_HIT',
          exitReason: 'Target 2 Completed (2.5R Full TP)',
          chargesJson: { totalCharges: 15.0 },
          outcomeSnapshotJson: {
            executionPriceSource: 'PAPER_FILL',
            entryFillCount: 1,
            exitFillCount: 1,
            executionDataComplete: true,
            isLegacyExecutionData: false,
            actualEntryPrice: entryPrice,
            actualEntryPriceCurrency: symbol === 'BTCUSDT' ? 'USDT' : 'INR',
            entryTimeUtc: entryTime.toISOString(),
            actualExitPrice: exitPrice,
            actualExitPriceCurrency: symbol === 'BTCUSDT' ? 'USDT' : 'INR',
            exitTimeUtc: exitTime.toISOString(),
            durationMs: exitTime.getTime() - entryTime.getTime(),
            netPnlAccount: 500 * i,
            quotePnl: symbol === 'BTCUSDT' ? 25 : 500 * i,
            accountingSnapshot: {
              accountCurrency: 'INR',
              quoteCurrency: symbol === 'BTCUSDT' ? 'USDT' : 'INR',
              rate: symbol === 'BTCUSDT' ? 90.0 : 1.0,
            },
          },
        });
      }
      return trades;
    };

    it('should query only verified trades at database level with limit=20', async () => {
      const dataset = buildDataset();
      const verifiedTrades = dataset.filter((t) => t.entryPrice !== null && t.realizedPnL !== null);
      const legacyTrades = dataset.filter((t) => t.entryPrice === null || t.realizedPnL === null);

      mockPrisma.paperTrade.count.mockImplementation((args: any) => {
        if (args?.where?.entryPrice?.not !== undefined) {
          return Promise.resolve(verifiedTrades.length); // 40
        }
        return Promise.resolve(legacyTrades.length); // 60
      });

      mockPrisma.paperTrade.findMany.mockImplementation((args: any) => {
        let rows = dataset;
        if (args?.where?.entryPrice?.not !== undefined) {
          rows = verifiedTrades;
        } else if (args?.where?.OR) {
          rows = legacyTrades;
        }
        // sort exitTime desc
        const sorted = [...rows].sort((a, b) => b.exitTime.getTime() - a.exitTime.getTime());
        return Promise.resolve(sorted.slice(0, args.take || 50));
      });

      const response = await service.getCompletedTrades(20, 'VERIFIED');

      expect(mockPrisma.paperTrade.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            entryPrice: { not: null },
            entryTime: { not: null },
            realizedPnL: { not: null },
            realizedR: { not: null },
          }),
          take: 20,
          orderBy: { exitTime: 'desc' },
        }),
      );

      expect(response.trades).toHaveLength(20);
      expect(response.trades.every((t: any) => t.executionDataComplete === true)).toBe(true);
      expect(response.trades.every((t: any) => t.isLegacyExecutionData === false)).toBe(true);
      expect(response.stats.totalTrades).toBe(20);
      expect(response.stats.totalVerifiedTrades).toBe(40);
      expect(response.stats.legacyTradeCount).toBe(60);
    });

    it('should return all 40 verified trades when limit=50', async () => {
      const dataset = buildDataset();
      const verifiedTrades = dataset.filter((t) => t.entryPrice !== null && t.realizedPnL !== null);

      mockPrisma.paperTrade.count.mockResolvedValueOnce(40).mockResolvedValueOnce(60);
      mockPrisma.paperTrade.findMany.mockImplementation((args: any) => {
        const sorted = [...verifiedTrades].sort((a, b) => b.exitTime.getTime() - a.exitTime.getTime());
        return Promise.resolve(sorted.slice(0, args.take || 50));
      });

      const response = await service.getCompletedTrades(50, 'VERIFIED');

      expect(response.trades).toHaveLength(40);
      expect(response.trades.every((t: any) => t.executionDataComplete === true)).toBe(true);
      expect(response.trades.every((t: any) => t.actualEntryPrice !== null)).toBe(true);
      expect(response.trades.every((t: any) => t.entryTimeUtc !== null)).toBe(true);
    });

    it('should return legacy records when executionData is LEGACY or ALL', async () => {
      const dataset = buildDataset();
      const legacyTrades = dataset.filter((t) => t.entryPrice === null || t.realizedPnL === null);

      mockPrisma.paperTrade.count.mockResolvedValueOnce(40).mockResolvedValueOnce(60);
      mockPrisma.paperTrade.findMany.mockImplementation((args: any) => {
        return Promise.resolve(legacyTrades.slice(0, args.take || 50));
      });

      const response = await service.getCompletedTrades(20, 'LEGACY');

      expect(response.trades).toHaveLength(20);
      expect(response.trades.every((t: any) => t.isLegacyExecutionData === true)).toBe(true);
      expect(response.trades.every((t: any) => t.executionDataComplete === false)).toBe(true);
      // Assert legacy trades have null execution values
      expect(response.trades.every((t: any) => t.actualEntryPrice === null)).toBe(true);
      expect(response.trades.every((t: any) => t.entryTimeUtc === null)).toBe(true);
      expect(response.trades.every((t: any) => t.netPnlAccount === null)).toBe(true);
      expect(response.trades.every((t: any) => t.pnlAmount === null)).toBe(true);
      expect(response.trades.every((t: any) => t.durationMs === null)).toBe(true);
    });

    it('should correctly format multi-currency for verified BTCUSDT trades (USDT price, INR P&L)', async () => {
      const btcVerifiedTrade = {
        id: 'pt-btc-verified',
        symbol: 'BTCUSDT',
        direction: 'BULLISH',
        quantity: 0.1,
        entryPrice: 95000.0,
        entryTime: new Date('2026-09-12T10:00:00.000Z'),
        exitPrice: 96000.0,
        exitTime: new Date('2026-09-12T11:00:00.000Z'),
        realizedPnL: 9000.0, // INR
        realizedR: 2.0,
        outcomeClassification: 'TP2_HIT',
        exitReason: 'Target 2 Completed',
        chargesJson: { totalCharges: 50.0 },
        outcomeSnapshotJson: {
          executionPriceSource: 'PAPER_FILL',
          entryFillCount: 1,
          exitFillCount: 1,
          executionDataComplete: true,
          isLegacyExecutionData: false,
          actualEntryPrice: 95000.0,
          actualEntryPriceCurrency: 'USDT',
          entryTimeUtc: '2026-09-12T10:00:00.000Z',
          actualExitPrice: 96000.0,
          actualExitPriceCurrency: 'USDT',
          exitTimeUtc: '2026-09-12T11:00:00.000Z',
          durationMs: 3600000,
          netPnlAccount: 9000.0,
          quotePnl: 100.0,
          accountingSnapshot: {
            accountCurrency: 'INR',
            quoteCurrency: 'USDT',
            rate: 90.0,
          },
        },
      };

      mockPrisma.paperTrade.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
      mockPrisma.paperTrade.findMany.mockResolvedValue([btcVerifiedTrade]);

      const response = await service.getCompletedTrades(10, 'VERIFIED');

      expect(response.trades).toHaveLength(1);
      const trade = response.trades[0];
      expect(trade.symbol).toBe('BTCUSDT');
      expect(trade.actualEntryPrice).toBe(95000.0);
      expect(trade.actualEntryPriceCurrency).toBe('USDT');
      expect(trade.actualExitPrice).toBe(96000.0);
      expect(trade.actualExitPriceCurrency).toBe('USDT');
      expect(trade.accountCurrency).toBe('INR');
      expect(trade.netPnlAccount).toBe(9000.0);
      expect(trade.quoteCurrency).toBe('USDT');
      expect(trade.quotePnl).toBe(100.0);
      expect(trade.entryTimeUtc).toBe('2026-09-12T10:00:00.000Z');
      expect(trade.executionDataComplete).toBe(true);
      expect(trade.isLegacyExecutionData).toBe(false);
    });

    it('should correctly distinguish requestedEntryPrice from actualEntryPrice when slippage occurs', async () => {
      const slippedTrade = {
        id: 'pt-slippage-1',
        symbol: 'BTCUSDT',
        direction: 'BULLISH',
        quantity: 0.1,
        entryPrice: 95005.0, // actual fill
        entryTime: new Date('2026-09-12T10:00:00.000Z'),
        exitPrice: 96000.0,
        exitTime: new Date('2026-09-12T11:00:00.000Z'),
        realizedPnL: 8955.0,
        realizedR: 1.9,
        outcomeClassification: 'TP2_HIT',
        exitReason: 'Target 2 Completed',
        chargesJson: { totalCharges: 50.0 },
        outcomeSnapshotJson: {
          executionPriceSource: 'PAPER_FILL',
          entryFillCount: 1,
          exitFillCount: 1,
          executionDataComplete: true,
          isLegacyExecutionData: false,
          requestedEntryPrice: 95000.0, // original requested order price
          actualEntryPrice: 95005.0, // actual execution price from fill
          actualEntryPriceCurrency: 'USDT',
          entryTimeUtc: '2026-09-12T10:00:00.000Z',
          actualExitPrice: 96000.0,
          actualExitPriceCurrency: 'USDT',
          exitTimeUtc: '2026-09-12T11:00:00.000Z',
          durationMs: 3600000,
          netPnlAccount: 8955.0,
          quotePnl: 99.5,
          accountingSnapshot: {
            accountCurrency: 'INR',
            quoteCurrency: 'USDT',
            rate: 90.0,
          },
        },
      };

      mockPrisma.paperTrade.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
      mockPrisma.paperTrade.findMany.mockResolvedValue([slippedTrade]);

      const response = await service.getCompletedTrades(10, 'VERIFIED');

      expect(response.trades).toHaveLength(1);
      const trade = response.trades[0];
      expect(trade.requestedEntryPrice).toBe(95000.0);
      expect(trade.actualEntryPrice).toBe(95005.0);
      expect(trade.requestedEntryPrice).not.toEqual(trade.actualEntryPrice);
    });

    it('should never fallback to legacy Signal records in VERIFIED mode when paper trades are empty', async () => {
      mockPrisma.paperTrade.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
      mockPrisma.paperTrade.findMany.mockResolvedValue([]);
      mockPrisma.signal.findMany.mockResolvedValue([
        {
          id: 'legacy-sig-1',
          instrument: { symbol: 'NIFTY', name: 'Nifty 50', currency: 'INR' },
          direction: 'BULLISH',
          state: 'TP1_HIT',
          entryPrice: 24000,
          exitPrice: 24200,
          closedAt: new Date(),
        },
      ]);

      const response = await service.getCompletedTrades(50, 'VERIFIED');

      expect(response.trades).toEqual([]);
      expect(mockPrisma.signal.findMany).not.toHaveBeenCalled();
    });

    it('should not assume INR when instrument currency is missing and fail closed by marking execution incomplete', async () => {
      const unknownSymbolTrade = {
        id: 'pt-unknown-1',
        symbol: 'UNKNOWN_TICKER',
        direction: 'BULLISH',
        quantity: 10,
        entryPrice: 100.0,
        entryTime: new Date('2026-09-12T10:00:00.000Z'),
        exitPrice: 110.0,
        exitTime: new Date('2026-09-12T10:30:00.000Z'),
        realizedPnL: 100.0,
        realizedR: 1.0,
        outcomeSnapshotJson: {
          executionPriceSource: 'PAPER_FILL',
          executionDataComplete: true,
          actualEntryPrice: 100.0,
          // Missing quoteCurrency and accountingSnapshot
        },
      };

      mockPrisma.paperTrade.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
      mockPrisma.paperTrade.findMany.mockResolvedValue([unknownSymbolTrade]);

      const response = await service.getCompletedTrades(10, 'ALL');

      expect(response.trades).toHaveLength(1);
      const trade = response.trades[0];
      // Must not default missing currency to INR
      expect(trade.currency).toBeNull();
      expect(trade.executionDataComplete).toBe(false);
      expect(trade.isLegacyExecutionData).toBe(true);
      expect(trade.actualEntryPrice).toBeNull();
    });
  });

  it('should record completed trade with valid immutable entry and exit data', async () => {
    const activatedAt = new Date('2026-09-03T09:30:00.000Z');
    const closedAt = new Date('2026-09-03T10:15:00.000Z');

    const result = await service.recordCompletedTrade({
      symbol: 'NIFTY',
      contractSymbol: 'NIFTY 24100 PE',
      instrumentType: 'OPTION',
      strike: 24100,
      optionType: 'PE',
      direction: 'BEARISH',
      state: 'TP2_HIT',
      entryPrice: 50.0,
      stopLoss: 30.0,
      target1: 80.0,
      target2: 110.0,
      exitPrice: 110.0,
      pnlAmount: 3900.0,
      pnlRMultiple: 3.0,
      exitReason: 'Target 2 Hit',
      activatedAt,
      closedAt,
    });

    expect(result).toBeDefined();
    expect(mockPrisma.signal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entryPrice: 50.0,
          exitPrice: 110.0,
          pnlAmount: 3900.0,
          pnlRMultiple: 3.0,
          activatedAt,
          closedAt,
        }),
      }),
    );
  });

  it('should reject trade recording if entryPrice is non-positive or invalid', async () => {
    await expect(
      service.recordCompletedTrade({
        symbol: 'NIFTY',
        direction: 'BULLISH',
        state: 'TP1_HIT',
        entryPrice: 0,
        stopLoss: 24000,
        target1: 24200,
        target2: 24300,
        exitPrice: 24200,
        pnlAmount: 1000,
        pnlRMultiple: 1.5,
        exitReason: 'TP1',
        activatedAt: new Date(),
        closedAt: new Date(),
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject trade recording if exitPrice is non-positive or invalid', async () => {
    await expect(
      service.recordCompletedTrade({
        symbol: 'NIFTY',
        direction: 'BULLISH',
        state: 'TP1_HIT',
        entryPrice: 24100,
        stopLoss: 24000,
        target1: 24200,
        target2: 24300,
        exitPrice: -50,
        pnlAmount: -1000,
        pnlRMultiple: -1.0,
        exitReason: 'Invalid',
        activatedAt: new Date(),
        closedAt: new Date(),
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject trade recording if closedAt timestamp is before activatedAt', async () => {
    const activatedAt = new Date('2026-09-03T10:00:00.000Z');
    const closedAt = new Date('2026-09-03T09:00:00.000Z'); // earlier than activatedAt

    await expect(
      service.recordCompletedTrade({
        symbol: 'NIFTY',
        direction: 'BULLISH',
        state: 'TP1_HIT',
        entryPrice: 24100,
        stopLoss: 24000,
        target1: 24200,
        target2: 24300,
        exitPrice: 24200,
        pnlAmount: 1000,
        pnlRMultiple: 1.5,
        exitReason: 'TP1',
        activatedAt,
        closedAt,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should deduplicate existing identical trade records', async () => {
    const activatedAt = new Date('2026-09-03T09:30:00.000Z');
    const closedAt = new Date('2026-09-03T10:15:00.000Z');

    const existingRecord = {
      id: 'sig-existing',
      instrumentId: 'inst-nifty',
      entryPrice: 50.0,
      exitPrice: 110.0,
      activatedAt,
      closedAt,
    };

    mockPrisma.signal.findFirst.mockResolvedValue(existingRecord);

    const result = await service.recordCompletedTrade({
      symbol: 'NIFTY',
      direction: 'BEARISH',
      state: 'TP2_HIT',
      entryPrice: 50.0,
      stopLoss: 30.0,
      target1: 80.0,
      target2: 110.0,
      exitPrice: 110.0,
      pnlAmount: 3900.0,
      pnlRMultiple: 3.0,
      exitReason: 'Target 2 Hit',
      activatedAt,
      closedAt,
    });

    expect(result).toBe(existingRecord);
    expect(mockPrisma.signal.create).not.toHaveBeenCalled();
  });

  it('should generate tax-compliant CSV export with fee breakdown and headers', async () => {
    const mockCompletedTrades = [
      {
        id: 'sig-trade-1',
        instrument: { symbol: 'NIFTY', name: 'Nifty 50', currency: 'INR' },
        direction: 'BEARISH',
        state: 'TP2_HIT',
        grade: 'A_PLUS',
        score: 95,
        timeframe: 'M15',
        entryPrice: 50.0,
        stopLoss: 30.0,
        target1: 80.0,
        target2: 110.0,
        exitPrice: 110.0,
        pnlAmount: 3840.0,
        pnlRMultiple: 3.0,
        reasonsJson: {
          contractSymbol: 'NIFTY 24100 PE',
          instrumentType: 'OPTION',
          strike: 24100,
          optionType: 'PE',
          quantity: 65,
          tradeReason: 'NIFTY 24100 PE Bearish Execution',
          exitReason: 'TP2 Hit',
        },
        activatedAt: new Date('2026-09-03T09:30:00.000Z'),
        closedAt: new Date('2026-09-03T10:15:00.000Z'),
      },
    ];

    mockPrisma.signal.findMany.mockResolvedValue(mockCompletedTrades);

    const { filename, csvContent } = await service.exportTradesToCsv();

    expect(filename).toContain('quant-trade-journal-tax-report-');
    expect(filename).toContain('.csv');
    expect(csvContent).toContain('Trade ID,Symbol,Contract,Asset Type');
    expect(csvContent).toContain('Turnover (INR)');
    expect(csvContent).toContain('Brokerage (INR)');
    expect(csvContent).toContain('STT (INR)');
    expect(csvContent).toContain('GST 18% (INR)');
    expect(csvContent).toContain('NIFTY 24100 PE');
    expect(csvContent).toContain('10400.00');
    expect(csvContent).toContain('40.00');
  });
});
