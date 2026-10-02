import { prepareSeries } from '@quant/strategy-lab';
import { calibrateOptionModel, ClosedWatchTrade, conditionInsights, entryFeatures, strategyVerdict } from '../nifty-lab-learning';
import { NiftyLabService } from '../nifty-lab.service';

let seed = 3;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
const trade = (p: Partial<ClosedWatchTrade>): ClosedWatchTrade => ({
  strategyId: 's', side: 1, indexPoints: 0, hours: 1, optionPoints: null, modelPoints: null, features: null, ...p,
});

describe('NIFTY lab learning', () => {
  it('learns the real option cost model from live trades (delta, decay per hour, fixed cost)', () => {
    const trades = Array.from({ length: 80 }, () => {
      const idx = rnd() * 200, hours = 0.5 + Math.abs(rnd()) * 5;
      return trade({ indexPoints: idx, hours, optionPoints: 0.72 * idx - 2.1 * hours - 5 + rnd() * 2, modelPoints: 0.8 * idx - 1.5 * hours - 4 });
    });
    const fit = calibrateOptionModel(trades)!;
    expect(fit.delta).toBeCloseTo(0.72, 1);
    expect(fit.thetaPerHour).toBeCloseTo(2.1, 0);
    expect(fit.cost).toBeCloseTo(5, 0);
    expect(fit.modelBias!).toBeLessThan(0); // the assumed model was too optimistic
    expect(calibrateOptionModel(trades.slice(0, 10))).toBeNull(); // not enough real trades
  });

  it('gives live verdicts only after enough trades: watching, confirmed, retire', () => {
    expect(strategyVerdict(Array.from({ length: 5 }, () => trade({ optionPoints: 20 }))).verdict).toBe('WATCHING');
    const good = Array.from({ length: 30 }, (_, i) => trade({ optionPoints: i % 3 === 0 ? -10 : 25 }));
    expect(strategyVerdict(good).verdict).toBe('CONFIRMED');
    const bad = Array.from({ length: 30 }, (_, i) => trade({ optionPoints: i % 4 === 0 ? 15 : -12 }));
    expect(strategyVerdict(bad).verdict).toBe('RETIRE');
    // real prices are preferred over the model
    expect(strategyVerdict([trade({ optionPoints: -5, modelPoints: 50 })]).meanPoints).toBe(-5);
  });

  it('finds an entry condition that goes with better trades, and stays quiet on noise', () => {
    const rows = Array.from({ length: 120 }, () => {
      const pcr = 0.6 + Math.abs(rnd()) * 1.2, noise = rnd();
      return trade({ optionPoints: (pcr - 1) * 60 + rnd() * 20, features: { pcrOi: pcr, minutesFromOpen: noise } });
    });
    const ins = Object.fromEntries(conditionInsights(rows).map((x) => [x.feature, x]));
    expect(ins.pcrOi.status).toBe('LEARNED');
    expect(ins.pcrOi.meaning).toMatch(/better when pcrOi was higher/);
    expect(ins.minutesFromOpen.status).not.toBe('LEARNED');
  });

  it('orients option-chain readings to the trade side', () => {
    const chain = { pcrOi: 1.3, oiChangeTilt: 0.2, maxPainDistPct: 0.5, callWallDistPct: 0.8, putWallDistPct: -0.6, atmIv: 0.13, ivSkew: 0.02 };
    const long = entryFeatures({ side: 1, minutesFromOpen: 45, gapPct: 0.004, isExpiry: false, chain });
    const short = entryFeatures({ side: -1, minutesFromOpen: 45, gapPct: 0.004, isExpiry: true, chain });
    expect(long.pcrWithTrade).toBeCloseTo(0.3, 9);
    expect(short.pcrWithTrade).toBeCloseTo(-0.3, 9);
    expect(long.roomToWallPct).toBe(0.8); // distance to the call wall above
    expect(short.roomToWallPct).toBe(0.6); // distance to the put wall below
    expect(long.gapWithTradePct).toBeCloseTo(0.4, 9);
    expect(short.isExpiry).toBe(1);
  });
});

