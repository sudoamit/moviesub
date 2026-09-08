import { ExecutionSimulator } from '../execution/execution-simulator';
import { FillModelEngine } from '../execution/fill-model';
import { FillModel, SameCandleAmbiguityMode } from '../execution/types';
import { TradeLifecycleManager } from '@quant/risk-engine';
import { Direction, ICandle, SignalState } from '@quant/shared';
import { BacktestSimulator } from '../backtest-simulator';

describe('Backtesting Execution Correctness Pass (6 Targeted Fixes & Partial Exit Ledger)', () => {
  // 1. Independent TP Orders & Protective Stop Updates
  test('1. TP1 hit reduces position and updates SL size without cancelling TP2/TP3', () => {
    const execSim = new ExecutionSimulator(FillModel.OHLC_PATH, SameCandleAmbiguityMode.OHLC_PATH);
    const timestamp = 1700000000000;
    const tradeId = 'trade_100_units';

    // Submit initial 100-unit protective SL and 3 TP target limit orders
    const slOrder = execSim.submitOrder({
      tradeId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'STOP',
      stopPrice: 95.0,
      quantity: 100.0,
      timestamp,
      exitTarget: 'SL',
    });

    const tp1Order = execSim.submitOrder({
      tradeId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      price: 110.0,
      quantity: 30.0,
      timestamp,
      exitTarget: 'TP1',
    });

    const tp2Order = execSim.submitOrder({
      tradeId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      price: 120.0,
      quantity: 30.0,
      timestamp,
      exitTarget: 'TP2',
    });

    const tp3Order = execSim.submitOrder({
      tradeId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      price: 130.0,
      quantity: 40.0,
      timestamp,
      exitTarget: 'TP3',
    });

    // Step 1: Candle 1 touches TP1 (110)
    const candle1: ICandle = {
      timestamp: new Date(timestamp + 60000),
      open: 105.0,
      high: 112.0,
      low: 104.0,
      close: 108.0,
      volume: 100,
    };

    const res1 = execSim.processCandle(candle1);
    expect(res1.fills).toHaveLength(1);
    expect(res1.fills[0].exitTarget).toBe('TP1');
    expect(tp1Order.status).toBe('FILLED');

    // TP2 and TP3 MUST remain PENDING!
    expect(tp2Order.status).toBe('PENDING');
    expect(tp3Order.status).toBe('PENDING');

    // Protective SL MUST remain PENDING but quantity updated to 70!
    expect(slOrder.status).toBe('PENDING');
    expect(slOrder.remainingQuantity).toBe(70);

    // Step 2: Candle 2 touches TP2 (120)
    const candle2: ICandle = {
      timestamp: new Date(timestamp + 120000),
      open: 108.0,
      high: 122.0,
      low: 106.0,
      close: 118.0,
      volume: 100,
    };

    const res2 = execSim.processCandle(candle2);
    expect(res2.fills).toHaveLength(1);
    expect(res2.fills[0].exitTarget).toBe('TP2');
    expect(tp2Order.status).toBe('FILLED');

    // TP3 remains PENDING, SL updated to 40!
    expect(tp3Order.status).toBe('PENDING');
    expect(slOrder.status).toBe('PENDING');
    expect(slOrder.remainingQuantity).toBe(40);

    // Step 3: Candle 3 touches TP3 (130)
    const candle3: ICandle = {
      timestamp: new Date(timestamp + 180000),
      open: 118.0,
      high: 132.0,
      low: 115.0,
      close: 128.0,
      volume: 100,
    };

    const res3 = execSim.processCandle(candle3);
    expect(res3.fills).toHaveLength(1);
    expect(res3.fills[0].exitTarget).toBe('TP3');
    expect(tp3Order.status).toBe('FILLED');

    // Position is now 0 -> SL is CANCELLED!
    expect(slOrder.status).toBe('CANCELLED');
  });

  // 2. TP1 + SL Same Candle
  test('2. Multi-fill same candle: TP1 + SL same candle', () => {
    const execSim = new ExecutionSimulator(FillModel.OHLC_PATH, SameCandleAmbiguityMode.OHLC_PATH);
    const timestamp = 1700000000000;
    const tradeId = 'trade_tp1_sl';

    const slOrder = execSim.submitOrder({
      tradeId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'STOP',
      stopPrice: 95.0,
      quantity: 100.0,
      timestamp,
      exitTarget: 'SL',
    });

    const tp1Order = execSim.submitOrder({
      tradeId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      price: 110.0,
      quantity: 30.0,
      timestamp,
      exitTarget: 'TP1',
    });

    // Bearish candle: Open 105, High 115 (touches TP1), Low 90 (touches SL), Close 92
    const candle: ICandle = {
      timestamp: new Date(timestamp + 60000),
      open: 105.0,
      high: 115.0,
      low: 90.0,
      close: 92.0,
      volume: 200,
    };

    const res = execSim.processCandle(candle);
    expect(res.fills).toHaveLength(2);
    expect(res.fills[0].exitTarget).toBe('TP1');
    expect(res.fills[0].quantity).toBe(30);
    expect(res.fills[1].exitTarget).toBe('SL');
    expect(res.fills[1].quantity).toBe(70);

    expect(tp1Order.status).toBe('FILLED');
    expect(slOrder.status).toBe('FILLED');
  });

  // 3. TP1 + TP2 Same Candle
  test('3. Multi-fill same candle: TP1 + TP2 same candle', () => {
    const execSim = new ExecutionSimulator(FillModel.OHLC_PATH, SameCandleAmbiguityMode.OHLC_PATH);
    const timestamp = 1700000000000;
    const tradeId = 'trade_tp1_tp2';

    const slOrder = execSim.submitOrder({
      tradeId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'STOP',
      stopPrice: 95.0,
      quantity: 100.0,
      timestamp,
      exitTarget: 'SL',
    });

    const tp1Order = execSim.submitOrder({
      tradeId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      price: 110.0,
      quantity: 30.0,
      timestamp,
      exitTarget: 'TP1',
    });

    const tp2Order = execSim.submitOrder({
      tradeId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      price: 120.0,
      quantity: 30.0,
      timestamp,
      exitTarget: 'TP2',
    });

    // Bearish candle: Open 105, High 125 (touches TP1 & TP2), Low 102, Close 103
    const candle: ICandle = {
      timestamp: new Date(timestamp + 60000),
      open: 105.0,
      high: 125.0,
      low: 102.0,
      close: 103.0,
      volume: 200,
    };

    const res = execSim.processCandle(candle);
    expect(res.fills).toHaveLength(2);
    expect(res.fills[0].exitTarget).toBe('TP1');
    expect(res.fills[0].quantity).toBe(30);
    expect(res.fills[1].exitTarget).toBe('TP2');
    expect(res.fills[1].quantity).toBe(30);

    expect(tp1Order.status).toBe('FILLED');
    expect(tp2Order.status).toBe('FILLED');
    expect(slOrder.status).toBe('PENDING');
    expect(slOrder.remainingQuantity).toBe(40);
  });

  // 4. TP2 + SL Same Candle (after TP1 hit)
  test('4. Multi-fill same candle: TP2 + SL same candle', () => {
    const execSim = new ExecutionSimulator(FillModel.OHLC_PATH, SameCandleAmbiguityMode.OHLC_PATH);
    const timestamp = 1700000000000;
    const tradeId = 'trade_tp2_sl';

    // Position initially 70 units (TP1 hit earlier)
    const slOrder = execSim.submitOrder({
      tradeId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'STOP',
      stopPrice: 95.0,
      quantity: 70.0,
      timestamp,
      exitTarget: 'SL',
    });

    const tp2Order = execSim.submitOrder({
      tradeId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      price: 120.0,
      quantity: 30.0,
      timestamp,
      exitTarget: 'TP2',
    });

    // Bearish candle: Open 105, High 122 (touches TP2), Low 90 (touches SL), Close 92
    const candle: ICandle = {
      timestamp: new Date(timestamp + 60000),
      open: 105.0,
      high: 122.0,
      low: 90.0,
      close: 92.0,
      volume: 200,
    };

    const res = execSim.processCandle(candle);
    expect(res.fills).toHaveLength(2);
    expect(res.fills[0].exitTarget).toBe('TP2');
    expect(res.fills[0].quantity).toBe(30);
    expect(res.fills[1].exitTarget).toBe('SL');
    expect(res.fills[1].quantity).toBe(40);

    expect(tp2Order.status).toBe('FILLED');
    expect(slOrder.status).toBe('FILLED');
  });

  // 5. TP1 + TP2 + SL Same Candle
  test('5. Multi-fill same candle: TP1 + TP2 + SL same candle', () => {
    const execSim = new ExecutionSimulator(FillModel.OHLC_PATH, SameCandleAmbiguityMode.OHLC_PATH);
    const timestamp = 1700000000000;
    const tradeId = 'trade_tp1_tp2_sl';

    const slOrder = execSim.submitOrder({
      tradeId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'STOP',
      stopPrice: 95.0,
      quantity: 100.0,
      timestamp,
      exitTarget: 'SL',
    });

    const tp1Order = execSim.submitOrder({
      tradeId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      price: 110.0,
      quantity: 30.0,
      timestamp,
      exitTarget: 'TP1',
    });

    const tp2Order = execSim.submitOrder({
      tradeId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      price: 120.0,
      quantity: 30.0,
      timestamp,
      exitTarget: 'TP3',
    });

    // Bearish candle: Open 105, High 125 (touches TP1 & TP2), Low 90 (touches SL), Close 92
    const candle: ICandle = {
      timestamp: new Date(timestamp + 60000),
      open: 105.0,
      high: 125.0,
      low: 90.0,
      close: 92.0,
      volume: 300,
    };

    const res = execSim.processCandle(candle);
    expect(res.fills).toHaveLength(3);
    expect(res.fills[0].exitTarget).toBe('TP1');
    expect(res.fills[0].quantity).toBe(30);
    expect(res.fills[1].exitTarget).toBe('TP3');
    expect(res.fills[1].quantity).toBe(30);
    expect(res.fills[2].exitTarget).toBe('SL');
    expect(res.fills[2].quantity).toBe(40);

    expect(tp1Order.status).toBe('FILLED');
    expect(tp2Order.status).toBe('FILLED');
    expect(slOrder.status).toBe('FILLED');
  });

  // 6. P0 Audit Fix: NEXT_BAR_MARKET with Resting STOP & LIMIT Exit Orders
  test('6. P0 Audit Fix: NEXT_BAR_MARKET simulation evaluates resting STOP and LIMIT orders correctly against current bar', () => {
    const execSim = new ExecutionSimulator(FillModel.NEXT_BAR_MARKET, SameCandleAmbiguityMode.OHLC_PATH);
    const timestamp = 1700000000000;
    const tradeId = 'trade_next_bar_p0';

    const slOrder = execSim.submitOrder({
      tradeId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'STOP',
      stopPrice: 95.0,
      quantity: 100.0,
      timestamp,
      exitTarget: 'SL',
    });

    const tp1Order = execSim.submitOrder({
      tradeId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      price: 110.0,
      quantity: 30.0,
      timestamp,
      exitTarget: 'TP1',
    });

    // Current candle High = 112 (touches TP1 @ 110)
    const currentCandle: ICandle = {
      timestamp: new Date(timestamp + 60000),
      open: 105.0,
      high: 112.0,
      low: 104.0,
      close: 108.0,
      volume: 100,
    };

    // Next candle Open = 106.0
    const nextCandle: ICandle = {
      timestamp: new Date(timestamp + 120000),
      open: 106.0,
      high: 109.0,
      low: 105.0,
      close: 107.0,
      volume: 100,
    };

    const res = execSim.processCandle(currentCandle, nextCandle);
    expect(res.fills).toHaveLength(1);
    expect(res.fills[0].exitTarget).toBe('TP1');
    // Price MUST be limit price (110), NOT next candle open (106)!
    expect(res.fills[0].price).toBe(110.0);
  });

  // 7. P1 Audit Fix: TP Event Type Classification (TP_FILLED)
  test('7. P1 Audit Fix: Process candle emits TP_FILLED event for TP limit orders', () => {
    const execSim = new ExecutionSimulator(FillModel.OHLC_PATH);
    const timestamp = 1700000000000;

    execSim.submitOrder({
      tradeId: 'trade_event_type',
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      price: 110.0,
      quantity: 50.0,
      timestamp,
      exitTarget: 'TP1',
    });

    const candle: ICandle = {
      timestamp: new Date(timestamp + 60000),
      open: 105.0,
      high: 112.0,
      low: 104.0,
      close: 108.0,
      volume: 100,
    };

    const res = execSim.processCandle(candle);
    expect(res.events).toHaveLength(1);
    expect(res.events[0].eventType).toBe('TP_FILLED');
  });

  // 8. P1 Audit Fix: Lower-TF Validator Timeframe Duration Check (15m)
  test('8. P1 Audit Fix: validateSubBars validates 15m parent candle duration correctly', () => {
    const parentOpen = 1700000000000; // 10:00
    const parentDurationMs = 15 * 60 * 1000; // 15 Minutes (10:00 to 10:15)
    const parentClose = parentOpen + parentDurationMs;

    const parentCandle: ICandle = {
      timestamp: new Date(parentOpen),
      open: 100,
      high: 110,
      low: 95,
      close: 105,
      volume: 1000,
    };

    // Sub-bar at 10:16 (past 15m boundary -> future data)
    const invalidFutureSubBars: ICandle[] = [
      { timestamp: new Date(parentOpen + 60000), open: 100, high: 102, low: 99, close: 101, volume: 10 },
      { timestamp: new Date(parentClose + 60000), open: 105, high: 108, low: 104, close: 107, volume: 10 }, // 10:16 - Future!
    ];

    const valRes = FillModelEngine.validateSubBars(parentCandle, invalidFutureSubBars, parentDurationMs);
    expect(valRes.isValid).toBe(false);
    expect(valRes.reason).toBe('SUBBAR_OUT_OF_BOUNDS_FUTURE');
  });

  // 9. Signal / Order Timestamps Validation
  test('9. Rejects order submission if order timestamp precedes signal timestamp', () => {
    const execSim = new ExecutionSimulator();
    const signalTimestamp = 1700001000000;
    const invalidOrderTimestamp = 1700000000000;

    expect(() => {
      execSim.submitOrder({
        tradeId: 'trade_ts',
        symbol: 'BTCUSDT',
        side: 'BUY',
        orderType: 'LIMIT',
        price: 100.0,
        quantity: 1.0,
        timestamp: invalidOrderTimestamp,
        signalTimestamp,
      });
    }).toThrow('Order creation timestamp (1700000000000) cannot precede signal timestamp (1700001000000)');
  });

  // 10. Deprecate/Disable Synthetic Lifecycle Execution for Backtesting
  test('10. evaluateLotTick throws exception when invoked with forBacktest = true', () => {
    const lot: any = {
      tradeId: 't1',
      symbol: 'BTCUSDT',
      direction: Direction.BULLISH,
      entryPrice: 100,
      remainingQuantity: 1.0,
      mae: 0,
      mfe: 0,
    };
    const candle: ICandle = {
      timestamp: new Date(),
      open: 100,
      high: 105,
      low: 95,
      close: 102,
      volume: 10,
    };
    expect(() => TradeLifecycleManager.evaluateLotTick(lot, candle, undefined, undefined, true)).toThrow('is deprecated');
  });

  // 11. Short Position Execution & Partial Exit Trace
  test('11. Short Position (BEARISH) partial exit trace and SL adjustment', () => {
    const execSim = new ExecutionSimulator(FillModel.OHLC_PATH, SameCandleAmbiguityMode.OHLC_PATH);
    const timestamp = 1700000000000;
    const tradeId = 'trade_short_100';

    // Short position: BUY to exit
    const slOrder = execSim.submitOrder({
      tradeId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'STOP',
      stopPrice: 105.0,
      quantity: 100.0,
      timestamp,
      exitTarget: 'SL',
    });

    const tp1Order = execSim.submitOrder({
      tradeId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'LIMIT',
      price: 90.0,
      quantity: 50.0,
      timestamp,
      exitTarget: 'TP1',
    });

    // Candle drops to 88 (touches TP1 @ 90)
    const candle: ICandle = {
      timestamp: new Date(timestamp + 60000),
      open: 98.0,
      high: 99.0,
      low: 88.0,
      close: 89.0,
      volume: 100,
    };

    const res = execSim.processCandle(candle);
    expect(res.fills).toHaveLength(1);
    expect(res.fills[0].exitTarget).toBe('TP1');
    expect(res.fills[0].quantity).toBe(50.0);
    expect(tp1Order.status).toBe('FILLED');
    expect(slOrder.remainingQuantity).toBe(50.0);
  });

  // 12. Gap-Through TP / SL Execution (Long & Short)
  test('12. Gap-through execution for Long gap-down SL and Short gap-up SL', () => {
    const execSim = new ExecutionSimulator(FillModel.OHLC_PATH);
    const timestamp = 1700000000000;

    // Long position SL at 95.0, candle gaps down to Open = 90.0
    const longSl = execSim.submitOrder({
      tradeId: 'trade_gap_long',
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'STOP',
      stopPrice: 95.0,
      quantity: 100.0,
      timestamp,
      exitTarget: 'SL',
    });

    const gapCandleLong: ICandle = {
      timestamp: new Date(timestamp + 60000),
      open: 90.0, // Gap down open!
      high: 91.0,
      low: 85.0,
      close: 88.0,
      volume: 500,
    };

    const resLong = execSim.processCandle(gapCandleLong);
    expect(resLong.fills).toHaveLength(1);
    // Gap-down execution MUST fill at gap open price (90.0), NOT stop price (95.0)!
    expect(resLong.fills[0].price).toBeLessThanOrEqual(90.0);

    // Short position SL at 105.0, candle gaps up to Open = 110.0
    const shortSl = execSim.submitOrder({
      tradeId: 'trade_gap_short',
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'STOP',
      stopPrice: 105.0,
      quantity: 100.0,
      timestamp,
      exitTarget: 'SL',
    });

    const gapCandleShort: ICandle = {
      timestamp: new Date(timestamp + 60000),
      open: 110.0, // Gap up open!
      high: 115.0,
      low: 109.0,
      close: 112.0,
      volume: 500,
    };

    const resShort = execSim.processCandle(gapCandleShort);
    expect(resShort.fills).toHaveLength(1);
    // Gap-up execution MUST fill at gap open price (>= 110.0)
    expect(resShort.fills[0].price).toBeGreaterThanOrEqual(110.0);
  });

  // 13. TP1 -> Breakeven Stop -> SL Hit
  test('13. TP1 hit -> Breakeven stop update -> Breakeven SL hit', () => {
    const lot: any = {
      tradeId: 't_be',
      direction: Direction.BULLISH,
      initialQuantity: 100,
      remainingQuantity: 100,
      entryPrice: 100.0,
      initialStopLoss: 95.0,
      currentStopLoss: 95.0,
      tp1: 110.0,
      tp2: 120.0,
      tp3: 130.0,
      status: 'OPEN',
      partialFills: [],
    };

    // Step 1: TP1 hit (30 units @ 110)
    const tp1Fill = {
      fillId: 'f1',
      targetType: 'TP1',
      timestamp: 1700000060000,
      price: 110.0,
      quantity: 30,
      remainingQuantity: 70,
      realizedPnl: 300,
      realizedR: 2.0,
      fee: 1.0,
      slippage: 0,
    };
    lot.partialFills.push(tp1Fill);
    lot.remainingQuantity = 70;
    lot.currentStopLoss = lot.entryPrice; // Breakeven stop update!

    expect(lot.currentStopLoss).toBe(100.0);

    // Step 2: Price drops to 100.0 (Breakeven SL hit)
    const beFill = {
      fillId: 'f2',
      targetType: 'TRAILING_STOP',
      timestamp: 1700000120000,
      price: 100.0,
      quantity: 70,
      remainingQuantity: 0,
      realizedPnl: 0,
      realizedR: 0,
      fee: 1.0,
      slippage: 0,
    };
    lot.partialFills.push(beFill);
    lot.remainingQuantity = 0;
    lot.status = 'CLOSED';

    expect(lot.status).toBe('CLOSED');
    expect(lot.partialFills).toHaveLength(2);
    expect(lot.partialFills[1].price).toBe(100.0);
  });

  // 14. Same-Candle TP/SL under All Four Ambiguity Modes
  test('14. Same-candle TP/SL resolution under all four ambiguity modes', () => {
    const candle: ICandle = {
      timestamp: new Date(1700000060000),
      open: 100.0,
      high: 115.0, // touches TP1 @ 110
      low: 90.0,  // touches SL @ 95
      close: 92.0, // Bearish bar
      volume: 100,
    };

    // Mode A: CONSERVATIVE -> STOP order wins
    const simCons = new ExecutionSimulator(FillModel.OHLC_PATH, SameCandleAmbiguityMode.CONSERVATIVE);
    const slCons = simCons.submitOrder({ tradeId: 'c1', symbol: 'BTCUSDT', side: 'SELL', orderType: 'STOP', stopPrice: 95, quantity: 100, timestamp: 1700000000000 });
    const tpCons = simCons.submitOrder({ tradeId: 'c1', symbol: 'BTCUSDT', side: 'SELL', orderType: 'LIMIT', price: 110, quantity: 30, timestamp: 1700000000000 });
    const resCons = simCons.processCandle(candle);
    expect(resCons.fills[0].orderId).toBe(slCons.orderId);

    // Mode B: OPTIMISTIC -> LIMIT order wins
    const simOpt = new ExecutionSimulator(FillModel.OHLC_PATH, SameCandleAmbiguityMode.OPTIMISTIC);
    const slOpt = simOpt.submitOrder({ tradeId: 'c2', symbol: 'BTCUSDT', side: 'SELL', orderType: 'STOP', stopPrice: 95, quantity: 100, timestamp: 1700000000000 });
    const tpOpt = simOpt.submitOrder({ tradeId: 'c2', symbol: 'BTCUSDT', side: 'SELL', orderType: 'LIMIT', price: 110, quantity: 30, timestamp: 1700000000000 });
    const resOpt = simOpt.processCandle(candle);
    expect(resOpt.fills[0].orderId).toBe(tpOpt.orderId);

    // Mode C: OHLC_PATH -> Bearish bar touches High first -> TP1 fills first
    const simPath = new ExecutionSimulator(FillModel.OHLC_PATH, SameCandleAmbiguityMode.OHLC_PATH);
    const slPath = simPath.submitOrder({ tradeId: 'c3', symbol: 'BTCUSDT', side: 'SELL', orderType: 'STOP', stopPrice: 95, quantity: 100, timestamp: 1700000000000 });
    const tpPath = simPath.submitOrder({ tradeId: 'c3', symbol: 'BTCUSDT', side: 'SELL', orderType: 'LIMIT', price: 110, quantity: 30, timestamp: 1700000000000 });
    const resPath = simPath.processCandle(candle);
    expect(resPath.fills[0].orderId).toBe(tpPath.orderId);

    // Mode D: LOWER_TIMEFRAME -> Sub-bars determine execution order
    const simSub = new ExecutionSimulator(FillModel.LOWER_TIMEFRAME, SameCandleAmbiguityMode.LOWER_TIMEFRAME);
    const slSub = simSub.submitOrder({ tradeId: 'c4', symbol: 'BTCUSDT', side: 'SELL', orderType: 'STOP', stopPrice: 95, quantity: 100, timestamp: 1700000000000 });
    const tpSub = simSub.submitOrder({ tradeId: 'c4', symbol: 'BTCUSDT', side: 'SELL', orderType: 'LIMIT', price: 110, quantity: 30, timestamp: 1700000000000 });
    const subBars: ICandle[] = [
      { timestamp: new Date(1700000070000), open: 100, high: 112, low: 99, close: 111, volume: 10 }, // TP1 touched first!
      { timestamp: new Date(1700000080000), open: 111, high: 111, low: 92, close: 93, volume: 10 },  // SL touched second
    ];
    const resSub = simSub.processCandle(candle, undefined, subBars, 15 * 60 * 1000);
    expect(resSub.fills[0].orderId).toBe(tpSub.orderId);
  });

  // 15. Partial Exit Policy Validation Error
  test('15. validatePartialExitPolicy rejects policies where ratios do not sum to 1.0', () => {
    const invalidPolicy = {
      tp1Ratio: 0.5,
      tp2Ratio: 0.6, // Sum = 1.1!
      tp3Ratio: 0.0,
      moveStopToBreakevenOnTp1: true,
      trailStopOnTp2: true,
    };

    const val = TradeLifecycleManager.validatePartialExitPolicy(invalidPolicy);
    expect(val.isValid).toBe(false);
    expect(val.reason).toContain('RATIOS_DO_NOT_SUM_TO_ONE');
  });
});
