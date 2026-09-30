import { Timeframe } from '@quant/shared';
import { ChartSnapshotValidator } from '@quant/trading-engine';
import { CandlesService } from '../candles.service';

/**
 * Regression: the chart snapshot's livePrice comes from the authoritative live quote, but the validator
 * (used by the web app) requires livePrice === formingCandle.close. When the two came from different
 * sources (Yahoo quote vs candle feed for NIFTY) every NIFTY snapshot was rejected and the UI showed
 * "MARKET DATA UNAVAILABLE". The quote must be folded into the forming candle.
 */
describe('Chart data folds the live quote into the forming candle', () => {
  const formingStart = new Date(Date.UTC(2026, 8, 30, 6, 15, 0));

  const buildService = (quote: { price: number; marketEventTime: string } | null) => {
    const prisma: any = {
      instrument: {
        findUnique: jest.fn().mockResolvedValue({ id: 'inst_nifty', symbol: 'NIFTY', isActive: true }),
      },
    };
    const streamer: any = {
      getAuthoritativeSnapshot: jest.fn().mockImplementation(() => {
        if (!quote) throw new Error('no quote');
        return { symbol: 'NIFTY', price: quote.price, marketEventTime: quote.marketEventTime, isFresh: true };
      }),
    };
    const service = new CandlesService(prisma, {} as any, {} as any, streamer);

    const closed = Array.from({ length: 80 }, (_, i) => {
      const t = new Date(formingStart.getTime() - (80 - i) * 15 * 60 * 1000);
      const base = 22700 + Math.sin(i / 5) * 20;
      return { timestamp: t, open: base, high: base + 8, low: base - 8, close: base + 2, volume: 1, isClosed: true };
    });
    jest.spyOn(service, 'getCandles').mockResolvedValue({
      candles: closed,
      formingCandle: {
        timestamp: formingStart,
        open: 22725,
        high: 22731,
        low: 22720,
        close: 22729.7, // candle feed close
        volume: 1,
        isClosed: false,
      },
      dataProvenance: 'LIVE',
      sourceIdentity: 'NSE_LIVE_STREAM',
    } as any);
    return service;
  };

  it('uses the live quote as the forming close and passes the chart snapshot validator', async () => {
    const service = buildService({
      price: 22732.25, // live quote differs from the candle close
      marketEventTime: new Date(formingStart.getTime() + 5 * 60 * 1000).toISOString(),
    });

    const snap = await service.getChartData('NIFTY', Timeframe.M15);

    expect(snap.livePrice).toBe(22732.25);
    expect(snap.formingCandle?.close).toBe(22732.25);
    expect(snap.formingCandle?.high).toBe(22732.25); // widened to include the live price
    expect(snap.marketAsOf).toBeDefined();
    expect(ChartSnapshotValidator.validateSnapshot(snap as any).isValid).toBe(true);
  });

  it('ignores a quote outside the forming candle window and stays internally consistent', async () => {
    const service = buildService({
      price: 22800,
      marketEventTime: new Date(formingStart.getTime() + 20 * 60 * 1000).toISOString(), // next bar
    });

    const snap = await service.getChartData('NIFTY', Timeframe.M15);

    expect(snap.livePrice).toBe(22729.7);
    expect(snap.formingCandle?.close).toBe(22729.7);
    expect(ChartSnapshotValidator.validateSnapshot(snap as any).isValid).toBe(true);
  });

  it('without a live quote falls back to candle data (degraded) but remains valid', async () => {
    const service = buildService(null);
    const snap = await service.getChartData('NIFTY', Timeframe.M15);
    expect(snap.livePrice).toBe(22729.7);
    expect(snap.isDegraded).toBe(true);
    expect(ChartSnapshotValidator.validateSnapshot(snap as any).isValid).toBe(true);
  });
});
