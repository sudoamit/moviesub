import { LabDiscoveryService } from '../lab-discovery.service';

describe('LabDiscoveryService.apply', () => {
  const created: any[] = [];
  const updated: any[] = [];
  const prisma: any = {
    labStrategy: {
      create: jest.fn(async ({ data }: any) => { created.push(data); return data; }),
      update: jest.fn(async (args: any) => { updated.push(args); return args.data; }),
    },
  };
  const service = new LabDiscoveryService(prisma);
  const reference = { expectancyR: 0.3, sdR: 2, trades: 120, tradesPerYear: 20, winRate: 0.4, profitFactor: 1.6, maxDrawdownR: 9, tStat: 2.4, medianStopPct: 0.03 };

  it('registers new candidates as SHADOW with a safe leverage, skips existing ids and unknown instruments, refreshes references', async () => {
    const result = {
      candidates: [
        { id: 'BTCUSDT_PERP:4h:NEW', symbol: 'BTCUSDT_PERP', timeframe: '4h', genome: { trigger: 'EMA_CROSS' }, description: 'Long & short on EMA_CROSS', path: 'CROSS_MARKET', reference, evidence: {} },
        { id: 'BTCUSDT_PERP:4h:OLD', symbol: 'BTCUSDT_PERP', timeframe: '4h', genome: {}, description: 'dup', path: 'STRICT', reference, evidence: {} },
        { id: 'NOPE:1h:X', symbol: 'NOPE', timeframe: '1h', genome: {}, description: 'unknown instrument', path: 'STRICT', reference, evidence: {} },
      ],
      refreshedReferences: [{ id: 'BTCUSDT_PERP:4h:OLD', reference: { ...reference, expectancyR: 0.41 } }],
    };
    const existing = [{ id: 'BTCUSDT_PERP:4h:OLD', backtestJson: { expectancyR: 0.43, caveat: 'keep me' } }];

    const registered = await service.apply(result, existing);

    expect(registered).toEqual(['BTCUSDT_PERP:4h:NEW']);
    expect(created).toHaveLength(1);
    expect(created[0].status).toBe('SHADOW');
    // 1 / (2 x 3% + 0.4%) = 15.6 -> 15x (BTC perp max is 50x)
    expect(created[0].leverage).toBe(15);
    expect(created[0].backtestJson.discoveryPath).toBe('CROSS_MARKET');
    expect(updated).toHaveLength(1);
    expect(updated[0].data.backtestJson.expectancyR).toBe(0.41);
    expect(updated[0].data.backtestJson.caveat).toBe('keep me');
  });
});
