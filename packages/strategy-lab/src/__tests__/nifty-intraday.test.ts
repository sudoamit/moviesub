import { isNiftyExpiryDay, prepareSeries, simulateIntraday, INSTRUMENT_MODELS, IntradayGenome } from '../nifty-intraday';

const IST = 5.5 * 3_600_000;
const H1 = 3_600_000;
// 40 sessions of 7 hourly bars (09:15..15:15 IST); day 39 breaks out above its first hour and trends up
function sessions(n: number) {
  const bars: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> = [];
  let p = 22000;
  for (let d = 0; d < n; d++) {
    const day0 = Date.UTC(2025, 0, 1) + d * 86_400_000 + 9 * 3_600_000 + 15 * 60_000 - IST;
    for (let k = 0; k < 7; k++) {
      const up = d === n - 1 ? (k === 0 ? 0 : 40) : (k % 2 ? 8 : -8);
      const o = p, c = p + up;
      bars.push({ t: day0 + k * H1, o, h: Math.max(o, c) + 5, l: Math.min(o, c) - 5, c, v: 0 });
      p = c;
    }
  }
  return bars;
}

describe('NIFTY intraday study engine', () => {
  it('knows the weekly expiry day (Thursday until Aug 2025, Tuesday after)', () => {
    expect(isNiftyExpiryDay('2025-08-28')).toBe(true); // Thursday
    expect(isNiftyExpiryDay('2025-09-02')).toBe(true); // Tuesday
    expect(isNiftyExpiryDay('2025-09-04')).toBe(false);
  });

  it('opening-range breakout enters at the breakout close and exits by 15:15 with modelled option P&L', () => {
    const s = prepareSeries(sessions(40), H1);
    const g: IntradayGenome = { trigger: 'ORB', dirFilter: 'NONE', dayFilter: 'ALL', lastEntryMin: 14 * 60, exit: 'EOD', stop: 'ATR2' };
    const tr = simulateIntraday(g, s, s.sessions[s.sessions.length - 1].date);
    expect(tr).toHaveLength(1);
    const t = tr[0];
    expect(t.side).toBe(1);
    expect(t.indexPoints).toBeGreaterThan(0);
    const m = INSTRUMENT_MODELS.ITM_OPTION;
    expect(t.pnl.ITM_OPTION).toBeCloseTo(m.delta * t.indexPoints - m.thetaPerHour * t.hours - m.cost, 9);
    expect(t.pnl.FUTURES).toBeCloseTo(t.indexPoints - INSTRUMENT_MODELS.FUTURES.cost, 9);
  });

  it('takes at most one trade per session and never enters after the cut-off', () => {
    const s = prepareSeries(sessions(40), H1);
    const g: IntradayGenome = { trigger: 'ORB', dirFilter: 'NONE', dayFilter: 'ALL', lastEntryMin: 10 * 60, exit: 'EOD', stop: 'ATR2' };
    // first bar closes at 10:15 > 10:00 cut-off: no entries at all
    expect(simulateIntraday(g, s)).toHaveLength(0);
  });
});
