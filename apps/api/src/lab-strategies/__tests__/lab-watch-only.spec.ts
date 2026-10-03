import { LabStrategiesService } from '../lab-strategies.service';
import { CandlesService } from '../../candles/candles.service';

describe('lab runner: watch-only instruments', () => {
  // Fully validated strategy (development + validation + golden) with a confirmed shadow record (see lab-lifecycle.spec)
  const ref = {
    expectancyR: 0.43, sdR: 2.2, trades: 400, maxDrawdownR: 10.3,
    evidence: { holdOut: { trades: 120, expectancyR: 0.4, tStat: 2.6 } },
    golden: { passed: true, trades: 50, expectancyR: 0.3, datasetVersion: 'X@2026-10-01#1' },
  };
  const goodShadow = Array.from({ length: 40 }, (_, i) => ({ netR: i % 5 < 3 ? 2 : -1, exitReason: 'TARGET' }));

  const setup = () => {
    const prisma: any = {
      labStrategyTrade: { findMany: jest.fn().mockResolvedValue(goodShadow) },
      labStrategy: { update: jest.fn().mockResolvedValue({}) },
      labPromotionRecord: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
    };
    const service = new LabStrategiesService(prisma, {} as any, {} as any, {} as any);
    return { prisma, service };
  };

  it('promotes a perpetual-futures strategy that passed its shadow test', async () => {
    const { prisma, service } = setup();
    await (service as any).applyLifecycle({ id: 'btc', symbol: 'BTCUSDT_PERP', status: 'SHADOW', backtestJson: ref, strategyVersion: 'sv-1' });
    expect(prisma.labStrategy.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'LIVE' }) }));
    // the promotion is recorded with the exact evidence, rules version and strategy version
    const rec = prisma.labPromotionRecord.create.mock.calls[0][0].data;
    expect(rec).toMatchObject({ strategyId: 'btc', strategyVersion: 'sv-1', datasetVersion: 'X@2026-10-01#1', lifecycleRulesVersion: 'lifecycle/v2' });
    expect(rec.evidenceJson.evidence.current.trades).toBe(40);
    // only trades of the current strategy version count as evidence
    expect(prisma.labStrategyTrade.findMany.mock.calls[0][0].where).toMatchObject({ strategyVersion: 'sv-1', mode: 'SHADOW' });
  });

  it('keeps a NIFTY strategy in SHADOW (watch only) even when it qualifies for promotion', async () => {
    const { prisma, service } = setup();
    await (service as any).applyLifecycle({ id: 'nifty', symbol: 'NIFTY', status: 'SHADOW', backtestJson: ref, strategyVersion: 'sv-2' });
    const calls = prisma.labStrategy.update.mock.calls.map((c: any[]) => c[0].data);
    expect(calls.some((d: any) => d.status === 'LIVE')).toBe(false);
    expect(calls[0].statusReason).toMatch(/stays in SHADOW \(watch only\)/);
  });
});

describe('candle cache shared by callers with different history lengths', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('a 500-candle request after a 200-candle request is not served the cached 200', async () => {
    const H1 = 3_600_000;
    const start = Math.floor(Date.now() / H1) * H1 - 600 * H1;
    const fetchMock = jest.fn().mockImplementation(async (url: string) => {
      const n = Number(new URL(url).searchParams.get('limit'));
      const rows = Array.from({ length: n }, (_, i) => {
        const t = start + (600 - n + i) * H1;
        return [t, '100', '101', '99', '100.5', '10', t + H1 - 1];
      });
      return { ok: true, status: 200, json: async () => rows } as any;
    });
    global.fetch = fetchMock as any;
    const candles = new CandlesService({} as any, {} as any, {} as any);

    const a = await (candles as any).fetchRealExchangeCandles('BTCUSDT_PERP', '1h', 200);
    const b = await (candles as any).fetchRealExchangeCandles('BTCUSDT_PERP', '1h', 500);
    const c = await (candles as any).fetchRealExchangeCandles('BTCUSDT_PERP', '1h', 100);
    expect(a).toHaveLength(200);
    expect(b).toHaveLength(500);
    expect(c).toHaveLength(100); // served from the 500-candle cache entry
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
