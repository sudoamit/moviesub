import { PaperTradingService } from '../paper-trading.service';

describe('reconcileAccountFromLedger', () => {
  it('rebuilds cash, realized P&L, charges and used margin from closed trades and open positions', async () => {
    const account = { id: 'acc', initialCapital: 10000000, cashBalance: 9712231.13, realizedPnL: 892643.7, totalChargesPaid: 2821841.37, usedMargin: 1 };
    const update = jest.fn();
    const prisma: any = {
      paperAccount: { findUnique: jest.fn().mockResolvedValue(account), update },
      paperTrade: { findMany: jest.fn().mockResolvedValue([
        { realizedPnL: -70635.97, fees: 1200 }, { realizedPnL: -74148.76, fees: 1100 }, { realizedPnL: 8, fees: 30 },
      ]) },
      paperPosition: { findMany: jest.fn().mockResolvedValue([
        // open position: entry fee 50, one partial leg +300 net with 20 fee
        { chargesJson: { totalChargesAccount: 50 }, executionEventsJson: { partialLegs: [{ netPnL: 300, fee: 20 }] }, usedMargin: 17000 },
      ]) },
    };
    const service = new PaperTradingService(prisma, {} as any, {} as any);
    jest.spyOn(service as any, 'recordAudit').mockResolvedValue(undefined);

    const res = await service.reconcileAccountFromLedger('acc');

    const realized = -70635.97 - 74148.76 + 8 + (300 - 50);
    expect(res.after.realizedPnL).toBeCloseTo(realized, 2);
    expect(res.after.cashBalance).toBeCloseTo(10000000 + realized, 2);
    expect(res.after.totalChargesPaid).toBeCloseTo(1200 + 1100 + 30 + 50 + 20, 2);
    expect(res.after.usedMargin).toBe(17000);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('dry run reports without writing', async () => {
    const prisma: any = {
      paperAccount: { findUnique: jest.fn().mockResolvedValue({ id: 'a', initialCapital: 100, cashBalance: 1, realizedPnL: 1, totalChargesPaid: 1, usedMargin: 1 }), update: jest.fn() },
      paperTrade: { findMany: jest.fn().mockResolvedValue([]) },
      paperPosition: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new PaperTradingService(prisma, {} as any, {} as any);
    const res = await service.reconcileAccountFromLedger('a', false);
    expect(res.after).toEqual({ cashBalance: 100, realizedPnL: 0, totalChargesPaid: 0, usedMargin: 0 });
    expect(prisma.paperAccount.update).not.toHaveBeenCalled();
  });
});
