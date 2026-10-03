import { bootstrapMeanCI, longestLosingStreak, maxDrawdown, summarizePerformance } from '../stats';

describe('performance statistics', () => {
  it('computes mean, median, sd, standard error, totals, drawdown, profit factor, win rate and losing streak', () => {
    const r = [2, -1, -1, -1, 3, -1, 0.5];
    const s = summarizePerformance(r);
    expect(s.trades).toBe(7);
    expect(s.meanR).toBeCloseTo(1.5 / 7, 12);
    expect(s.medianR).toBe(-1);
    const sd = Math.sqrt(r.reduce((a, x) => a + (x - 1.5 / 7) ** 2, 0) / 6);
    expect(s.sdR).toBeCloseTo(sd, 12);
    expect(s.seR).toBeCloseTo(sd / Math.sqrt(7), 12);
    expect(s.totalR).toBeCloseTo(1.5, 12);
    expect(s.maxDrawdownR).toBe(3); // +2 then three -1
    expect(s.profitFactor).toBeCloseTo(5.5 / 4, 12);
    expect(s.winRate).toBeCloseTo(3 / 7, 12);
    expect(s.longestLosingStreak).toBe(3);
    expect(s.ciLowR).toBeLessThan(s.meanR);
    expect(s.ciHighR).toBeGreaterThan(s.meanR);
  });

  it('the bootstrap interval is deterministic and narrows with more data', () => {
    const r = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? 2 : -0.6));
    expect(bootstrapMeanCI(r)).toEqual(bootstrapMeanCI(r));
    const many: number[] = Array.from({ length: 10 }, () => r).flat();
    const [lo1, hi1] = bootstrapMeanCI(r), [lo2, hi2] = bootstrapMeanCI(many);
    expect(hi2 - lo2).toBeLessThan((hi1 - lo1) * 0.5);
  });

  it('a small positive sample does not have a positive lower bound (not "proven")', () => {
    const s = summarizePerformance([2, -1, -1, 2.5, -1, -1, 3, -1]);
    expect(s.meanR).toBeGreaterThan(0);
    expect(s.ciLowR).toBeLessThan(0);
  });

  it('handles edge cases', () => {
    expect(summarizePerformance([]).trades).toBe(0);
    expect(summarizePerformance([1, 2]).profitFactor).toBe(Infinity);
    expect(maxDrawdown([1, 1, 1])).toBe(0);
    expect(longestLosingStreak([-1, -1, 1, -1, -1, -1])).toBe(3);
  });
});
