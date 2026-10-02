import { fixIntradayGenome, fixLabGenome, judgeFix, repeatedMistakes, reviewTrade, TradeReview } from '../mistakes';

const base = { side: 1 as const, entry: 100, stop: 95, target: 110, context: {} };

describe('learning from mistakes', () => {
  it('labels a stop-out followed by a run to the target as STOPPED_BY_NOISE', () => {
    const r = reviewTrade({ ...base, exit: 95, exitReason: 'STOP', during: [{ h: 101, l: 95 }], after: [{ h: 104, l: 94 }, { h: 111, l: 103 }] });
    expect(r.outcome).toBe('LOSS');
    expect(r.resultR).toBe(-1);
    expect(r.mistakes).toContain('STOPPED_BY_NOISE');
    expect(r.mistakes).not.toContain('WRONG_DIRECTION');
  });

  it('labels a trade that was +1R and closed red as GAVE_BACK_PROFIT', () => {
    const r = reviewTrade({ ...base, exit: 97, exitReason: 'EOD', during: [{ h: 106, l: 99 }, { h: 104, l: 96 }], after: [] });
    expect(r.maxFavourableR).toBeCloseTo(1.2, 9);
    expect(r.mistakes).toEqual(['GAVE_BACK_PROFIT']);
  });

  it('labels a trade that never worked and kept falling as WRONG_DIRECTION, plus context mistakes', () => {
    const r = reviewTrade({
      ...base, exit: 95, exitReason: 'STOP', during: [{ h: 101, l: 95 }], after: [{ h: 96, l: 88 }],
      context: { bigTrend: -1, isExpiry: true, emaDistanceAtr: 3 },
    });
    expect(r.mistakes).toEqual(expect.arrayContaining(['WRONG_DIRECTION', 'AGAINST_BIG_TREND', 'EXPIRY_DAY', 'CHASED_ENTRY']));
  });

  it('a winner has no mistakes', () => {
    expect(reviewTrade({ ...base, exit: 110, exitReason: 'TARGET', during: [{ h: 110, l: 99 }], after: [] }).mistakes).toEqual([]);
  });

  it('only a REPEATED mistake (>= 3 times and >= 40% of losses) becomes a lesson', () => {
    const loss = (m: any[]): TradeReview => ({ outcome: 'LOSS', resultR: -1, maxFavourableR: 0, mistakes: m });
    const win: TradeReview = { outcome: 'WIN', resultR: 2, maxFavourableR: 2, mistakes: [] };
    const reviews = [loss(['STOPPED_BY_NOISE']), loss(['STOPPED_BY_NOISE', 'EXPIRY_DAY']), loss(['STOPPED_BY_NOISE']), loss(['EXPIRY_DAY']), loss([]), win, win];
    const rep = repeatedMistakes(reviews);
    expect(rep.map((x) => x.mistake)).toEqual(['STOPPED_BY_NOISE']); // EXPIRY_DAY only twice
    expect(rep[0].share).toBeCloseTo(3 / 5, 9);
  });

  it('proposes rule changes that address the mistake', () => {
    const lab: any = { trigger: 'BREAKOUT_20', sides: 'LONG', filters: ['RECENT_DISPLACEMENT'], stop: { type: 'ATR', atrMult: 2 }, rewardRisk: 3, maxBarsInTrade: 32, entryMode: 'MARKET', exit: 'FIXED' };
    expect(fixLabGenome(lab, 'STOPPED_BY_NOISE')!.genome.stop.atrMult).toBe(3);
    expect(fixLabGenome(lab, 'GAVE_BACK_PROFIT')!.genome.rewardRisk).toBe(2);
    expect(fixLabGenome(lab, 'AGAINST_BIG_TREND')!.genome.filters).toEqual(['HTF_TREND', 'RECENT_DISPLACEMENT']);
    const nifty: any = { trigger: 'EMA_X', dirFilter: 'NONE', dayFilter: 'ALL', lastEntryMin: 840, exit: 'EOD', stop: 'PTS40' };
    expect(fixIntradayGenome(nifty, 'STOPPED_BY_NOISE')!.genome.stop).toBe('PTS60');
    expect(fixIntradayGenome(nifty, 'EXPIRY_DAY')!.genome.dayFilter).toBe('NO_EXPIRY');
    expect(fixIntradayGenome(nifty, 'WRONG_DIRECTION')!.genome.dirFilter).toBe('DAILY_TREND');
    expect(fixIntradayGenome({ ...nifty, dayFilter: 'NO_EXPIRY' }, 'EXPIRY_DAY')).toBeNull();
  });

  it('adopts a fix only when history confirms it (overall and recently, without cutting total profit)', () => {
    const parent = Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? 2 : -0.8));
    const better = Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? 2.2 : -0.7));
    const worse = Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? 1.8 : -0.8));
    expect(judgeFix(parent, better).adopt).toBe(true);
    const no = judgeFix(parent, worse);
    expect(no.adopt).toBe(false);
    expect(no.reason).toMatch(/bad luck/);
    // trades far less: higher average but much lower total -> rejected
    const fewer = judgeFix(parent, better.slice(0, 30)); // 30 trades: better average (0.27 vs 0.15R) but total 8R vs 15R
    expect(fewer.adopt).toBe(false);
    expect(fewer.reason).toMatch(/cuts total profit/);
  });
});
