import { Timeframe } from '@quant/shared';
import { ScannerService } from '../scanner.service';

/**
 * Scanner leader lease regressions:
 * 1. A lease left behind by a system clock jump (Redis absolute expiry months away) blocked every scan,
 *    so no signal reached any bot and nothing traded.
 * 2. The lease was never released, so in each cycle the SMC scan's own lease blocked the SAIYAN_OCC and
 *    HYBRID scans that immediately followed it.
 */
describe('ScannerService leader lease', () => {
  // Minimal in-memory Redis with SET NX PX, GET, PTTL and compare-and-delete EVAL semantics.
  const fakeRedis = () => {
    const store = new Map<string, { value: string; expiresAt: number }>();
    const live = (k: string) => {
      const e = store.get(k);
      if (e && e.expiresAt <= Date.now()) store.delete(k);
      return store.get(k);
    };
    const client = {
      status: 'ready',
      set: jest.fn(async (k: string, v: string, _px: string, ms: number, nx?: string) => {
        if (nx === 'NX' && live(k)) return null;
        store.set(k, { value: v, expiresAt: Date.now() + ms });
        return 'OK';
      }),
      get: jest.fn(async (k: string) => live(k)?.value ?? null),
      pttl: jest.fn(async (k: string) => {
        const e = live(k);
        return e ? e.expiresAt - Date.now() : -2;
      }),
      eval: jest.fn(async (_script: string, _n: number, k: string, expected: string) => {
        if (live(k)?.value === expected) {
          store.delete(k);
          return 1;
        }
        return 0;
      }),
      publish: jest.fn(async () => 1),
    };
    return { client, store, service: { getClient: () => client, set: jest.fn(), get: jest.fn() } as any };
  };

  const signalsService: any = { getAllSignals: jest.fn().mockResolvedValue([]) };
  const algoBotsService: any = { recordScanTime: jest.fn(), evaluateSignalForBots: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  it('recovers a lease stranded by a backwards clock jump (TTL longer than any lease)', async () => {
    const redis = fakeRedis();
    // Legacy 8s lease that Redis now believes expires ~71 days from now
    redis.store.set('scanner:leader', { value: 'instance_90947_qyh92o', expiresAt: Date.now() + 71 * 86_400_000 });

    const scanner = new ScannerService(redis.service, signalsService, algoBotsService);
    const res: any = await scanner.triggerScan(Timeframe.M15, 'SMC');

    expect(res.status).not.toBe('SKIPPED_FOLLOWER_INSTANCE');
    expect(signalsService.getAllSignals).toHaveBeenCalledTimes(1);
  });

  it('releases the lease after each scan so SMC, SAIYAN_OCC and HYBRID all run in one cycle', async () => {
    const redis = fakeRedis();
    const scanner = new ScannerService(redis.service, signalsService, algoBotsService);

    for (const strategy of ['SMC', 'SAIYAN_OCC', 'HYBRID']) {
      const res: any = await scanner.triggerScan(Timeframe.M15, strategy);
      expect(res.status).not.toBe('SKIPPED_FOLLOWER_INSTANCE');
    }
    expect(signalsService.getAllSignals).toHaveBeenCalledTimes(3);
    expect(redis.store.has('scanner:leader')).toBe(false);
  });

  it('still respects a live lease held by another instance', async () => {
    const redis = fakeRedis();
    redis.store.set('scanner:leader', {
      value: JSON.stringify({ token: 'other_instance', acquiredAt: Date.now() }),
      expiresAt: Date.now() + 30_000,
    });

    const scanner = new ScannerService(redis.service, signalsService, algoBotsService);
    const res: any = await scanner.triggerScan(Timeframe.M15, 'SMC');

    expect(res.status).toBe('SKIPPED_FOLLOWER_INSTANCE');
    expect(signalsService.getAllSignals).not.toHaveBeenCalled();
  });
});
