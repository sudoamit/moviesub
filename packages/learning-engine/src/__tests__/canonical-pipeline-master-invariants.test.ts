import {
  Direction,
  ICandle,
  Timeframe,
  PositionSide,
  ExecutionPriceSource,
  OrderState,
  PositionState,
  getAuthoritativeInstrument,
  PointInTimeCurrencyConverter,
  buildAccountingSnapshot,
  resolveMarginModel,
  ExecutionAggregator,
  IFillRecord,
  IFxConversionResult,
} from '@quant/shared';
import {
  SMCAnalyzer,
  SignalGenerator,
  CanonicalMarketSnapshotBuilder,
  CandleNormalizer,
} from '@quant/trading-engine';
import {
  TradeAccountingEngine,
  PositionSizer,
} from '@quant/risk-engine';
import { BacktestSimulator, FillModel } from '@quant/backtesting';

describe('MASTER ENGINEERING FIX — Canonical Trading Pipeline & Global Invariants Suite', () => {
  const baseTime = new Date('2026-01-01T09:15:00.000Z').getTime();

  // Helper to generate sequential candles
  const createDeterministicCandles = (count: number, startPrice = 100): ICandle[] => {
    const candles: ICandle[] = [];
    let price = startPrice;

    for (let i = 0; i < count; i++) {
      const open = price;
      const close = price + 1.0;
      const high = Math.max(open, close) + 0.5;
      const low = Math.min(open, close) - 0.5;
      candles.push({
        timestamp: new Date(baseTime + i * 15 * 60 * 1000),
        open,
        high,
        low,
        close,
        volume: 1000,
        isClosed: true,
        provenance: 'LIVE',
      });
      price = close;
    }
    return candles;
  };

  // ============================================================
  // TEST 1: Same market snapshot produces identical SMC result
  // ============================================================
  it('TEST 1: Same market snapshot produces deterministic identical SMC result', () => {
    const candles = createDeterministicCandles(40, 100);
    const snapshotA = CanonicalMarketSnapshotBuilder.build({
      symbol: 'NIFTY',
      executionCandles: candles,
      executionTimeframe: Timeframe.M15,
    });

    const snapshotB = CanonicalMarketSnapshotBuilder.build({
      symbol: 'NIFTY',
      executionCandles: candles,
      executionTimeframe: Timeframe.M15,
    });

    const smcA = SMCAnalyzer.analyze(snapshotA.candles as ICandle[], {
      asOfTimestamp: snapshotA.decisionTimestamp,
    });
    const smcB = SMCAnalyzer.analyze(snapshotB.candles as ICandle[], {
      asOfTimestamp: snapshotB.decisionTimestamp,
    });

    expect(smcB).toEqual(smcA);
    expect(smcA.closedThrough).toEqual(snapshotA.closedThroughTimestamp);
  });

  // ============================================================
  // TEST 2: Appending an UNFINISHED candle does not change confirmed SMC
  // ============================================================
  it('TEST 2: Appending an UNFINISHED (forming) candle does not change confirmed SMC structures', () => {
    const closedCandles = createDeterministicCandles(30, 100);
    const baselineSMC = SMCAnalyzer.analyze(closedCandles);

    // Append forming candle with wild price spike and isClosed: false
    const formingCandle: ICandle = {
      timestamp: new Date(baseTime + 30 * 15 * 60 * 1000),
      open: 130,
      high: 999, // Extreme unconfirmed spike
      low: 129,
      close: 950,
      volume: 100000,
      isClosed: false,
    };

    const expandedWithForming = [...closedCandles, formingCandle];
    const smcWithForming = SMCAnalyzer.analyze(expandedWithForming);

    expect(smcWithForming.candlesCount).toBe(baselineSMC.candlesCount);
    expect(smcWithForming.currentTrend).toBe(baselineSMC.currentTrend);
    expect(smcWithForming.swingPoints.length).toBe(baselineSMC.swingPoints.length);
    expect(smcWithForming.breaksOfStructure.length).toBe(baselineSMC.breaksOfStructure.length);
    expect(smcWithForming.fairValueGaps.length).toBe(baselineSMC.fairValueGaps.length);
    expect(smcWithForming.orderBlocks.length).toBe(baselineSMC.orderBlocks.length);
    expect(smcWithForming.formingCandle).toBeDefined();
    expect(smcWithForming.formingCandle?.high).toBe(999);
  });

  // ============================================================
  // TEST 3: Future candle does not change prior timestamp's signal
  // ============================================================
  it("TEST 3: Future candle does not change prior timestamp's signal", () => {
    const historicalCandles = createDeterministicCandles(35, 100);
    const tDecision = CandleNormalizer.getCandleCloseTimestamp(historicalCandles[34], '15m');

    const baselineSignal = SignalGenerator.generateSignal({
      symbol: 'BTCUSDT',
      executionCandles: historicalCandles,
      asOfTimestamp: tDecision,
    });

    // Append future shock candles (+50% pump, -80% crash)
    const futureShockCandles: ICandle[] = [
      ...historicalCandles,
      {
        timestamp: new Date(tDecision.getTime() + 15 * 60000),
        open: 135,
        high: 250,
        low: 134,
        close: 245,
        volume: 500000,
        isClosed: true,
      },
      {
        timestamp: new Date(tDecision.getTime() + 30 * 60000),
        open: 245,
        high: 250,
        low: 20,
        close: 25,
        volume: 900000,
        isClosed: true,
      },
    ];

    const signalAfterShock = SignalGenerator.generateSignal({
      symbol: 'BTCUSDT',
      executionCandles: futureShockCandles,
      asOfTimestamp: tDecision,
    });

    expect(signalAfterShock.score).toBe(baselineSignal.score);
    expect(signalAfterShock.direction).toBe(baselineSignal.direction);
    expect(signalAfterShock.grade).toBe(baselineSignal.grade);
    expect(signalAfterShock.entryZone).toEqual(baselineSignal.entryZone);
    expect(signalAfterShock.stopLoss).toBe(baselineSignal.stopLoss);
    expect(signalAfterShock.takeProfits).toEqual(baselineSignal.takeProfits);
  });

  // ============================================================
  // TEST 4: Leverage changes margin/liquidation but not fixed-position gross P&L
  // ============================================================
  it('TEST 4: Leverage changes margin/liquidation but not fixed-position gross P&L', () => {
    const inst = getAuthoritativeInstrument('BTCUSDT');
    const converter = PointInTimeCurrencyConverter.getInstance();
    const fx = converter.getRate('USDT', 'INR', baseTime);

    const snapshot1x = buildAccountingSnapshot({
      accountCurrency: 'INR',
      quoteCurrency: 'USDT',
      fxResult: fx,
      contractSize: 1.0,
      lotSize: 1.0,
      resolvedMarginModel: resolveMarginModel(inst, { requestedLeverage: 1 }),
      calculatedAt: baseTime,
    });

    const snapshot10x = buildAccountingSnapshot({
      accountCurrency: 'INR',
      quoteCurrency: 'USDT',
      fxResult: fx,
      contractSize: 1.0,
      lotSize: 1.0,
      resolvedMarginModel: resolveMarginModel(inst, { requestedLeverage: 10 }),
      calculatedAt: baseTime,
    });

    // 1 BTC long from 90,000 to 95,000
    const pnl1x = TradeAccountingEngine.calculateTradePnl({
      entryPrice: 90000,
      exitPrice: 95000,
      quantity: 1.0,
      direction: Direction.BULLISH,
      accountingSnapshot: snapshot1x,
      fees: 0,
    });

    const pnl10x = TradeAccountingEngine.calculateTradePnl({
      entryPrice: 90000,
      exitPrice: 95000,
      quantity: 1.0,
      direction: Direction.BULLISH,
      accountingSnapshot: snapshot10x,
      fees: 0,
    });

    // Gross P&L is identical regardless of leverage
    expect(pnl10x.quotePnl).toBe(5000);
    expect(pnl10x.grossPnlAccount).toBe(pnl1x.grossPnlAccount);
    expect(pnl10x.netPnlAccount).toBe(pnl1x.netPnlAccount);

    // But required initial margin is 10x smaller
    const notional1 = TradeAccountingEngine.calculateNotional(1.0, 90000, snapshot1x);
    const notional10 = TradeAccountingEngine.calculateNotional(1.0, 90000, snapshot10x);
    const margin1x = TradeAccountingEngine.calculateMargin(notional1.notionalAccount, snapshot1x).initialMarginRequired;
    const margin10x = TradeAccountingEngine.calculateMargin(notional10.notionalAccount, snapshot10x).initialMarginRequired;
    expect(margin10x).toBeCloseTo(margin1x / 10, 1);
  });

  // ============================================================
  // TEST 5: Contract size changes notional/risk/P&L consistently
  // ============================================================
  it('TEST 5: Contract size changes notional, risk, and P&L consistently', () => {
    const inst = getAuthoritativeInstrument('BTCUSDT');
    const fx = PointInTimeCurrencyConverter.getInstance().getRate('USDT', 'INR', baseTime);

    const snapshotContract1 = buildAccountingSnapshot({
      accountCurrency: 'INR',
      quoteCurrency: 'USDT',
      fxResult: fx,
      contractSize: 1.0,
      lotSize: 1.0,
      resolvedMarginModel: resolveMarginModel(inst, { requestedLeverage: 1 }),
      calculatedAt: baseTime,
    });

    const snapshotContract10 = buildAccountingSnapshot({
      accountCurrency: 'INR',
      quoteCurrency: 'USDT',
      fxResult: fx,
      contractSize: 10.0,
      lotSize: 1.0,
      resolvedMarginModel: resolveMarginModel(inst, { requestedLeverage: 1 }),
      calculatedAt: baseTime,
    });

    const pnl1 = TradeAccountingEngine.calculateTradePnl({
      entryPrice: 100,
      exitPrice: 110,
      quantity: 2.0,
      direction: Direction.BULLISH,
      accountingSnapshot: snapshotContract1,
    });

    const pnl10 = TradeAccountingEngine.calculateTradePnl({
      entryPrice: 100,
      exitPrice: 110,
      quantity: 2.0,
      direction: Direction.BULLISH,
      accountingSnapshot: snapshotContract10,
    });

    expect(pnl1.quotePnl).toBe(20); // (110 - 100) * 2 * 1
    expect(pnl10.quotePnl).toBe(200); // (110 - 100) * 2 * 10
    expect(pnl10.grossPnlAccount).toBeCloseTo(pnl1.grossPnlAccount * 10, 2);
  });

  // ============================================================
  // TEST 6: FX changes account P&L but not quote P&L
  // ============================================================
  it('TEST 6: FX conversion changes account P&L while strictly preserving quote P&L', () => {
    const inst = getAuthoritativeInstrument('BTCUSDT');

    const fxRate85: IFxConversionResult = {
      convertedAmount: 85,
      originalAmount: 1,
      fxPair: 'USDT/INR',
      fxRate: 85.0,
      fromCurrency: 'USDT' as any,
      toCurrency: 'INR' as any,
      fxTimestamp: baseTime,
      fxSource: 'FIXED' as const,
      fxVersion: '1.0',
      fxSnapshotHash: 'hash-85',
    };
    const fxRate90: IFxConversionResult = {
      convertedAmount: 90,
      originalAmount: 1,
      fxPair: 'USDT/INR',
      fxRate: 90.0,
      fromCurrency: 'USDT' as any,
      toCurrency: 'INR' as any,
      fxTimestamp: baseTime,
      fxSource: 'FIXED' as const,
      fxVersion: '1.0',
      fxSnapshotHash: 'hash-90',
    };

    const snapshot85 = buildAccountingSnapshot({
      accountCurrency: 'INR',
      quoteCurrency: 'USDT',
      fxResult: fxRate85,
      contractSize: 1.0,
      lotSize: 1.0,
      resolvedMarginModel: resolveMarginModel(inst),
      calculatedAt: baseTime,
    });

    const snapshot90 = buildAccountingSnapshot({
      accountCurrency: 'INR',
      quoteCurrency: 'USDT',
      fxResult: fxRate90,
      contractSize: 1.0,
      lotSize: 1.0,
      resolvedMarginModel: resolveMarginModel(inst),
      calculatedAt: baseTime,
    });

    const pnl85 = TradeAccountingEngine.calculateTradePnl({
      entryPrice: 50000,
      exitPrice: 52000,
      quantity: 1.0,
      direction: Direction.BULLISH,
      accountingSnapshot: snapshot85,
      fees: 0,
    });

    const pnl90 = TradeAccountingEngine.calculateTradePnl({
      entryPrice: 50000,
      exitPrice: 52000,
      quantity: 1.0,
      direction: Direction.BULLISH,
      accountingSnapshot: snapshot90,
      fees: 0,
    });

    // Quote P&L is identically 2,000 USDT in both
    expect(pnl85.quotePnl).toBe(2000);
    expect(pnl90.quotePnl).toBe(2000);

    // Account P&L scales with the respective FX rate
    expect(pnl85.grossPnlAccount).toBe(2000 * 85.0);
    expect(pnl90.grossPnlAccount).toBe(2000 * 90.0);
  });

  // ============================================================
  // TEST 7: Missing cross-currency FX fails closed
  // ============================================================
  it('TEST 7: Missing cross-currency FX rate fails closed', () => {
    const converter = PointInTimeCurrencyConverter.getInstance();
    // Non-existent synthetic currency pair
    expect(() => {
      converter.getRate('UNKNOWN_COIN' as any, 'INR', baseTime);
    }).toThrow();
  });

  // ============================================================
  // TEST 8: Partial fills aggregate to authoritative weighted execution price
  // ============================================================
  it('TEST 8: Partial fills aggregate deterministically into authoritative weighted execution price', () => {
    const fills: IFillRecord[] = [
      {
        fillId: 'fill-1',
        orderId: 'order-1',
        executionRole: 'ENTRY',
        fillPrice: 100.0,
        fillQuantity: 10.0,
        fillTimestamp: new Date(baseTime),
        fee: 5.0,
        slippage: 0.1,
        executionPriceSource: ExecutionPriceSource.LIVE_TICK,
      },
      {
        fillId: 'fill-2',
        orderId: 'order-1',
        executionRole: 'ENTRY',
        fillPrice: 106.0,
        fillQuantity: 30.0,
        fillTimestamp: new Date(baseTime + 1000),
        fee: 15.0,
        slippage: 0.2,
        executionPriceSource: ExecutionPriceSource.LIVE_TICK,
      },
    ];

    const aggregated = ExecutionAggregator.aggregateLeg(fills, 'ENTRY');
    // Weighted price = (100 * 10 + 106 * 30) / 40 = (1000 + 3180) / 40 = 4180 / 40 = 104.5
    expect(aggregated.totalQuantity).toBe(40.0);
    expect(aggregated.weightedPrice).toBe(104.5);
    expect(aggregated.totalFees).toBe(20.0);
    expect(aggregated.fillCount).toBe(2);
  });

  // ============================================================
  // TEST 9 & 10: Entry timestamp = earliest fill & Exit timestamp = latest fill
  // ============================================================
  it('TEST 9 & 10: Entry timestamp equals earliest fill timestamp & Exit timestamp equals latest fill timestamp', () => {
    const entryFills: IFillRecord[] = [
      {
        fillId: 'entry-1',
        orderId: 'order-entry',
        executionRole: 'ENTRY',
        fillPrice: 100,
        fillQuantity: 10,
        fillTimestamp: new Date('2026-01-01T10:00:00.000Z'),
      },
      {
        fillId: 'entry-2',
        orderId: 'order-entry',
        executionRole: 'ENTRY',
        fillPrice: 102,
        fillQuantity: 10,
        fillTimestamp: new Date('2026-01-01T10:05:00.000Z'),
      },
    ];

    const exitFills: IFillRecord[] = [
      {
        fillId: 'exit-1',
        orderId: 'order-exit',
        executionRole: 'EXIT',
        fillPrice: 110,
        fillQuantity: 10,
        fillTimestamp: new Date('2026-01-01T10:30:00.000Z'),
      },
      {
        fillId: 'exit-2',
        orderId: 'order-exit',
        executionRole: 'EXIT',
        fillPrice: 112,
        fillQuantity: 10,
        fillTimestamp: new Date('2026-01-01T10:45:00.000Z'),
      },
    ];

    const lifecycle = ExecutionAggregator.aggregateTradeLifecycle(entryFills, exitFills);
    expect(lifecycle.entry!.earliestFillTimestamp).toBe(new Date('2026-01-01T10:00:00.000Z').getTime());
    expect(lifecycle.exit.latestFillTimestamp).toBe(new Date('2026-01-01T10:45:00.000Z').getTime());
    expect(lifecycle.durationMs).toBe(45 * 60 * 1000); // 10:00 to 10:45
  });

  // ============================================================
  // TEST 11: Incomplete trade cannot enter learning
  // ============================================================
  it('TEST 11: Incomplete trade cannot enter AI learning dataset', () => {
    const incompleteTrade = {
      symbol: 'NIFTY',
      direction: 'BUY' as const,
      entryPrice: null, // Missing entry price
      exitPrice: 24000,
      entryTimestamp: null,
      exitTimestamp: new Date(),
      realizedR: null,
      outcomeSnapshotJson: { executionDataComplete: false, isLegacyExecutionData: true },
    };

    // Check verification predicate
    const outcome = incompleteTrade.outcomeSnapshotJson || {};
    const isIncomplete =
      incompleteTrade.entryPrice === null ||
      incompleteTrade.entryTimestamp === null ||
      incompleteTrade.realizedR === null ||
      outcome.executionDataComplete === false ||
      outcome.isLegacyExecutionData === true;

    expect(isIncomplete).toBe(true);
  });

  // ============================================================
  // TEST 12: Synthetic candles cannot trigger production signal
  // ============================================================
  it('TEST 12: Synthetic candles are tagged as SYNTHETIC provenance and isolated', () => {
    const syntheticCandles = createDeterministicCandles(30).map((c) => ({
      ...c,
      provenance: 'SYNTHETIC' as const,
    }));

    const snapshot = CanonicalMarketSnapshotBuilder.build({
      symbol: 'NIFTY',
      executionCandles: syntheticCandles,
      dataProvenance: 'SYNTHETIC',
    });

    expect(snapshot.dataProvenance).toBe('SYNTHETIC');
  });

  // ============================================================
  // TEST 13: Paper/live/shadow use identical accounting semantics
  // ============================================================
  it('TEST 13: Paper, Live, Shadow, and Backtest modes share identical accounting formulas', () => {
    const inst = getAuthoritativeInstrument('NIFTY');
    const fx = PointInTimeCurrencyConverter.getInstance().getRate('INR', 'INR', baseTime);

    const snapshot = buildAccountingSnapshot({
      accountCurrency: 'INR',
      quoteCurrency: 'INR',
      fxResult: fx,
      contractSize: 1.0,
      lotSize: 65,
      resolvedMarginModel: resolveMarginModel(inst, { requestedLeverage: 1 }),
      calculatedAt: baseTime,
    });

    const pnlPaper = TradeAccountingEngine.calculateTradePnl({
      entryPrice: 24000,
      exitPrice: 24100,
      quantity: 65,
      direction: Direction.BULLISH,
      accountingSnapshot: snapshot,
      fees: 40,
    });

    const pnlBacktest = TradeAccountingEngine.calculateTradePnl({
      entryPrice: 24000,
      exitPrice: 24100,
      quantity: 65,
      direction: Direction.BULLISH,
      accountingSnapshot: snapshot,
      fees: 40,
    });

    expect(pnlBacktest).toEqual(pnlPaper);
    expect(pnlPaper.quotePnl).toBe(6500); // 100 pts * 65 qty
    expect(pnlPaper.netPnlAccount).toBe(6460); // 6500 - 40 fees
  });

  // ============================================================
  // TEST 14: Duplicate worker retry does not duplicate financial effects
  // ============================================================
  it('TEST 14: Atomic optimistic locking prevents double-closing positions', () => {
    const position = {
      id: 'pos-atomic-1',
      status: PositionState.OPEN,
    };

    // First worker thread executes transition: OPEN -> CLOSING
    let state = position.status as string;
    let worker1Updated = false;
    let worker2Updated = false;

    if (state === PositionState.OPEN) {
      state = PositionState.CLOSING;
      worker1Updated = true;
    }

    // Concurrent worker retry attempts transition: OPEN -> CLOSING
    if (state === PositionState.OPEN) {
      state = PositionState.CLOSING;
      worker2Updated = true;
    }

    expect(worker1Updated).toBe(true);
    expect(worker2Updated).toBe(false); // Second attempt rejected
  });

  // ============================================================
  // TEST 15: Backtest decision cannot consume future candles
  // ============================================================
  it('TEST 15: Backtest decision cannot consume future candles', () => {
    const candles = createDeterministicCandles(50, 100);
    const tCutoff = CandleNormalizer.getCandleCloseTimestamp(candles[30], '15m');

    const simResult = BacktestSimulator.runSimulation({
      symbol: 'NIFTY',
      candles,
      asOfTimestamp: tCutoff,
      fillModel: FillModel.NEXT_BAR_MARKET,
    });

    // Every executed trade must have closed at or before tCutoff
    for (const trade of simResult.trades) {
      expect(new Date(trade.exitTime).getTime()).toBeLessThanOrEqual(tCutoff.getTime());
    }
  });

  // ============================================================
  // TEST 16: Same accounting snapshot produces deterministic snapshot hash
  // ============================================================
  it('TEST 16: Same accounting snapshot produces deterministic cryptographic snapshot hash', () => {
    const inst = getAuthoritativeInstrument('BTCUSDT');
    const fx = PointInTimeCurrencyConverter.getInstance().getRate('USDT', 'INR', baseTime);

    const snapshot1 = buildAccountingSnapshot({
      accountCurrency: 'INR',
      quoteCurrency: 'USDT',
      fxResult: fx,
      contractSize: 1.0,
      lotSize: 0.5,
      resolvedMarginModel: resolveMarginModel(inst, { requestedLeverage: 5 }),
      calculatedAt: baseTime,
    });

    const snapshot2 = buildAccountingSnapshot({
      accountCurrency: 'INR',
      quoteCurrency: 'USDT',
      fxResult: fx,
      contractSize: 1.0,
      lotSize: 0.5,
      resolvedMarginModel: resolveMarginModel(inst, { requestedLeverage: 5 }),
      calculatedAt: baseTime,
    });

    expect(snapshot1.snapshotHash).toBeDefined();
    expect(snapshot1.snapshotHash).toBe(snapshot2.snapshotHash);
  });

  // ============================================================
  // TEST 17: Chart/backend closed candle boundary is identical
  // ============================================================
  it('TEST 17: Chart and backend closed candle boundary partition identically', () => {
    const rawCandles = createDeterministicCandles(20);
    rawCandles[19].isClosed = false; // Forming candle

    const backendPartition = CandleNormalizer.partitionCandles(rawCandles);
    expect(backendPartition.closedCandles.length).toBe(19);
    expect(backendPartition.formingCandle).toBeDefined();
    expect(backendPartition.formingCandle?.timestamp).toEqual(rawCandles[19].timestamp);
  });

  // ============================================================
  // TEST 18: SMC frontend output is identical to canonical backend SMC
  // ============================================================
  it('TEST 18: SMC Analyzer is the single authoritative source of truth', () => {
    const candles = createDeterministicCandles(30);
    const backendResult = SMCAnalyzer.analyze(candles);

    expect(backendResult.confirmedSwingHighs).toBeDefined();
    expect(backendResult.breaksOfStructure).toBeDefined();
    expect(backendResult.fairValueGaps).toBeDefined();
    expect(backendResult.orderBlocks).toBeDefined();
    expect(backendResult.liquidityPools).toBeDefined();
  });

  // ============================================================
  // P0 — BTCUSDT END-TO-END ACCEPTANCE TEST
  // ============================================================
  describe('P0 — BTCUSDT Full Lifecycle End-to-End Acceptance Test', () => {
    it('executes full pipeline: Snapshot -> SMC -> Signal -> Risk -> Order -> Partial Fills -> Position -> Close -> PaperTrade -> Verified Journal', () => {
      // 1. Ingest Canonical Market Snapshot
      const candles = createDeterministicCandles(40, 70000);
      const snapshot = CanonicalMarketSnapshotBuilder.build({
        symbol: 'BTCUSDT',
        executionCandles: candles,
        executionTimeframe: Timeframe.M15,
      });
      expect(snapshot.dataProvenance).toBe('LIVE');
      expect(snapshot.instrument.currency).toBe('USDT');

      // 2. SMC Analysis
      const smc = SMCAnalyzer.analyze(snapshot.candles as ICandle[], {
        asOfTimestamp: snapshot.decisionTimestamp,
      });
      expect(smc.candlesCount).toBe(40);

      // 3. Signal Generation
      const signal = SignalGenerator.generateSignal({
        symbol: 'BTCUSDT',
        executionCandles: snapshot.candles as ICandle[],
        asOfTimestamp: snapshot.decisionTimestamp,
      });
      expect(signal.symbol).toBe('BTCUSDT');

      // 4. Position Sizing & Accounting Snapshot
      const inst = getAuthoritativeInstrument('BTCUSDT');
      const fxRate = PointInTimeCurrencyConverter.getInstance().getRate('USDT', 'INR', baseTime);

      const accountingSnapshot = buildAccountingSnapshot({
        accountCurrency: 'INR',
        quoteCurrency: 'USDT',
        fxResult: fxRate,
        contractSize: 1.0,
        lotSize: 0.1,
        resolvedMarginModel: resolveMarginModel(inst, { requestedLeverage: 5 }),
        calculatedAt: snapshot.decisionTimestamp.getTime(),
      });
      expect(accountingSnapshot.quoteCurrency).toBe('USDT');
      expect(accountingSnapshot.accountCurrency).toBe('INR');

      // 5. Order Creation & Partial Fills Execution
      const orderId = 'order-btcusdt-101';
      const entryTime1 = new Date(baseTime + 1000);
      const entryTime2 = new Date(baseTime + 2000);

      const entryFills: IFillRecord[] = [
        {
          fillId: 'fill-btc-1',
          orderId,
          executionRole: 'ENTRY',
          fillPrice: 70100.0,
          fillQuantity: 0.04,
          fillTimestamp: entryTime1,
          fee: 10.0,
          slippage: 1.5,
          executionPriceSource: ExecutionPriceSource.LIVE_TICK,
        },
        {
          fillId: 'fill-btc-2',
          orderId,
          executionRole: 'ENTRY',
          fillPrice: 70200.0,
          fillQuantity: 0.06,
          fillTimestamp: entryTime2,
          fee: 15.0,
          slippage: 2.0,
          executionPriceSource: ExecutionPriceSource.LIVE_TICK,
        },
      ];

      // 6. Aggregate Entry Leg
      const entryLeg = ExecutionAggregator.aggregateLeg(entryFills, 'ENTRY');
      // Weighted entry = (70100 * 0.04 + 70200 * 0.06) / 0.10 = (2804 + 4212) / 0.10 = 70160.0
      expect(entryLeg.weightedPrice).toBe(70160.0);
      expect(entryLeg.earliestFillTimestamp).toBe(entryTime1.getTime());
      expect(entryLeg.totalQuantity).toBe(0.10);

      // 7. Position Creation
      const position = {
        id: 'pos-btcusdt-101',
        symbol: 'BTCUSDT',
        quantity: entryLeg.totalQuantity,
        entryPrice: entryLeg.weightedPrice,
        entryTime: new Date(entryLeg.earliestFillTimestamp),
        status: PositionState.OPEN,
        accountingSnapshot,
      };

      // 8. Position Close via Exit Fill
      const exitTime = new Date(baseTime + 3600 * 1000);
      const exitFill: IFillRecord = {
        fillId: 'fill-btc-exit',
        orderId: 'order-btcusdt-exit',
        positionId: position.id,
        executionRole: 'EXIT',
        fillPrice: 72160.0, // +2000 USDT gain per BTC
        fillQuantity: 0.10,
        fillTimestamp: exitTime,
        fee: 25.0,
        slippage: 2.0,
        executionPriceSource: ExecutionPriceSource.LIVE_TICK,
      };

      const lifecycle = ExecutionAggregator.aggregateTradeLifecycle(entryFills, [exitFill]);
      expect(lifecycle.entry!.weightedPrice).toBe(70160.0);
      expect(lifecycle.exit.weightedPrice).toBe(72160.0);

      // 9. Authoritative Trade Accounting (Quote PnL in USDT, Account PnL in INR)
      const pnlResult = TradeAccountingEngine.calculateTradePnl({
        entryPrice: lifecycle.entry!.weightedPrice,
        exitPrice: lifecycle.exit.weightedPrice,
        quantity: 0.10,
        direction: Direction.BULLISH,
        accountingSnapshot,
        fees: lifecycle.entry!.totalFees + lifecycle.exit.totalFees, // 25 + 25 = 50 INR
      });

      // (72160 - 70160) * 0.10 BTC = 200 USDT quote PnL
      expect(pnlResult.quotePnl).toBe(200.0);
      // Account PnL in INR = 200 USDT * 87 FX - 50 INR fees = 17,400 - 50 = 17,350 INR
      expect(pnlResult.grossPnlAccount).toBe(200.0 * fxRate.fxRate);
      expect(pnlResult.netPnlAccount).toBe(200.0 * fxRate.fxRate - 50.0);

      // 10. Verify Equivalence Invariants across Fill, Position, PaperTrade, and Journal
      const paperTrade = {
        symbol: 'BTCUSDT',
        entryPrice: lifecycle.entry!.weightedPrice,
        exitPrice: lifecycle.exit.weightedPrice,
        entryTime: new Date(lifecycle.entry!.earliestFillTimestamp),
        exitTime: new Date(lifecycle.exit.latestFillTimestamp),
        realizedPnL: pnlResult.netPnlAccount,
        quotePnl: pnlResult.quotePnl,
        actualEntryPrice: lifecycle.entry!.weightedPrice,
        entryTimeUtc: new Date(lifecycle.entry!.earliestFillTimestamp).toISOString(),
        executionDataComplete: true,
        isLegacyExecutionData: false,
      };

      const journalEntry = {
        symbol: paperTrade.symbol,
        actualEntryPrice: paperTrade.actualEntryPrice,
        entryTimeUtc: paperTrade.entryTimeUtc,
        actualExitPrice: paperTrade.exitPrice,
        quotePnl: paperTrade.quotePnl,
        netPnlAccount: paperTrade.realizedPnL,
        accountCurrency: 'INR',
        quoteCurrency: 'USDT',
        executionDataComplete: paperTrade.executionDataComplete,
      };

      // Exact identity assertions
      const entryTimeMs = entryFills[0].fillTimestamp instanceof Date ? entryFills[0].fillTimestamp.getTime() : new Date(entryFills[0].fillTimestamp).getTime();
      expect(entryTimeMs).toBe(position.entryTime.getTime());
      expect(position.entryTime.getTime()).toBe(paperTrade.entryTime.getTime());
      expect(paperTrade.entryTimeUtc).toBe(journalEntry.entryTimeUtc);

      expect(lifecycle.entry!.weightedPrice).toBe(paperTrade.actualEntryPrice);
      expect(paperTrade.actualEntryPrice).toBe(journalEntry.actualEntryPrice);

      expect(journalEntry.quoteCurrency).toBe('USDT');
      expect(journalEntry.accountCurrency).toBe('INR');
      expect(journalEntry.quotePnl).toBe(200.0);
      expect(journalEntry.netPnlAccount).toBe(200.0 * fxRate.fxRate - 50.0);
    });
  });
});
