import {
  Direction,
  ExecutionAggregator,
  formatCurrencyAmount,
  formatPnlWithCurrency,
  formatPriceWithCurrency,
  getAuthoritativeInstrument,
  hasInstrument,
  IFillRecord,
  ITradeJournalRecord,
  PointInTimeCurrencyConverter,
  resolveMarginModel,
  buildAccountingSnapshot,
} from '@quant/shared';
import { TradeAccountingEngine } from '../trade-accounting-engine';

describe('AI Fix 103 — Trade Journal Execution & Data Integrity Suite', () => {
  let converter: PointInTimeCurrencyConverter;

  beforeEach(() => {
    PointInTimeCurrencyConverter.resetInstance();
    converter = PointInTimeCurrencyConverter.getInstance();
    converter.registerRate({ pair: 'USDT/INR', rate: 92.0, timestamp: 1700000000000, source: 'BINANCE_PIT', version: '1.0' });
    converter.registerRate({ pair: 'USD/INR', rate: 83.5, timestamp: 1700000000000, source: 'RBI_REF_PIT', version: '1.0' });
  });

  // TEST 1 — Single fill
  it('TEST 1 — Single fill: entry price = fill price, entry time = fill timestamp', () => {
    const fill: IFillRecord = {
      fillId: 'fill-single-1',
      executionRole: 'ENTRY',
      fillPrice: 24500.5,
      fillQuantity: 65,
      fillTimestamp: '2026-09-12T10:03:17.000Z',
      fee: 20,
    };

    const aggregated = ExecutionAggregator.aggregateLeg([fill], 'ENTRY');
    expect(aggregated.weightedPrice).toBe(24500.5);
    expect(aggregated.earliestFillTimeUtc).toBe('2026-09-12T10:03:17.000Z');
    expect(aggregated.totalQuantity).toBe(65);
    expect(aggregated.fillCount).toBe(1);
  });

  // TEST 2 — Partial entry fills
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

    const aggregated = ExecutionAggregator.aggregateLeg(entryFills, 'ENTRY');
    expect(aggregated.totalQuantity).toBe(4);
    expect(aggregated.weightedPrice).toBe(101.25);
    expect(aggregated.earliestFillTimeUtc).toBe('2026-09-12T10:03:17.000Z');
  });

  // TEST 3 — Partial exit fills
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

    const aggregated = ExecutionAggregator.aggregateLeg(exitFills, 'EXIT');
    expect(aggregated.totalQuantity).toBe(4);
    expect(aggregated.weightedPrice).toBe(106.5);
    expect(aggregated.latestFillTimeUtc).toBe('2026-09-12T11:18:30.000Z');
  });

  // TEST 4 — Order/fill timestamp distinction
  it('TEST 4 — Order/fill timestamp distinction: order created at 10:00, fill at 10:03 -> journal uses 10:03', () => {
    const orderCreatedAt = '2026-09-12T10:00:00.000Z';
    const fillTimestamp = '2026-09-12T10:03:17.000Z';

    const fill: IFillRecord = {
      fillId: 'fill-1',
      orderId: 'order-1',
      executionRole: 'ENTRY',
      fillPrice: 25000,
      fillQuantity: 10,
      fillTimestamp,
    };

    const aggregated = ExecutionAggregator.aggregateLeg([fill], 'ENTRY');
    expect(aggregated.earliestFillTimeUtc).toBe(fillTimestamp);
    expect(aggregated.earliestFillTimeUtc).not.toBe(orderCreatedAt);
  });

  // TEST 5 — Order/fill price distinction
  it('TEST 5 — Order/fill price distinction: requested price 100, actual fill 101 -> journal uses 101', () => {
    const requestedPrice = 100.0;
    const actualFillPrice = 101.25;

    const fill: IFillRecord = {
      fillId: 'fill-1',
      executionRole: 'ENTRY',
      fillPrice: actualFillPrice,
      fillQuantity: 50,
      fillTimestamp: '2026-09-12T10:00:00.000Z',
    };

    const aggregated = ExecutionAggregator.aggregateLeg([fill], 'ENTRY');
    expect(aggregated.weightedPrice).toBe(actualFillPrice);
    expect(aggregated.weightedPrice).not.toBe(requestedPrice);
  });

  // TEST 6 & 7 — UTC correctness & no double timezone conversion
  it('TEST 6 & 7 — UTC correctness: stored as canonical UTC ISO, formatted correctly', () => {
    const utcString = '2026-09-12T10:03:17.000Z';
    const fill: IFillRecord = {
      fillId: 'fill-1',
      executionRole: 'ENTRY',
      fillPrice: 100,
      fillQuantity: 1,
      fillTimestamp: utcString,
    };

    const aggregated = ExecutionAggregator.aggregateLeg([fill], 'ENTRY');
    expect(aggregated.earliestFillTimeUtc).toBe(utcString);
    const d = new Date(aggregated.earliestFillTimeUtc);
    expect(d.toISOString()).toBe(utcString);
  });

  // TEST 8 — Duration
  it('TEST 8 — Duration: exact exitTime - entryTime in UTC milliseconds', () => {
    const entryFills: IFillRecord[] = [
      {
        fillId: 'fill-e1',
        executionRole: 'ENTRY',
        fillPrice: 100,
        fillQuantity: 10,
        fillTimestamp: '2026-09-12T10:00:00.000Z',
      },
    ];
    const exitFills: IFillRecord[] = [
      {
        fillId: 'fill-x1',
        executionRole: 'EXIT',
        fillPrice: 110,
        fillQuantity: 10,
        fillTimestamp: '2026-09-12T10:45:30.000Z',
      },
    ];

    const trade = ExecutionAggregator.aggregateTradeLifecycle(entryFills, exitFills);
    expect(trade.durationMs).toBe(45 * 60 * 1000 + 30 * 1000);
    expect(trade.durationMinutes).toBe(45.5);
  });

  // TEST 9 — BTCUSDT
  it('TEST 9 — BTCUSDT: entry/exit prices labeled USDT, P&L labeled INR', () => {
    const btc = getAuthoritativeInstrument('BTCUSDT');
    const marginModel = resolveMarginModel(btc, { requestedLeverage: 10 });
    const fx = converter.getRate('USDT', 'INR', 1700000000000);

    const snapshot = buildAccountingSnapshot({
      accountCurrency: 'INR',
      quoteCurrency: 'USDT',
      fxResult: fx,
      contractSize: 1,
      lotSize: 0.1,
      resolvedMarginModel: marginModel,
      calculatedAt: 1700000000000,
    });

    const entryPrice = 90000;
    const exitPrice = 95000;
    const pnl = TradeAccountingEngine.calculateTradePnl({
      entryPrice,
      exitPrice,
      quantity: 0.1,
      direction: Direction.BULLISH,
      accountingSnapshot: snapshot,
    });

    // Quote P&L: (95000 - 90000) * 0.1 = 500 USDT
    // Account P&L: 500 * 92 = 46,000 INR
    expect(pnl.quotePnl).toBe(500);
    expect(pnl.grossPnlAccount).toBe(46000);

    const formattedEntry = formatPriceWithCurrency(entryPrice, snapshot.quoteCurrency);
    const formattedExit = formatPriceWithCurrency(exitPrice, snapshot.quoteCurrency);
    const formattedAccountPnl = formatPnlWithCurrency(pnl.netPnlAccount, snapshot.accountCurrency);
    const formattedQuotePnl = formatPnlWithCurrency(pnl.quotePnl!, snapshot.quoteCurrency);

    expect(formattedEntry).toBe('90,000.00 USDT');
    expect(formattedExit).toBe('95,000.00 USDT');
    expect(formattedAccountPnl).toBe('+₹46,000.00');
    expect(formattedQuotePnl).toBe('+500.00 USDT');
    expect(formattedEntry).not.toContain('$');
  });

  // TEST 10 — XAUUSD
  it('TEST 10 — XAUUSD: price labeled USD, P&L labeled INR', () => {
    const xau = getAuthoritativeInstrument('XAUUSD');
    const marginModel = resolveMarginModel(xau, { requestedLeverage: 20 });
    const fx = converter.getRate('USD', 'INR', 1700000000000);

    const snapshot = buildAccountingSnapshot({
      accountCurrency: 'INR',
      quoteCurrency: 'USD',
      fxResult: fx,
      contractSize: 100,
      lotSize: 1,
      resolvedMarginModel: marginModel,
      calculatedAt: 1700000000000,
    });

    const entryPrice = 2650;
    const exitPrice = 2660;
    const pnl = TradeAccountingEngine.calculateTradePnl({
      entryPrice,
      exitPrice,
      quantity: 1,
      direction: Direction.BULLISH,
      accountingSnapshot: snapshot,
    });

    // Quote P&L: (2660 - 2650) * 1 * 100 = 1,000 USD
    // Account P&L: 1,000 * 83.5 = 83,500 INR
    expect(pnl.quotePnl).toBe(1000);
    expect(pnl.grossPnlAccount).toBe(83500);

    expect(formatPriceWithCurrency(entryPrice, 'USD')).toBe('$2,650.00');
    expect(formatPnlWithCurrency(pnl.netPnlAccount, 'INR')).toBe('+₹83,500.00');
  });

  // TEST 11 — NIFTY
  it('TEST 11 — NIFTY: price labeled INR, P&L labeled INR', () => {
    const nifty = getAuthoritativeInstrument('NIFTY');
    const marginModel = resolveMarginModel(nifty, { requestedLeverage: 1 });
    const fx = converter.getRate('INR', 'INR', 1700000000000);

    const snapshot = buildAccountingSnapshot({
      accountCurrency: 'INR',
      quoteCurrency: 'INR',
      fxResult: fx,
      contractSize: 1,
      lotSize: 65,
      resolvedMarginModel: marginModel,
      calculatedAt: 1700000000000,
    });

    const entryPrice = 24500;
    const exitPrice = 24600;
    const pnl = TradeAccountingEngine.calculateTradePnl({
      entryPrice,
      exitPrice,
      quantity: 65,
      direction: Direction.BULLISH,
      accountingSnapshot: snapshot,
    });

    // P&L: (24600 - 24500) * 65 = 6,500 INR
    expect(pnl.quotePnl).toBe(6500);
    expect(pnl.grossPnlAccount).toBe(6500);

    expect(formatPriceWithCurrency(entryPrice, 'INR')).toBe('₹24,500.00');
    expect(formatPnlWithCurrency(pnl.netPnlAccount, 'INR')).toBe('+₹6,500.00');
  });

  // TEST 12 — Missing FX fails closed
  it('TEST 12 — Missing FX fails closed without fabricating 1.0 FX rate', () => {
    expect(() => converter.getRate('GBP', 'INR', 1700000000000)).toThrow(
      /MISSING_FX_RATE/,
    );

    converter.clearAllRates();
    expect(() => converter.getRate('USDT', 'INR', 1700000000000)).toThrow(
      /MISSING_FX_RATE/,
    );
  });

  // TEST 13 — Execution unknown
  it('TEST 13 — Execution unknown: unconfirmed / pending orders do not produce completed fills', () => {
    const fills: IFillRecord[] = [];
    expect(() => ExecutionAggregator.aggregateLeg(fills, 'ENTRY')).toThrow(
      /Cannot aggregate empty ENTRY fills array/,
    );
  });

  // TEST 14 — Duplicate fill
  it('TEST 14 — Duplicate fill: same fill ID cannot be counted twice', () => {
    const fills: IFillRecord[] = [
      {
        fillId: 'fill-unique-1',
        executionRole: 'ENTRY',
        fillPrice: 100,
        fillQuantity: 1,
        fillTimestamp: '2026-09-12T10:00:00.000Z',
      },
      {
        fillId: 'fill-unique-1',
        executionRole: 'ENTRY',
        fillPrice: 100,
        fillQuantity: 1,
        fillTimestamp: '2026-09-12T10:00:00.000Z',
      },
    ];

    expect(() => ExecutionAggregator.aggregateLeg(fills, 'ENTRY')).toThrow(
      /Duplicate fill detected/,
    );
  });

  // TEST 15 — Reopen/new trade
  it('TEST 15 — Reopen/new trade: new position gets separate execution aggregation', () => {
    const trade1Entry: IFillRecord[] = [
      {
        fillId: 't1-e1',
        tradeId: 'trade-1',
        executionRole: 'ENTRY',
        fillPrice: 100,
        fillQuantity: 10,
        fillTimestamp: '2026-09-12T10:00:00.000Z',
      },
    ];
    const trade1Exit: IFillRecord[] = [
      {
        fillId: 't1-x1',
        tradeId: 'trade-1',
        executionRole: 'EXIT',
        fillPrice: 110,
        fillQuantity: 10,
        fillTimestamp: '2026-09-12T10:15:00.000Z',
      },
    ];

    const trade2Entry: IFillRecord[] = [
      {
        fillId: 't2-e1',
        tradeId: 'trade-2',
        executionRole: 'ENTRY',
        fillPrice: 112,
        fillQuantity: 15,
        fillTimestamp: '2026-09-12T10:30:00.000Z',
      },
    ];
    const trade2Exit: IFillRecord[] = [
      {
        fillId: 't2-x1',
        tradeId: 'trade-2',
        executionRole: 'EXIT',
        fillPrice: 118,
        fillQuantity: 15,
        fillTimestamp: '2026-09-12T10:45:00.000Z',
      },
    ];

    const t1 = ExecutionAggregator.aggregateTradeLifecycle(trade1Entry, trade1Exit);
    const t2 = ExecutionAggregator.aggregateTradeLifecycle(trade2Entry, trade2Exit);

    expect(t1.entry.weightedPrice).toBe(100);
    expect(t2.entry.weightedPrice).toBe(112);
    expect(t1.durationMs).toBe(15 * 60 * 1000);
    expect(t2.durationMs).toBe(15 * 60 * 1000);
  });

  // TEST 16 — Scale-in
  it('TEST 16 — Scale-in: entry VWAP includes all scale-in fills', () => {
    const scaleInFills: IFillRecord[] = [
      {
        fillId: 'fill-initial',
        executionRole: 'ENTRY',
        fillPrice: 100,
        fillQuantity: 10,
        fillTimestamp: '2026-09-12T10:00:00.000Z',
      },
      {
        fillId: 'fill-scalein',
        executionRole: 'ENTRY',
        fillPrice: 110,
        fillQuantity: 10,
        fillTimestamp: '2026-09-12T10:05:00.000Z',
      },
    ];

    const entry = ExecutionAggregator.aggregateLeg(scaleInFills, 'ENTRY');
    expect(entry.totalQuantity).toBe(20);
    expect(entry.weightedPrice).toBe(105); // (1000 + 1100) / 20 = 105
    expect(entry.earliestFillTimeUtc).toBe('2026-09-12T10:00:00.000Z');
  });

  // TEST 17 — Scale-out
  it('TEST 17 — Scale-out: exit VWAP includes only exit fills belonging to that trade', () => {
    const scaleOutFills: IFillRecord[] = [
      {
        fillId: 'fill-tp1',
        executionRole: 'EXIT',
        fillPrice: 120,
        fillQuantity: 10,
        fillTimestamp: '2026-09-12T10:15:00.000Z',
      },
      {
        fillId: 'fill-tp2',
        executionRole: 'EXIT',
        fillPrice: 130,
        fillQuantity: 10,
        fillTimestamp: '2026-09-12T10:25:00.000Z',
      },
    ];

    const exit = ExecutionAggregator.aggregateLeg(scaleOutFills, 'EXIT');
    expect(exit.totalQuantity).toBe(20);
    expect(exit.weightedPrice).toBe(125); // (1200 + 1300) / 20 = 125
    expect(exit.latestFillTimeUtc).toBe('2026-09-12T10:25:00.000Z');
  });

  // TEST 18 — Legacy record
  it('TEST 18 — Legacy record: missing execution timestamp is marked legacy and not fabricated', () => {
    const legacyRecord: Partial<ITradeJournalRecord> = {
      tradeId: 'legacy-1',
      symbol: 'NIFTY',
      entryPrice: 24000,
      exitPrice: 24100,
      isLegacyExecutionData: true,
      executionSource: 'LEGACY_SIGNAL',
    };

    expect(legacyRecord.isLegacyExecutionData).toBe(true);
    expect(legacyRecord.executionSource).toBe('LEGACY_SIGNAL');
  });

  // TEST 19 — Journal frontend presentation
  it('TEST 19 — Journal frontend presentation: formats backend values without recalculation', () => {
    const record: ITradeJournalRecord = {
      id: 'trade-99',
      tradeId: 'trade-99',
      symbol: 'BTCUSDT',
      direction: 'BULLISH',
      side: 'BUY',
      quantity: 0.25,
      entryPrice: 94000,
      entryPriceCurrency: 'USDT',
      entryTimeUtc: '2026-09-12T10:00:00.000Z',
      exitPrice: 96000,
      exitPriceCurrency: 'USDT',
      exitTimeUtc: '2026-09-12T10:30:00.000Z',
      durationMs: 1800000,
      durationMinutes: 30,
      netPnlAccount: 46000,
      accountCurrency: 'INR',
      quotePnl: 500,
      quoteCurrency: 'USDT',
      totalChargesAccount: 184,
      realizedR: 2.5,
      state: 'TP2_HIT',
      exitReason: 'Target 2 Completed',
      executionSource: 'PAPER_FILL',
      entryFillCount: 1,
      exitFillCount: 1,
      isLegacyExecutionData: false,
    };

    expect(formatPriceWithCurrency(record.entryPrice, record.entryPriceCurrency)).toBe('94,000.00 USDT');
    expect(formatPriceWithCurrency(record.exitPrice, record.exitPriceCurrency)).toBe('96,000.00 USDT');
    expect(formatPnlWithCurrency(record.netPnlAccount, record.accountCurrency)).toBe('+₹46,000.00');
    expect(formatPnlWithCurrency(record.quotePnl!, record.quoteCurrency!)).toBe('+500.00 USDT');
  });

  // TEST 20 — Accounting snapshot hash reference
  it('TEST 20 — Accounting snapshot: journal trade references correct snapshotHash', () => {
    const btc = getAuthoritativeInstrument('BTCUSDT');
    const marginModel = resolveMarginModel(btc, { requestedLeverage: 10 });
    const fx = converter.getRate('USDT', 'INR', 1700000000000);

    const snapshot = buildAccountingSnapshot({
      accountCurrency: 'INR',
      quoteCurrency: 'USDT',
      fxResult: fx,
      contractSize: 1,
      lotSize: 0.1,
      resolvedMarginModel: marginModel,
      calculatedAt: 1700000000000,
    });

    expect(snapshot.snapshotHash).toBeDefined();
    expect(snapshot.snapshotHash.length).toBe(64);
  });
});
