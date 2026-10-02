import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const IST = 5.5 * 3_600_000;
const M15 = 900_000;

describe('MistakeLearningService (NIFTY watch trades)', () => {
  let dir: string;
  let MistakeLearningService: any;
  let lib: any;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-'));
    process.env.LAB_DATA_DIR = dir;
    // 60 sessions of 25 x 15m bars (09:15..15:15 IST): small up-down noise with a mild up drift
    let seed = 5;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
    const bars: any[] = [];
    let p = 24000;
    for (let d = 0; d < 60; d++) {
      const open = Date.UTC(2026, 0, 5) + d * 86_400_000 + (9 * 60 + 15) * 60_000 - IST;
      for (let k = 0; k < 25; k++) {
        const o = p, c = p + rnd() * 60 + 2;
        bars.push({ t: open + k * M15, o, h: Math.max(o, c) + Math.abs(rnd()) * 20, l: Math.min(o, c) - Math.abs(rnd()) * 20, c, v: 0 });
        p = c;
      }
    }
    // Last session: a long entry at bar 4 is stopped 40 points lower at bar 6, then the market rallies to the target
    const last = bars.slice(-25);
    const base = last[4].c;
    last.forEach((b: any, k: number) => {
      const lvl = k <= 4 ? base - 4 + k : k === 5 ? base - 20 : k === 6 ? base - 45 : base - 45 + (k - 6) * 25;
      b.o = lvl; b.c = lvl + 1; b.h = lvl + 6; b.l = lvl - 6;
    });
    last[4].c = base;
    fs.writeFileSync(path.join(dir, 'NIFTY_15m.json'), JSON.stringify(bars));
    MistakeLearningService = require('../mistake-learning.service').MistakeLearningService;
    lib = { bars, last, base };
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.LAB_DATA_DIR;
  });

  it('reviews a stopped-out trade after the session and labels it STOPPED_BY_NOISE', async () => {
    const { last, base } = lib;
    const date = new Date(last[0].t + IST).toISOString().slice(0, 10);
    const saved: any[] = [];
    const prisma: any = {
      tradeReview: { findMany: jest.fn(async () => []), create: jest.fn(async ({ data }) => saved.push(data)) },
      intradayTrade: {
        findMany: jest.fn(async () => [{
          id: 'T1', strategyId: 'S1', date, side: 1, status: 'CLOSED',
          signalTime: new Date(last[4].t + M15), indexEntry: base, indexStop: base - 40, indexTarget: base + 80,
          exitTime: new Date(last[6].t + M15), indexExit: base - 40, exitReason: 'STOP', strategy: {},
        }]),
      },
    };
    const candles: any = { getCandles: jest.fn(async () => { throw new Error('offline'); }) };
    const svc = new MistakeLearningService(prisma, candles);
    expect(await svc.reviewNiftyTrades()).toEqual(['S1']);
    expect(saved).toHaveLength(1);
    expect(saved[0].outcome).toBe('LOSS');
    expect(saved[0].resultR).toBeCloseTo(-1, 6);
    expect(saved[0].mistakes).toContain('STOPPED_BY_NOISE');
  });

  it('turns a repeated mistake into a lesson, tests the fix on history and only launches a variant if it is confirmed', async () => {
    const lessons: any[] = [], created: any[] = [];
    const loss = (m: string[]) => ({ outcome: 'LOSS', resultR: -1, maxFavourableR: 0.2, mistakes: m });
    const prisma: any = {
      tradeReview: { findMany: jest.fn(async () => [loss(['STOPPED_BY_NOISE']), loss(['STOPPED_BY_NOISE']), loss(['STOPPED_BY_NOISE']), loss([])]) },
      tradeLesson: { findUnique: jest.fn(async () => null), create: jest.fn(async ({ data }) => lessons.push(data)) },
      intradayStrategy: {
        findUnique: jest.fn(async ({ where }) => (where.id === 'S1'
          ? { id: 'S1', name: 'EMA cross', genomeJson: { trigger: 'EMA_X', dirFilter: 'NONE', dayFilter: 'ALL', lastEntryMin: 840, exit: 'EOD', stop: 'PTS40' } }
          : null)),
        create: jest.fn(async ({ data }) => created.push(data)),
      },
    };
    const svc = new MistakeLearningService(prisma, {} as any);
    expect(await svc.learn('NIFTY', 'S1')).toBe(1);
    const l = lessons[0];
    expect(l.mistake).toBe('STOPPED_BY_NOISE');
    expect(l.evidenceJson).toEqual({ count: 3, losses: 4, share: 0.75 });
    expect(l.fixDescription).toBe('wider stop: PTS40 -> PTS60');
    expect(['ADOPTED', 'REJECTED_BY_HISTORY']).toContain(l.status);
    expect(l.testJson.parent.trades).toBeGreaterThan(0);
    // a variant exists exactly when history confirmed the fix
    expect(created.length).toBe(l.status === 'ADOPTED' ? 1 : 0);
    if (created.length) expect(created[0].genomeJson.stop).toBe('PTS60');
  });

  it('does not draw a lesson from a mistake seen only once or twice', async () => {
    const prisma: any = {
      tradeReview: { findMany: jest.fn(async () => [{ outcome: 'LOSS', resultR: -1, maxFavourableR: 0, mistakes: ['EXPIRY_DAY'] }, { outcome: 'LOSS', resultR: -1, maxFavourableR: 0, mistakes: ['EXPIRY_DAY'] }]) },
      tradeLesson: { findUnique: jest.fn(), create: jest.fn() },
    };
    const svc = new MistakeLearningService(prisma, {} as any);
    expect(await svc.learn('NIFTY', 'S1')).toBe(0);
    expect(prisma.tradeLesson.create).not.toHaveBeenCalled();
  });
});
