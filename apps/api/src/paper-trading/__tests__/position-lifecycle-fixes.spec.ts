import { Direction, PositionState } from '@quant/shared';
import { PaperTradingService } from '../paper-trading.service';
import { PaperPositionMonitorService } from '../paper-position-monitor.service';

/**
 * Regression suite for position-lifecycle audit fixes:
 * - partial exits are whole tradeable units (whole option lots)
 * - portfolio equity counts entry fees once (they are already deducted from cash at fill)
 */
describe('Position lifecycle fixes', () => {
  const snapshot = {
    fxRate: 1,
    contractSize: 1,
    quoteCurrency: 'INR',
    accountCurrency: 'INR',
    snapshotHash: 'test',
  };

  const optionPosition = (quantity: number) => ({
    id: 'pos-opt',
    accountId: 'acc-1',
    symbol: 'NIFTY',
    contractSymbol: 'NIFTY 24200 CE',
    instrumentType: 'OPTION',
    strike: 24200,
    optionType: 'CE',
    direction: Direction.BULLISH,
    quantity,
    entryPrice: 56.63,
    currentPrice: 56.63,
    stopLoss: 36.81,
    initialStopLoss: 36.81,
    target1: 86.36,
    target2: 106.18,
    target3: 135.91,
    initialTarget1: 86.36,
    initialTarget2: 106.18,
    leverage: 1,
    usedMargin: Number((56.63 * quantity).toFixed(2)),
    unrealizedPnL: 0,
    unrealizedR: 0,
    maxFavorableExcursion: 0,
    maxAdverseExcursion: 0,
    status: PositionState.OPEN,
    chargesJson: { totalCharges: 40 },
    executionEventsJson: { accountingSnapshot: snapshot, partialLegs: [] },
    entryTime: new Date(),
    openedAt: new Date(),
    correlationId: 'corr-1',
  });

  describe('Whole-lot partial exits', () => {
    const buildMonitor = () => {
      const prisma: any = {
        paperOrder: { findFirst: jest.fn().mockResolvedValue(null) },
        $transaction: jest.fn(),
      };
      const paperTrading: any = {
        calculateCharges: jest.fn().mockReturnValue({ totalCharges: 10 }),
      };
      return { monitor: new PaperPositionMonitorService(prisma, paperTrading, {} as any), prisma };
    };

    it('refuses a 30% partial of a single 65-unit option lot (19.5 units is not tradeable)', async () => {
      const { monitor, prisma } = buildMonitor();
      await expect(
        monitor.executePartialScaleOut(optionPosition(65), 'TP1', 86.36, 86.36, new Date(), 0.3),
      ).rejects.toThrow(/PARTIAL_BELOW_ONE_LOT/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('floors a 30% partial of 4 lots (78 units) to exactly one lot (65 units)', async () => {
      const { monitor, prisma } = buildMonitor();
      prisma.$transaction.mockResolvedValue(undefined);
      const res = await monitor.executePartialScaleOut(
        optionPosition(260),
        'TP1',
        86.36,
        86.36,
        new Date(),
        0.3,
      );
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(res).not.toBeNull();
      expect(res!.partialQty).toBe(65);
      expect(res!.remainingQuantity).toBe(195);
    });
  });

  describe('Portfolio equity', () => {
    it('counts entry fees once: equity right after entry = initial capital - entry fees', async () => {
      const entryFees = 40;
      const account = {
        id: 'acc-1',
        initialCapital: 1000000,
        cashBalance: 1000000 - entryFees, // entry fees already deducted at fill
        usedMargin: 3680.95,
        realizedPnL: -entryFees,
        totalChargesPaid: entryFees,
        tradingMode: 'PAPER',
      };
      const prisma: any = {
        paperPosition: { findMany: jest.fn().mockResolvedValue([optionPosition(65)]) },
        paperTrade: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const service = new PaperTradingService(prisma, {} as any);
      jest.spyOn(service as any, 'getOrCreateAccount').mockResolvedValue(account);
      // Market still at the entry premium: gross unrealized P&L is zero.
      jest
        .spyOn(service, 'resolveLivePositionQuote')
        .mockResolvedValue({ price: 56.63, timestamp: new Date(), symbol: 'NIFTY 24200 CE' });

      const portfolio = await service.getPortfolio();

      expect(portfolio.totalEquity).toBe(1000000 - entryFees); // not 1000000 - 2 x fees
      expect(portfolio.openPositions[0].unrealizedPnL).toBe(-entryFees); // per-trade view includes its cost
    });
  });
});