describe('NIFTY lab live runner', () => {
  const IST = 5.5 * 3_600_000;
  const M15 = 15 * 60_000;
  // 45 quiet sessions, then a session that breaks above its first 15m candle at bar 2 and later hits its target
  const build = (lastSessionBars: number) => {
    const bars: any[] = [];
    let p = 24000;
    for (let d = 0; d < 46; d++) {
      const open = Date.UTC(2026, 0, 1) + d * 86_400_000 + (9 * 60 + 15) * 60_000 - IST;
      const nBars = d === 45 ? lastSessionBars : 25;
      for (let k = 0; k < nBars; k++) {
        const up = d === 45 ? (k === 0 ? 0 : k === 1 ? 2 : 30) : k % 2 ? 6 : -6;
        const o = p, c = p + up;
        bars.push({ t: open + k * M15, o, h: Math.max(o, c) + 3, l: Math.min(o, c) - 3, c, v: 0 });
        p = c;
      }
    }
    return bars;
  };
  const genome = { trigger: 'ORB', dirFilter: 'NONE', dayFilter: 'ALL', lastEntryMin: 14 * 60, exit: 'R2', stop: 'PTS40' };

  it('opens a watch trade at the real ITM option price on a fresh signal, then closes it with the real exit price', async () => {
    const created: any[] = [], updates: any[] = [];
    let stored: any = null;
    const prisma: any = {
      intradayTrade: {
        findUnique: jest.fn(async () => stored),
        create: jest.fn(async ({ data }) => { stored = { ...data, id: 't1', status: 'OPEN' }; created.push(data); return stored; }),
        update: jest.fn(async (u) => { updates.push(u); stored = { ...stored, ...u.data }; return stored; }),
        findMany: jest.fn(async () => []),
      },
      intradayStrategy: { update: jest.fn(async () => ({})) },
      marketObservation: { findFirst: jest.fn(async () => ({ metrics: { pcrOi: 1.2, atmIv: 0.12 } })) },
    };
    const quotes = [180, 236];
    const paper: any = { getValidatedOptionPrice: jest.fn(async () => ({ price: quotes.shift(), timestamp: new Date() })) };
    const svc = new NiftyLabService(prisma, {} as any, paper);
    const st = { id: 'S1', name: 'ORB', genomeJson: genome };

    // 1) the breakout bar (bar 2) has just closed -> open
    let bars = build(3);
    let s = prepareSeries(bars, M15);
    let ses = s.sessions[s.sessions.length - 1];
    const signalClose = bars[bars.length - 1].t + M15;
    await (svc as any).runStrategy(st, s, ses, ses.date, signalClose + 30_000);
    expect(created).toHaveLength(1);
    expect(created[0].optionContract).toMatch(/^NIFTY \d+ CE$/);
    expect(Number(created[0].optionContract.split(' ')[1])).toBeLessThan(created[0].indexEntry); // in the money
    expect(created[0].optionEntry).toBe(180);
    expect(created[0].featuresJson.pcrOi).toBe(1.2);

    // 2) later bars reach the 2R target (80 pts) -> close with the real option exit
    bars = build(8);
    s = prepareSeries(bars, M15);
    ses = s.sessions[s.sessions.length - 1];
    const sim = require('@quant/strategy-lab').simulateIntraday(genome, s, ses.date, `${ses.date}~`)[0];
    expect(sim.exitReason).toBe('TARGET');
    await (svc as any).runStrategy(st, s, ses, ses.date, sim.exitTime + 30_000);
    const close = updates.find((u) => u.data.status === 'CLOSED');
    expect(close.data.exitReason).toBe('TARGET');
    expect(close.data.optionExit).toBe(236);
    expect(close.data.optionPoints).toBe(56);
    expect(close.data.indexPoints).toBeCloseTo(80, 6);
  });

  it('does not record a stale signal (no real entry price available for it)', async () => {
    const prisma: any = { intradayTrade: { findUnique: jest.fn(async () => null), create: jest.fn() }, marketObservation: { findFirst: jest.fn() } };
    const svc = new NiftyLabService(prisma, {} as any, { getValidatedOptionPrice: jest.fn() } as any);
    const bars = build(6);
    const s = prepareSeries(bars, M15);
    const ses = s.sessions[s.sessions.length - 1];
    await (svc as any).runStrategy({ id: 'S1', name: 'ORB', genomeJson: genome }, s, ses, ses.date, bars[bars.length - 1].t + M15);
    expect(prisma.intradayTrade.create).not.toHaveBeenCalled();
  });
});
