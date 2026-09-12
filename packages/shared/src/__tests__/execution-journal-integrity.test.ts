import {
  CurrencyCode,
  ExecutionAggregator,
  formatCurrencyAmount,
  formatPnlWithCurrency,
  formatPriceWithCurrency,
  IFillRecord,
} from '../index';

describe('ExecutionAggregator & CurrencyFormatter Integrity', () => {
  describe('CurrencyFormatter', () => {
    it('formats INR correctly with ₹ prefix and comma grouping', () => {
      expect(formatCurrencyAmount(46000, 'INR')).toBe('₹46,000.00');
      expect(formatCurrencyAmount(-1250.5, 'INR')).toBe('-₹1,250.50');
      expect(formatPnlWithCurrency(46000, 'INR')).toBe('+₹46,000.00');
      expect(formatPnlWithCurrency(-500, 'INR')).toBe('-₹500.00');
    });

    it('formats USD correctly with $ prefix and 2 decimals', () => {
      expect(formatCurrencyAmount(500, 'USD')).toBe('$500.00');
      expect(formatPriceWithCurrency(2650.75, 'USD')).toBe('$2,650.75');
      expect(formatPnlWithCurrency(120.4, 'USD')).toBe('+$120.40');
    });

    it('formats USDT correctly with USDT suffix and NEVER $ prefix', () => {
      expect(formatCurrencyAmount(500, 'USDT')).toBe('500.00 USDT');
      expect(formatPriceWithCurrency(95000, 'USDT')).toBe('95,000.00 USDT');
      expect(formatPnlWithCurrency(500, 'USDT')).toBe('+500.00 USDT');
      expect(formatPnlWithCurrency(-250.5, 'USDT')).toBe('-250.50 USDT');
      expect(formatCurrencyAmount(500, 'USDT')).not.toContain('$');
    });
  });

  describe('ExecutionAggregator', () => {
    it('TEST 1 — Single fill: entry price = fill price, entry time = fill timestamp', () => {
      const fills: IFillRecord[] = [
        {
          fillId: 'fill-1',
          executionRole: 'ENTRY',
          fillPrice: 24500,
          fillQuantity: 65,
          fillTimestamp: '2026-09-12T10:03:17.000Z',
          fee: 20,
        },
      ];

      const res = ExecutionAggregator.aggregateLeg(fills, 'ENTRY');
      expect(res.weightedPrice).toBe(24500);
      expect(res.totalQuantity).toBe(65);
      expect(res.earliestFillTimestamp).toBe(Date.parse('2026-09-12T10:03:17.000Z'));
      expect(res.earliestFillTimeUtc).toBe('2026-09-12T10:03:17.000Z');
      expect(res.totalFees).toBe(20);
    });

    it('TEST 2 — Partial entry fills: correct weighted average price and earliest fill timestamp', () => {
      const entryFills: IFillRecord[] = [
        {
          fillId: 'fill-e1',
          executionRole: 'ENTRY',
          fillPrice: 100,
          fillQuantity: 1,
          fillTimestamp: '2026-09-12T10:03:17.000Z',
        },
        {
          fillId: 'fill-e2',
          executionRole: 'ENTRY',
          fillPrice: 101,
          fillQuantity: 2,
          fillTimestamp: '2026-09-12T10:03:25.000Z',
        },
        {
          fillId: 'fill-e3',
          executionRole: 'ENTRY',
          fillPrice: 103,
          fillQuantity: 1,
          fillTimestamp: '2026-09-12T10:03:40.000Z',
        },
      ];

      // Total quantity: 4
      // Weighted Price: (100*1 + 101*2 + 103*1) / 4 = 405 / 4 = 101.25
      const res = ExecutionAggregator.aggregateLeg(entryFills, 'ENTRY');
      expect(res.totalQuantity).toBe(4);
      expect(res.weightedPrice).toBe(101.25);
      expect(res.earliestFillTimeUtc).toBe('2026-09-12T10:03:17.000Z');
      expect(res.latestFillTimeUtc).toBe('2026-09-12T10:03:40.000Z');
    });

    it('TEST 3 — Partial exit fills: correct weighted average exit price and latest exit timestamp', () => {
      const exitFills: IFillRecord[] = [
        {
          fillId: 'fill-x1',
          executionRole: 'EXIT',
          fillPrice: 105,
          fillQuantity: 1,
          fillTimestamp: '2026-09-12T11:15:00.000Z',
        },
        {
          fillId: 'fill-x2',
          executionRole: 'EXIT',
          fillPrice: 107,
          fillQuantity: 3,
          fillTimestamp: '2026-09-12T11:18:30.000Z',
        },
      ];

      // Total quantity: 4
      // Weighted Price: (105*1 + 107*3) / 4 = 426 / 4 = 106.50
      const res = ExecutionAggregator.aggregateLeg(exitFills, 'EXIT');
      expect(res.totalQuantity).toBe(4);
      expect(res.weightedPrice).toBe(106.5);
      expect(res.earliestFillTimeUtc).toBe('2026-09-12T11:15:00.000Z');
      expect(res.latestFillTimeUtc).toBe('2026-09-12T11:18:30.000Z');
    });

    it('TEST 8 — Duration: exact exitTime - entryTime in UTC milliseconds', () => {
      const entryFills: IFillRecord[] = [
        {
          fillId: 'fill-e1',
          executionRole: 'ENTRY',
          fillPrice: 90000,
          fillQuantity: 0.1,
          fillTimestamp: '2026-09-12T10:00:00.000Z',
        },
      ];
      const exitFills: IFillRecord[] = [
        {
          fillId: 'fill-x1',
          executionRole: 'EXIT',
          fillPrice: 92000,
          fillQuantity: 0.1,
          fillTimestamp: '2026-09-12T10:45:30.000Z',
        },
      ];

      const trade = ExecutionAggregator.aggregateTradeLifecycle(entryFills, exitFills);
      expect(trade.durationMs).toBe(45 * 60 * 1000 + 30 * 1000); // 2730000 ms
      expect(trade.durationMinutes).toBe(45.5);
      expect(trade.isFullyClosed).toBe(true);
    });

    it('TEST 14 — Duplicate fill ID is rejected', () => {
      const duplicateFills: IFillRecord[] = [
        {
          fillId: 'fill-dup',
          executionRole: 'ENTRY',
          fillPrice: 100,
          fillQuantity: 1,
          fillTimestamp: '2026-09-12T10:00:00.000Z',
        },
        {
          fillId: 'fill-dup',
          executionRole: 'ENTRY',
          fillPrice: 100,
          fillQuantity: 1,
          fillTimestamp: '2026-09-12T10:00:05.000Z',
        },
      ];

      expect(() => ExecutionAggregator.aggregateLeg(duplicateFills, 'ENTRY')).toThrow(
        /Duplicate fill detected/,
      );
    });

    it('Fails closed on role mismatch', () => {
      const wrongRole: IFillRecord[] = [
        {
          fillId: 'fill-wrong',
          executionRole: 'EXIT',
          fillPrice: 100,
          fillQuantity: 1,
          fillTimestamp: '2026-09-12T10:00:00.000Z',
        },
      ];

      expect(() => ExecutionAggregator.aggregateLeg(wrongRole, 'ENTRY')).toThrow(
        /Role mismatch/,
      );
    });
  });
});
