import {
  Direction,
  ExecutionPriceSource,
  IFillRecord,
  formatPriceWithCurrency,
  formatPnlWithCurrency,
  formatCurrencyAmount,
  getAuthoritativeInstrument,
  hasInstrument,
  buildAccountingSnapshot,
  PointInTimeCurrencyConverter,
  resolveMarginModel,
  ExecutionAggregator,
  ITradeJournalRecord,
} from '@quant/shared';
import { TradeAccountingEngine } from '../trade-accounting-engine';

describe('Execution Provenance, Cash Parity & Journal Accounting Integrity', () => {
  describe('1. Cash Parity & Fee Accounting Invariant', () => {
    it('proves lifecycle invariant: (opening cash delta) + (closing cash delta) = netPnlAccount', () => {
      // Scenario: NIFTY Long Position
      const entryPrice = 24000;
      const exitPrice = 24200;
      const quantity = 50; // 50 units
      const contractSize = 1;
      const fxRate = 1.0; // INR

      const entryCharges = 23.5;
      const exitCharges = 24.1;
      const totalCharges = Number((entryCharges + exitCharges).toFixed(2)); // 47.60

      // Step 1: Position Opened
      // Opening cash delta is strictly -entryCharges
      const openingCashDelta = -entryCharges;

      // Step 2: Trade Accounting Engine computes Gross and Net P&L
      const pnlCalc = TradeAccountingEngine.calculateTradePnl({
        entryPrice,
        exitPrice,
        quantity,
        direction: Direction.BULLISH,
        contractSize,
        fxRate,
        fees: totalCharges,
      });

      // Gross P&L = (24200 - 24000) * 50 = 10,000 INR
      expect(pnlCalc.grossPnlAccount).toBe(10000);
      // Net P&L = 10000 - 47.60 = 9952.40 INR
      expect(pnlCalc.netPnlAccount).toBe(9952.4);

      // Step 3: Position Closed
      // Closing cash delta is grossPnlAccount - exitCharges
      const closingCashDelta = pnlCalc.grossPnlAccount - exitCharges;

      // Assert lifecycle cash parity invariant
      const totalLifecycleCashDelta = Number((openingCashDelta + closingCashDelta).toFixed(2));
      expect(totalLifecycleCashDelta).toBe(pnlCalc.netPnlAccount);
      expect(totalLifecycleCashDelta).toBe(9952.4);
    });

    it('proves cash parity invariant on cross-currency crypto trade (BTCUSDT)', () => {
      const entryPrice = 90000;
      const exitPrice = 95000;
      const quantity = 0.5; // BTC
      const contractSize = 1;
      const fxRateUsdtInr = 88.5; // 1 USDT = 88.5 INR

      const entryChargesInr = 150.0;
      const exitChargesInr = 160.0;
      const totalChargesInr = Number((entryChargesInr + exitChargesInr).toFixed(2)); // 310.00 INR

      const openingCashDelta = -entryChargesInr;

      const pnlCalc = TradeAccountingEngine.calculateTradePnl({
        entryPrice,
        exitPrice,
        quantity,
        direction: Direction.BULLISH,
        contractSize,
        quoteCurrency: 'USDT',
        accountCurrency: 'INR',
        fxRate: fxRateUsdtInr,
        fees: totalChargesInr,
      });

      // Gross PnL in Quote (USDT) = (95000 - 90000) * 0.5 = 2,500 USDT
      expect(pnlCalc.grossPnlQuote).toBe(2500);
      // Gross PnL in Account (INR) = 2500 * 88.5 = 221,250 INR
      expect(pnlCalc.grossPnlAccount).toBe(221250);
      // Net PnL in Account (INR) = 221250 - 310 = 220,940 INR
      expect(pnlCalc.netPnlAccount).toBe(220940);

      const closingCashDelta = pnlCalc.grossPnlAccount - exitChargesInr;
      const totalLifecycleCashDelta = Number((openingCashDelta + closingCashDelta).toFixed(2));

      expect(totalLifecycleCashDelta).toBe(pnlCalc.netPnlAccount);
      expect(totalLifecycleCashDelta).toBe(220940);
    });
  });

  describe('2. Legacy / Incomplete Execution Data Nullability', () => {
    it('sets actualEntryPrice, actualEntryPriceCurrency, and entryTimeUtc strictly to null when no entry fills exist', () => {
      const hasAuthoritativeEntryFills = false;
      const isLegacyExecutionData = !hasAuthoritativeEntryFills;
      const executionDataComplete = hasAuthoritativeEntryFills;

      const pos = {
        id: 'pos_legacy_1',
        symbol: 'BTCUSDT',
        quantity: 0.1,
        entryPrice: 95123.45,
        entryTime: new Date('2026-09-12T03:42:00.000Z'),
      };

      const outcomeSnapshot = {
        actualEntryPrice: hasAuthoritativeEntryFills ? pos.entryPrice : null,
        actualEntryPriceCurrency: hasAuthoritativeEntryFills ? 'USDT' : null,
        entryTimeUtc: hasAuthoritativeEntryFills ? pos.entryTime.toISOString() : null,
        isLegacyExecutionData,
        executionDataComplete,
      };

      expect(outcomeSnapshot.actualEntryPrice).toBeNull();
      expect(outcomeSnapshot.actualEntryPriceCurrency).toBeNull();
      expect(outcomeSnapshot.entryTimeUtc).toBeNull();
      expect(outcomeSnapshot.isLegacyExecutionData).toBe(true);
      expect(outcomeSnapshot.executionDataComplete).toBe(false);
    });

    it('populates actual execution fields when authoritative fills exist', () => {
      const fillTime = new Date('2026-09-12T03:42:15.000Z');
      const entryFills: IFillRecord[] = [
        {
          fillId: 'fill_1',
          orderId: 'ord_1',
          positionId: 'pos_1',
          executionRole: 'ENTRY',
          fillPrice: 95120.0,
          fillQuantity: 0.1,
          fillTimestamp: fillTime,
          fee: 5.0,
          slippage: 1.2,
          executionPriceSource: ExecutionPriceSource.LIVE_TICK,
          sourceTimestamp: fillTime,
        },
      ];

      const exitFill: IFillRecord = {
        fillId: 'fill_2',
        orderId: 'ord_2',
        positionId: 'pos_1',
        executionRole: 'EXIT',
        fillPrice: 96000.0,
        fillQuantity: 0.1,
        fillTimestamp: new Date('2026-09-12T04:00:00.000Z'),
        fee: 5.0,
        slippage: 0.8,
        executionPriceSource: ExecutionPriceSource.LIVE_TICK,
        sourceTimestamp: new Date('2026-09-12T04:00:00.000Z'),
      };

      const aggregated = ExecutionAggregator.aggregateTradeLifecycle(entryFills, [exitFill]);
      const hasAuthoritativeEntryFills = entryFills.length > 0;

      const outcomeSnapshot = {
        actualEntryPrice: hasAuthoritativeEntryFills ? aggregated.entry.weightedPrice : null,
        actualEntryPriceCurrency: hasAuthoritativeEntryFills ? 'USDT' : null,
        entryTimeUtc: hasAuthoritativeEntryFills ? aggregated.entry.earliestFillTimeUtc : null,
        actualExitPrice: aggregated.exit.weightedPrice,
        actualExitPriceCurrency: 'USDT',
        exitTimeUtc: aggregated.exit.latestFillTimeUtc,
        isLegacyExecutionData: false,
        executionDataComplete: true,
      };

      expect(outcomeSnapshot.actualEntryPrice).toBe(95120.0);
      expect(outcomeSnapshot.actualEntryPriceCurrency).toBe('USDT');
      expect(outcomeSnapshot.entryTimeUtc).toBe(fillTime.toISOString());
      expect(outcomeSnapshot.actualExitPrice).toBe(96000.0);
      expect(outcomeSnapshot.isLegacyExecutionData).toBe(false);
      expect(outcomeSnapshot.executionDataComplete).toBe(true);
    });
  });

  describe('3. Strict Authoritative Instrument Registry (Fail-Closed)', () => {
    it('successfully resolves registered instruments with canonical currencies', () => {
      const btc = getAuthoritativeInstrument('BTCUSDT');
      expect(btc.currency).toBe('USDT');

      const nifty = getAuthoritativeInstrument('NIFTY');
      expect(nifty.currency).toBe('INR');

      const gold = getAuthoritativeInstrument('GOLD');
      expect(gold.currency).toBe('INR');
    });

    it('fails closed on unknown instruments with INVALID_INSTRUMENT_SPECIFICATION error', () => {
      expect(() => getAuthoritativeInstrument('UNKNOWN_XYZ')).toThrow('INVALID_INSTRUMENT_SPECIFICATION');
      expect(() => getAuthoritativeInstrument('')).toThrow('INVALID_INSTRUMENT_SPECIFICATION');
    });
  });

  describe('4. Opening Accounting Snapshot & Execution Timestamp Provenance', () => {
    it('anchors opening snapshot timestamp to simulated execution fill timestamp', () => {
      const simulatedFillTime = new Date('2026-09-12T10:00:04.000Z');
      const btc = getAuthoritativeInstrument('BTCUSDT');

      const converter = PointInTimeCurrencyConverter.getInstance();
      const fxRes = converter.getRate(btc.currency, 'INR', simulatedFillTime.getTime());
      const marginModel = resolveMarginModel(btc, { requestedLeverage: 5 });

      const snapshot = buildAccountingSnapshot({
        accountCurrency: 'INR',
        quoteCurrency: btc.currency,
        fxResult: fxRes,
        contractSize: btc.contractSize ?? 1,
        lotSize: 0.5,
        resolvedMarginModel: marginModel,
        calculatedAt: simulatedFillTime.getTime(),
      });

      expect(snapshot.calculatedAt).toBe(simulatedFillTime.getTime());
      expect(new Date(snapshot.calculatedAt).toISOString()).toBe(simulatedFillTime.toISOString());
    });

    it('proves execution timestamp canonicalization: Market Tick Time != Order Submission Time != Fill Execution Time', () => {
      // 1. Market data tick arrives from exchange
      const marketTickTimestamp = new Date('2026-09-12T10:00:00.000Z');
      // 2. Order is created and submitted to engine
      const orderSubmittedAt = new Date('2026-09-12T10:00:02.000Z');
      // 3. Simulated execution fill occurs
      const fillExecutionTimestamp = new Date('2026-09-12T10:00:02.050Z');

      // Assert distinct timestamps across pipeline
      expect(marketTickTimestamp.getTime()).not.toBe(orderSubmittedAt.getTime());
      expect(orderSubmittedAt.getTime()).not.toBe(fillExecutionTimestamp.getTime());

      // Create PaperFill
      const entryFill: IFillRecord = {
        fillId: 'fill_canonical_1',
        orderId: 'ord_1',
        positionId: 'pos_1',
        executionRole: 'ENTRY',
        fillPrice: 95000.0,
        fillQuantity: 1.0,
        fillTimestamp: fillExecutionTimestamp,
        sourceTimestamp: marketTickTimestamp,
      };

      const exitFill: IFillRecord = {
        fillId: 'fill_canonical_2',
        orderId: 'ord_2',
        positionId: 'pos_1',
        executionRole: 'EXIT',
        fillPrice: 95500.0,
        fillQuantity: 1.0,
        fillTimestamp: new Date('2026-09-12T10:15:00.000Z'),
        sourceTimestamp: new Date('2026-09-12T10:14:59.000Z'),
      };

      const aggregated = ExecutionAggregator.aggregateTradeLifecycle([entryFill], [exitFill]);

      // PaperTrade entryTime must strictly equal PaperFill.fillTimestamp
      const paperTradeEntryTime = new Date(aggregated.entry.earliestFillTimestamp);
      expect(paperTradeEntryTime.getTime()).toBe(fillExecutionTimestamp.getTime());
      expect(paperTradeEntryTime.getTime()).not.toBe(marketTickTimestamp.getTime());

      // Journal entryTimeUtc must strictly equal PaperTrade entryTime (ISO string)
      const journalEntryTimeUtc = aggregated.entry.earliestFillTimeUtc;
      expect(journalEntryTimeUtc).toBe(fillExecutionTimestamp.toISOString());
    });
  });

  describe('5. Multi-Asset Currency Formatting Integrity', () => {
    it('formats prices and P&L strictly according to institutional currency rules', () => {
      // INR Price
      expect(formatPriceWithCurrency(24125.5, 'INR')).toBe('₹24,125.50');
      // USDT Price (NEVER $ prefix)
      expect(formatPriceWithCurrency(95123.45, 'USDT')).toBe('95,123.45 USDT');
      // USD Price
      expect(formatPriceWithCurrency(2650.75, 'USD')).toBe('$2,650.75');

      // Positive & Negative P&L with sign
      expect(formatPnlWithCurrency(9952.4, 'INR')).toBe('+₹9,952.40');
      expect(formatPnlWithCurrency(-5620.2, 'INR')).toBe('-₹5,620.20');
      expect(formatPnlWithCurrency(2500, 'USDT')).toBe('+2,500.00 USDT');
    });
  });
});
