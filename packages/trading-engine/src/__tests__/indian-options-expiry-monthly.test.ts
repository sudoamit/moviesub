import { IndianOptionsExpiryEngine } from '../indian-options-expiry';

describe('IndianOptionsExpiryEngine - NSE expiry rules', () => {
  const base = new Date('2026-10-01T05:00:00Z');

  it('BANKNIFTY is monthly only, last Tuesday of the month (no weekly Wednesday series)', () => {
    const exp = IndianOptionsExpiryEngine.getUpcomingExpiries('BANKNIFTY', base);
    expect(exp.map((e) => e.dateString)).toEqual(['27-Oct-2026', '24-Nov-2026', '29-Dec-2026']);
    expect(exp.every((e) => e.isMonthly && e.dayOfWeek === 'Tue')).toBe(true);
  });

  it('NIFTY keeps weekly Tuesday expiries', () => {
    const exp = IndianOptionsExpiryEngine.getUpcomingExpiries('NIFTY', base);
    expect(exp[0].dateString).toBe('06-Oct-2026');
    expect(exp[1].dateString).toBe('13-Oct-2026');
  });
});
