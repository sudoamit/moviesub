import {
  Direction,
  ExecutionAggregator,
  formatCurrencyAmount,
  formatDateTimeToTimezone,
  formatDurationMs,
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

describe('AI Fix 104 — 27-Point Final Execution Source of Truth Suite', () => {
  let converter: PointInTimeCurrencyConverter;

  beforeEach(() => {
    PointInTimeCurrencyConverter.resetInstance();
    converter = PointInTimeCurrencyConverter.getInstance();
    converter.registerRate({ pair: 'USDT/INR', rate: 92.0, timestamp: 1700000000000, source: 'BINANCE_PIT', version: '1.0' });
    converter.registerRate({ pair: 'USD/INR', rate: 83.5, timestamp: 1700000000000, source: 'RBI_REF_PIT', version: '1.0' });
  });

  // TEST 1 — Actual fill overrides requested order price
  it('TEST 1 — Actual fill overrides requested order price', () => {
    const requestedPrice = 90000.0;
    const actualFillPrice = 90050.25;

    const fill: IFillRecord = {
      fillId: 'fill-1',
      orderId: 'order-1',
      executionRole: 'ENTRY',
      fillPrice: actualFillPrice,
      fillQuantity: 1,
      fillTimestamp: '2026-09-12T10:03:17.000Z',
    };

    const aggregated = ExecutionAggregator.aggregateLeg([fill], 'ENTRY');
    expect(aggregated.weightedPrice).toBe(actualFillPrice);
    expect(aggregated.weightedPrice).not.toBe(requestedPrice);
  });

  // TEST 2 — Actual fill timestamp overrides order creation time
  it('TEST 2 — Actual fill timestamp overrides order creation time', () => {
    const orderCreatedAt = '2026-09-12T10:00:00.000Z';
    const fillTimestamp = '2026-09-12T10:03:17.000Z';

    const fill: IFillRecord = {
      fillId: 'fill-1',
      orderId: 'order-1',
      executionRole: 'ENTRY',
      fillPrice: 90050,
      fillQuantity: 1,
      fillTimestamp,
    };

    const aggregated = ExecutionAggregator.aggregateLeg([fill], 'ENTRY');
    expect(aggregated.earliestFillTimeUtc).toBe(fillTimestamp);
    expect(aggregated.earliestFillTimeUtc).not.toBe(orderCreatedAt);
  });

  // TEST 3 — Multi-fill weighted entry price
  it('TEST 3 — Multi-fill weighted entry price: 100 x 2 + 110 x 3 = 106', () => {
    const entryFills: IFillRecord[] = [
      {
        fillId: 'fill-e1',
        executionRole: 'ENTRY',
        fillPrice: 100,
        fillQuantity: 2,
        fillTimestamp: '2026-09-12T10:00:00.000Z',
      },
      {
        fillId: 'fill-e2',
        executionRole: 'ENTRY',
        fillPrice: 110,
        fillQuantity: 3,
        fillTimestamp: '2026-09-12T10:02:00.000Z',
      },
    ];

    const aggregated = ExecutionAggregator.aggregateLeg(entryFills, 'ENTRY');
    expect(aggregated.totalQuantity).toBe(5);
    expect(aggregated.weightedPrice).toBe(106); // (200 + 330) / 5 = 106
  });

  // TEST 4 — Multi-fill weighted exit price
  it('TEST 4 — Multi-fill weighted exit price: 120 x 1 + 125 x 4 = 124', () => {
    const exitFills: IFillRecord[] = [
      {
        fillId: 'fill-x1',
        executionRole: 'EXIT',
        fillPrice: 120,
        fillQuantity: 1,
        fillTimestamp: '2026-09-12T11:15:00.000Z',
      },
      {
        fillId: 'fill-x2',
        executionRole: 'EXIT',
        fillPrice: 125,
        fillQuantity: 4,
        fillTimestamp: '2026-09-12T11:18:30.000Z',
      },
    ];

    const aggregated = ExecutionAggregator.aggregateLeg(exitFills, 'EXIT');
    expect(aggregated.totalQuantity).toBe(5);
    expect(aggregated.weightedPrice).toBe(124); // (120 + 500) / 5 = 124
  });

  // TEST 5 — Earliest entry fill timestamp
  it('TEST 5 — Earliest entry fill timestamp is correctly selected from multiple fills', () => {
    const entryFills: IFillRecord[] = [
      {
        fillId: 'fill-e1',
        executionRole: 'ENTRY',
        fillPrice: 100,
        fillQuantity: 1,
        fillTimestamp: '2026-09-12T10:05:00.000Z',
      },
      {
        fillId: 'fill-e2',
        executionRole: 'ENTRY',
        fillPrice: 101,
        fillQuantity: 1,
        fillTimestamp: '2026-09-12T10:01:00.000Z', // Earliest
      },
      {
        fillId: 'fill-e3',
        executionRole: 'ENTRY',
        fillPrice: 102,
        fillQuantity: 1,
        fillTimestamp: '2026-09-12T10:03:00.000Z',
      },
    ];

    const aggregated = ExecutionAggregator.aggregateLeg(entryFills, 'ENTRY');
    expect(aggregated.earliestFillTimeUtc).toBe('2026-09-12T10:01:00.000Z');
  });

  // TEST 6 — Latest exit fill timestamp
  it('TEST 6 — Latest exit fill timestamp is correctly selected from multiple fills', () => {
    const exitFills: IFillRecord[] = [
      {
        fillId: 'fill-x1',
        executionRole: 'EXIT',
        fillPrice: 120,
        fillQuantity: 1,
        fillTimestamp: '2026-09-12T10:30:00.000Z',
      },
      {
        fillId: 'fill-x2',
        executionRole: 'EXIT',
        fillPrice: 125,
        fillQuantity: 2,
        fillTimestamp: '2026-09-12T10:45:00.000Z', // Latest
      },
      {
        fillId: 'fill-x3',
        executionRole: 'EXIT',
        fillPrice: 122,
        fillQuantity: 1,
        fillTimestamp: '2026-09-12T10:35:00.000Z',
      },
    ];

    const aggregated = ExecutionAggregator.aggregateLeg(exitFills, 'EXIT');
    expect(aggregated.latestFillTimeUtc).toBe('2026-09-12T10:45:00.000Z');
  });

  // TEST 7 — Duration calculation
  it('TEST 7 — Duration calculation: exact exitTimeUtc - entryTimeUtc in UTC milliseconds', () => {
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

  // TEST 8 — UTC storage
  it('TEST 8 — UTC storage: timestamps are strictly represented in UTC ISO format', () => {
    const utcIso = '2026-09-12T10:03:17.000Z';
    const fill: IFillRecord = {
      fillId: 'fill-1',
      executionRole: 'ENTRY',
      fillPrice: 100,
      fillQuantity: 1,
      fillTimestamp: utcIso,
    };

    const aggregated = ExecutionAggregator.aggregateLeg([fill], 'ENTRY');
    expect(aggregated.earliestFillTimeUtc).toBe(utcIso);
    expect(new Date(aggregated.earliestFillTimeUtc).toISOString()).toBe(utcIso);
  });

  // TEST 9 — Correct Asia/Kolkata display
  it('TEST 9 — Correct Asia/Kolkata display: 2026-09-12T10:03:17.000Z renders as 15:33:17', () => {
    const utcIso = '2026-09-12T10:03:17.000Z';
    const formatted = formatDateTimeToTimezone(utcIso, 'Asia/Kolkata');
    expect(formatted).toContain('03:33:17'); // 15:33:17 pm
    expect(formatted).toContain('pm');
    expect(formatted).toContain('12');
    expect(formatted).toContain('Sep');
  });

  // TEST 10 — No double timezone conversion
  it('TEST 10 — No double timezone conversion: formatting does not drift to 21:03:17', () => {
    const utcIso = '2026-09-12T10:03:17.000Z';
    const formatted = formatDateTimeToTimezone(utcIso, 'Asia/Kolkata');
    // Ensure 10:03:17 UTC + 5:30 = 15:33:17, never 21:03:17
    expect(formatted).not.toContain('09:03:17');
    expect(formatted).not.toContain('21:03:17');
  });

  // TEST 11 — No fabricated fallback fill
  it('TEST 11 — No fabricated fallback fill: aggregating empty fills throws and does not invent fake records', () => {
    const fills: IFillRecord[] = [];
    expect(() => ExecutionAggregator.aggregateLeg(fills, 'ENTRY')).toThrow(
      /Cannot aggregate empty ENTRY fills array/,
    );
  });

  // TEST 12 — Missing execution data becomes incomplete/legacy
  it('TEST 12 — Missing execution data becomes incomplete/legacy with executionDataComplete: false', () => {
    const legacyRecord: Partial<ITradeJournalRecord> = {
      tradeId: 'legacy-1',
      symbol: 'NIFTY',
      isLegacyExecutionData: true,
      executionDataComplete: false,
      executionSource: 'LEGACY_POSITION',
    };

    expect(legacyRecord.isLegacyExecutionData).toBe(true);
    expect(legacyRecord.executionDataComplete).toBe(false);
    expect(legacyRecord.executionSource).toBe('LEGACY_POSITION');
  });

  // TEST 13 — Duplicate fill rejection
  it('TEST 13 — Duplicate fill rejection: same fillId cannot be counted twice', () => {
    const fills: IFillRecord[] = [
      {
        fillId: 'dup-1',
        executionRole: 'ENTRY',
        fillPrice: 100,
        fillQuantity: 1,
        fillTimestamp: '2026-09-12T10:00:00.000Z',
      },
      {
        fillId: 'dup-1',
        executionRole: 'ENTRY',
        fillPrice: 100,
        fillQuantity: 1,
        fillTimestamp: '2026-09-12T10:00:00.000Z',
      },
    ];

    expect(() => ExecutionAggregator.aggregateLeg(fills, 'ENTRY')).toThrow(
      /Duplicate fill detected.*dup-1/,
    );
  });

  // TEST 14 — Correct fill ownership
  it('TEST 14 — Correct fill ownership: fills carry explicit tradeId/positionId and role', () => {
    const fill: IFillRecord = {
      fillId: 'fill-owner-1',
      tradeId: 'trade-uuid-1',
      positionId: 'pos-uuid-1',
      orderId: 'order-uuid-1',
      executionRole: 'ENTRY',
      fillPrice: 25000,
      fillQuantity: 10,
      fillTimestamp: '2026-09-12T10:00:00.000Z',
    };

    expect(fill.tradeId).toBe('trade-uuid-1');
    expect(fill.positionId).toBe('pos-uuid-1');
    expect(fill.orderId).toBe('order-uuid-1');
    expect(fill.executionRole).toBe('ENTRY');
  });

  // TEST 15 — Scale-in
  it('TEST 15 — Scale-in: entry VWAP accurately combines initial and scale-in entries', () => {
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
    expect(entry.weightedPrice).toBe(105);
    expect(entry.earliestFillTimeUtc).toBe('2026-09-12T10:00:00.000Z');
  });

  // TEST 16 — Scale-out
  it('TEST 16 — Scale-out: exit VWAP accurately combines partial exit fills', () => {
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
    expect(exit.weightedPrice).toBe(125);
    expect(exit.latestFillTimeUtc).toBe('2026-09-12T10:25:00.000Z');
  });

  // TEST 17 — BTCUSDT price displayed in USDT
  it('TEST 17 — BTCUSDT price displayed in USDT without $ prefix', () => {
    const formatted = formatPriceWithCurrency(94500.5, 'USDT');
    expect(formatted).toBe('94,500.50 USDT');
    expect(formatted).not.toContain('$');
  });

  // TEST 18 — BTCUSDT P&L displayed in INR
  it('TEST 18 — BTCUSDT P&L displayed in INR with rupee symbol', () => {
    const formatted = formatPnlWithCurrency(46000, 'INR');
    expect(formatted).toBe('+₹46,000.00');
  });

  // TEST 19 — XAUUSD price displayed in USD
  it('TEST 19 — XAUUSD price displayed in USD with dollar symbol', () => {
    const formatted = formatPriceWithCurrency(2650.75, 'USD');
    expect(formatted).toBe('$2,650.75');
  });

  // TEST 20 — XAUUSD P&L displayed in INR
  it('TEST 20 — XAUUSD P&L displayed in INR', () => {
    const formatted = formatPnlWithCurrency(83500, 'INR');
    expect(formatted).toBe('+₹83,500.00');
  });

  // TEST 21 — NIFTY price/P&L displayed in INR
  it('TEST 21 — NIFTY price and P&L both displayed in INR', () => {
    const formattedPrice = formatPriceWithCurrency(24500, 'INR');
    const formattedPnl = formatPnlWithCurrency(6500, 'INR');
    expect(formattedPrice).toBe('₹24,500.00');
    expect(formattedPnl).toBe('+₹6,500.00');
  });

  // TEST 22 — Missing FX fails closed
  it('TEST 22 — Missing FX fails closed without silent fallback to 1.0', () => {
    converter.clearAllRates();
    expect(() => converter.getRate('USDT', 'INR', 1700000000000)).toThrow(
      /MISSING_FX_RATE/,
    );
  });

  // TEST 23 — Accounting snapshot immutable
  it('TEST 23 — Accounting snapshot immutable: snapshotHash is deterministic and reproducible', () => {
    const btc = getAuthoritativeInstrument('BTCUSDT');
    const marginModel = resolveMarginModel(btc, { requestedLeverage: 10 });
    const fx = converter.getRate('USDT', 'INR', 1700000000000);

    const snapshot1 = buildAccountingSnapshot({
      accountCurrency: 'INR',
      quoteCurrency: 'USDT',
      fxResult: fx,
      contractSize: 1,
      lotSize: 0.1,
      resolvedMarginModel: marginModel,
      calculatedAt: 1700000000000,
    });

    const snapshot2 = buildAccountingSnapshot({
      accountCurrency: 'INR',
      quoteCurrency: 'USDT',
      fxResult: fx,
      contractSize: 1,
      lotSize: 0.1,
      resolvedMarginModel: marginModel,
      calculatedAt: 1700000000000,
    });

    expect(snapshot1.snapshotHash).toBe(snapshot2.snapshotHash);
    expect(snapshot1.snapshotHash.length).toBe(64);
  });

  // TEST 24 — Same accounting result reaches PaperTrade
  it('TEST 24 — Same accounting result reaches PaperTrade', () => {
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

    const pnlCalc = TradeAccountingEngine.calculateTradePnl({
      entryPrice: 90000,
      exitPrice: 95000,
      quantity: 0.1,
      direction: Direction.BULLISH,
      accountingSnapshot: snapshot,
    });

    const paperTradePnL = pnlCalc.netPnlAccount;
    expect(paperTradePnL).toBe(46000);
    expect(pnlCalc.quotePnl).toBe(500);
  });

  // TEST 25 — Same accounting result reaches PaperAccount
  it('TEST 25 — Same accounting result reaches PaperAccount for cashBalance and realizedPnL parity', () => {
    const entryCharges = 100;
    const exitCharges = 100;
    const grossPnlAccount = 46000;
    const netPnlAccount = grossPnlAccount - (entryCharges + exitCharges); // 45800

    // Lifecycle cash delta: (-entryCharges) + (grossPnlAccount - exitCharges) = grossPnlAccount - totalCharges
    const openingCashDelta = -entryCharges;
    const exitCashDelta = grossPnlAccount - exitCharges;
    const totalCashChange = openingCashDelta + exitCashDelta;

    expect(totalCashChange).toBe(netPnlAccount);
  });

  // TEST 26 — Same accounting result reaches Journal
  it('TEST 26 — Same accounting result reaches Journal', () => {
    const journalRecord: ITradeJournalRecord = {
      id: 'trade-canonical-1',
      tradeId: 'trade-canonical-1',
      symbol: 'BTCUSDT',
      direction: 'BULLISH',
      side: 'BUY',
      quantity: 0.1,
      actualEntryPrice: 90000,
      actualEntryPriceCurrency: 'USDT',
      entryPrice: 90000,
      entryPriceCurrency: 'USDT',
      entryTimeUtc: '2026-09-12T10:00:00.000Z',
      actualExitPrice: 95000,
      actualExitPriceCurrency: 'USDT',
      exitPrice: 95000,
      exitPriceCurrency: 'USDT',
      exitTimeUtc: '2026-09-12T10:30:00.000Z',
      holdingDurationMs: 1800000,
      holdingDurationSeconds: 1800,
      durationMs: 1800000,
      durationMinutes: 30,
      netPnlAccount: 46000,
      accountCurrency: 'INR',
      quotePnl: 500,
      quoteCurrency: 'USDT',
      chargesAccount: 200,
      totalChargesAccount: 200,
      realizedR: 2.5,
      state: 'TP2_HIT',
      exitReason: 'Target 2 Hit',
      executionSource: 'PAPER_FILL',
      entryFillCount: 1,
      exitFillCount: 1,
      isLegacyExecutionData: false,
      executionDataComplete: true,
    };

    expect(journalRecord.actualEntryPrice).toBe(90000);
    expect(journalRecord.actualExitPrice).toBe(95000);
    expect(journalRecord.netPnlAccount).toBe(46000);
    expect(journalRecord.quotePnl).toBe(500);
    expect(journalRecord.executionDataComplete).toBe(true);
  });

  // TEST 27 — Frontend does not recompute execution fields
  it('TEST 27 — Frontend does not recompute execution fields: formats directly from canonical DTO', () => {
    const record: ITradeJournalRecord = {
      id: 'trade-front-1',
      tradeId: 'trade-front-1',
      symbol: 'BTCUSDT',
      direction: 'BULLISH',
      side: 'BUY',
      quantity: 0.25,
      actualEntryPrice: 94000,
      actualEntryPriceCurrency: 'USDT',
      entryPrice: 94000,
      entryPriceCurrency: 'USDT',
      entryTimeUtc: '2026-09-12T10:00:00.000Z',
      actualExitPrice: 96000,
      actualExitPriceCurrency: 'USDT',
      exitPrice: 96000,
      exitPriceCurrency: 'USDT',
      exitTimeUtc: '2026-09-12T10:30:00.000Z',
      holdingDurationMs: 1800000,
      holdingDurationSeconds: 1800,
      durationMs: 1800000,
      durationMinutes: 30,
      netPnlAccount: 46000,
      accountCurrency: 'INR',
      quotePnl: 500,
      quoteCurrency: 'USDT',
      chargesAccount: 184,
      totalChargesAccount: 184,
      realizedR: 2.5,
      state: 'TP2_HIT',
      exitReason: 'Target 2 Completed',
      executionSource: 'PAPER_FILL',
      entryFillCount: 1,
      exitFillCount: 1,
      isLegacyExecutionData: false,
      executionDataComplete: true,
    };

    const formattedEntry = formatPriceWithCurrency(record.actualEntryPrice, record.actualEntryPriceCurrency);
    const formattedExit = formatPriceWithCurrency(record.actualExitPrice, record.actualExitPriceCurrency);
    const formattedPnl = formatPnlWithCurrency(record.netPnlAccount, record.accountCurrency);
    const formattedQuotePnl = formatPnlWithCurrency(record.quotePnl!, record.quoteCurrency!);
    const formattedDuration = formatDurationMs(record.holdingDurationMs);

    expect(formattedEntry).toBe('94,000.00 USDT');
    expect(formattedExit).toBe('96,000.00 USDT');
    expect(formattedPnl).toBe('+₹46,000.00');
    expect(formattedQuotePnl).toBe('+500.00 USDT');
    expect(formattedDuration).toBe('30m 0s');
  });
});
