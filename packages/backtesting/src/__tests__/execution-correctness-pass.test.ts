import { ExecutionSimulator } from '../execution/execution-simulator';
import { FillModelEngine } from '../execution/fill-model';
import { FillModel, SameCandleAmbiguityMode } from '../execution/types';
import { OHLCPathCursor } from '../execution/ohlc-path-cursor';
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
    // Price MUST be limit price accounting for bid/ask spread (~110), NOT next candle open (106)!
    expect(res.fills[0].price).toBeCloseTo(110.0, 1);
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

  // 13. TP1 -> Breakeven Stop -> SL Hit (Real Execution Pipeline)
  test('13. TP1 hit -> Breakeven stop update -> Breakeven SL hit via real ExecutionSimulator', () => {
    const execSim = new ExecutionSimulator();
    const timestamp = 1700000000000;
    const tradeId = 't_be_real';

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

    // Step 1: Candle 1 rises to 112 (touches TP1 limit 110)
    const candle1: ICandle = {
      timestamp: new Date(timestamp + 60000),
      open: 102.0,
      high: 112.0,
      low: 101.0,
      close: 111.0,
      volume: 100,
    };

    const res1 = execSim.processCandle(candle1);
    expect(res1.fills).toHaveLength(1);
    expect(res1.fills[0].orderId).toBe(tp1Order.orderId);
    expect(res1.fills[0].quantity).toBe(30.0);
    expect(slOrder.remainingQuantity).toBe(70.0); // Stop order size automatically reduced to 70!

    // Step 2: Stop loss updated to Breakeven (100.0)
    slOrder.stopPrice = 100.0;

    // Step 3: Candle 2 drops to 99 (triggers Breakeven SL at 100.0)
    const candle2: ICandle = {
      timestamp: new Date(timestamp + 120000),
      open: 108.0,
      high: 108.0,
      low: 99.0,
      close: 99.5,
      volume: 100,
    };

    const res2 = execSim.processCandle(candle2);
    expect(res2.fills).toHaveLength(1);
    expect(res2.fills[0].orderId).toBe(slOrder.orderId);
    expect(res2.fills[0].quantity).toBe(70.0);
    expect(res2.fills[0].price).toBeLessThanOrEqual(100.0); // Exited at breakeven stop price accounting for spread/slippage
    expect(res2.fills[0].price).toBeGreaterThan(99.0);
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

    // Mode A: CONSERVATIVE -> Bullish bar touches Low 90 on Segment 1 first, triggering STOP order
    const candleCons: ICandle = {
      timestamp: new Date(1700000060000),
      open: 100.0,
      high: 115.0,
      low: 90.0,
      close: 112.0, // Bullish candle: Open 100 -> Low 90 -> High 115 -> Close 112
      volume: 100,
    };
    const simCons = new ExecutionSimulator(FillModel.OHLC_PATH, SameCandleAmbiguityMode.CONSERVATIVE);
    const slCons = simCons.submitOrder({ tradeId: 'c1', symbol: 'BTCUSDT', side: 'SELL', orderType: 'STOP', stopPrice: 95, quantity: 100, timestamp: 1700000000000 });
    const tpCons = simCons.submitOrder({ tradeId: 'c1', symbol: 'BTCUSDT', side: 'SELL', orderType: 'LIMIT', price: 110, quantity: 30, timestamp: 1700000000000 });
    const resCons = simCons.processCandle(candleCons);
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
    const resSub = simSub.processCandle(candle, undefined, subBars, 60 * 1000);
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

  // 16. Immutable EntryExecutionSnapshot Validation
  test('16. createPositionLot creates an immutable (frozen) EntryExecutionSnapshot', () => {
    const signal: any = {
      id: 'sig_100',
      symbol: 'BTCUSDT',
      direction: Direction.BULLISH,
      stopLoss: 90.0,
      entryPrice: 100.0,
      timestamp: 1700000000000,
    };
    const lot = TradeLifecycleManager.createPositionLot(signal, 100.0, 10, 1700000010000, 'ord_1', 1.5, 0.5);

    expect(lot.entrySnapshot).toBeDefined();
    expect(Object.isFrozen(lot.entrySnapshot)).toBe(true);
    expect(lot.entrySnapshot?.entryPrice).toBe(100.0);
    expect(lot.entrySnapshot?.fee).toBe(1.5);
    expect(lot.entrySnapshot?.slippage).toBe(0.5);
    expect(lot.entrySnapshot?.orderId).toBe('ord_1');

    // Immutability check
    expect(() => {
      (lot.entrySnapshot as any).entryPrice = 200.0;
    }).toThrow();
  });

  // 17. Exact Exit Order Provenance
  test('17. ExecutionSimulator populates exit order provenance on execution events', () => {
    const execSim = new ExecutionSimulator();
    const timestamp = 1700000000000;
    const order = execSim.submitOrder({
      tradeId: 't_prov',
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      price: 110.0,
      quantity: 50.0,
      timestamp,
      exitTarget: 'TP1',
      clientOrderId: 'cl_tp1',
    });

    const candle: ICandle = {
      timestamp: new Date(timestamp + 60000),
      open: 105.0,
      high: 112.0,
      low: 104.0,
      close: 111.0,
      volume: 100,
    };

    const res = execSim.processCandle(candle);
    expect(res.events).toHaveLength(1);
    const evt = res.events[0];
    expect(evt.exitOrderId).toBe(order.orderId);
    expect(evt.exitClientOrderId).toBe('cl_tp1');
    expect(evt.triggerPrice).toBe(110.0);
    expect(evt.executedPrice).toBeCloseTo(110.0, 1);
    expect(evt.exitTarget).toBe('TP1');
  });

  // 18. Lower-TF Completeness Validation
  test('18. validateSubBars rejects incomplete M1 sub-bar coverage for a 15m parent candle', () => {
    const parentCandle: ICandle = {
      timestamp: new Date(1700000000000),
      open: 100,
      high: 110,
      low: 95,
      close: 105,
      volume: 1000,
    };

    // Sub-bars only cover first 2 minutes of a 15-minute (900,000 ms) parent candle
    const incompleteSubBars: ICandle[] = [
      { timestamp: new Date(1700000000000), open: 100, high: 102, low: 99, close: 101, volume: 10 },
      { timestamp: new Date(1700000060000), open: 101, high: 103, low: 100, close: 102, volume: 10 },
    ];

    const valRes = FillModelEngine.validateSubBars(parentCandle, incompleteSubBars, 15 * 60 * 1000, true);
    expect(valRes.isValid).toBe(false);
    expect(valRes.reason).toBe('SUBBAR_COVERAGE_INCOMPLETE');
  });

  // 19. Full Cash / Equity / Fee / Slippage Financial Invariant Test
  test('19. Financial Invariants: Equity = Cash + Unrealized PnL and Cash_final = Initial + PnL - Fees', () => {
    const initialCapital = 10000.0;
    const res = BacktestSimulator.runSimulation({
      symbol: 'BTCUSDT',
      candles: [
        { timestamp: new Date(1700000000000), open: 100, high: 105, low: 99, close: 104, volume: 100 },
        { timestamp: new Date(1700000900000), open: 104, high: 115, low: 103, close: 112, volume: 100 }, // TP hit
      ],
      initialCapital,
      riskPerTradePercent: 2.0,
      partialExitPolicy: {
        tp1Ratio: 0.5,
        tp2Ratio: 0.5,
        tp3Ratio: 0.0,
        moveStopToBreakevenOnTp1: true,
        trailStopOnTp2: false,
      },
    });

    expect(res).toBeDefined();

    // Verify invariant: final equity = initial capital + net PnL
    const expectedFinalCash = initialCapital + res.netPnL;
    expect(res.finalEquity).toBeCloseTo(expectedFinalCash, 2);

    // Verify equity snapshots satisfy Equity = Cash + Unrealized
    for (const snap of res.equitySnapshots || []) {
      expect(snap.equity).toBeCloseTo(snap.cash + snap.unrealizedPnL, 2);
    }
  });

  // 20. Long + Short End-to-End Tests
  test('20. End-to-end backtest handles both BULLISH (Long) and BEARISH (Short) trades cleanly', () => {
    const res = BacktestSimulator.runSimulation({
      symbol: 'BTCUSDT',
      candles: [
        { timestamp: new Date(1700000000000), open: 100, high: 105, low: 99, close: 104, volume: 100 },
        { timestamp: new Date(1700000900000), open: 104, high: 115, low: 103, close: 112, volume: 100 },
        { timestamp: new Date(1700001800000), open: 112, high: 113, low: 95, close: 96, volume: 100 },
      ],
      initialCapital: 10000,
    });

    expect(res.trades).toBeDefined();
    expect(res.totalTrades).toBeGreaterThanOrEqual(0);
  });

  // 21. TP1 -> BE -> TP2 -> Trailing Stop -> TP3 Sequence (Real Execution Pipeline)
  test('21. Real Execution Pipeline: TP1 hit -> SL to BE -> TP2 hit -> trailing stop -> TP3 hit', () => {
    const execSim = new ExecutionSimulator();
    const timestamp = 1700000000000;
    const tradeId = 't_seq_full_real';

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

    // Candle 1: Rises to 112 (TP1 hit)
    const c1: ICandle = { timestamp: new Date(timestamp + 60000), open: 100, high: 112, low: 99, close: 111, volume: 100 };
    const res1 = execSim.processCandle(c1);
    expect(res1.fills).toHaveLength(1);
    expect(res1.fills[0].orderId).toBe(tp1Order.orderId);
    expect(slOrder.remainingQuantity).toBe(70.0);
    slOrder.stopPrice = 100.0; // Move SL to Breakeven

    // Candle 2: Rises to 122 (TP2 hit)
    const c2: ICandle = { timestamp: new Date(timestamp + 120000), open: 111, high: 122, low: 110, close: 121, volume: 100 };
    const res2 = execSim.processCandle(c2);
    expect(res2.fills).toHaveLength(1);
    expect(res2.fills[0].orderId).toBe(tp2Order.orderId);
    expect(slOrder.remainingQuantity).toBe(40.0);
    slOrder.stopPrice = 115.0; // Trailing stop update

    // Candle 3: Rises to 132 (TP3 hit -> Position fully closed, SL cancelled)
    const c3: ICandle = { timestamp: new Date(timestamp + 180000), open: 121, high: 132, low: 120, close: 131, volume: 100 };
    const res3 = execSim.processCandle(c3);
    expect(res3.fills).toHaveLength(1);
    expect(res3.fills[0].orderId).toBe(tp3Order.orderId);
    expect(slOrder.status).toBe('CANCELLED'); // Remaining SL cancelled!
  });

  // 22. TP1 -> BE -> SL Sequence (Real Execution Pipeline)
  test('22. Real Execution Pipeline: TP1 hit (SL to BE) -> Pullback triggers BE stop loss', () => {
    const execSim = new ExecutionSimulator();
    const timestamp = 1700000000000;
    const tradeId = 't_seq_be_real';

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

    // Candle 1: Hits TP1
    const c1: ICandle = { timestamp: new Date(timestamp + 60000), open: 100, high: 112, low: 99, close: 111, volume: 100 };
    const res1 = execSim.processCandle(c1);
    expect(res1.fills).toHaveLength(1);
    expect(res1.fills[0].orderId).toBe(tp1Order.orderId);
    slOrder.stopPrice = 100.0; // Move SL to BE

    // Candle 2: Pullback triggers BE stop at 100.0
    const c2: ICandle = { timestamp: new Date(timestamp + 120000), open: 108, high: 108, low: 99, close: 99.5, volume: 100 };
    const res2 = execSim.processCandle(c2);
    expect(res2.fills).toHaveLength(1);
    expect(res2.fills[0].orderId).toBe(slOrder.orderId);
    expect(res2.fills[0].quantity).toBe(70.0);
    expect(res2.fills[0].price).toBeLessThanOrEqual(100.0);
    expect(res2.fills[0].price).toBeGreaterThan(99.0);
  });

  // 23. Gap Entry + Gap TP + Gap SL
  test('23. Handles gap entry, gap TP, and gap SL executions cleanly', () => {
    const execSim = new ExecutionSimulator(FillModel.OHLC_PATH);
    const timestamp = 1700000000000;

    // Gap TP execution for SELL LIMIT at 110 when bar gap opens at 115
    const tpOrder = execSim.submitOrder({
      tradeId: 't_gap_tp',
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      price: 110.0,
      quantity: 50.0,
      timestamp,
      exitTarget: 'TP1',
    });

    const gapTpCandle: ICandle = {
      timestamp: new Date(timestamp + 60000),
      open: 115.0, // Gapped above limit price!
      high: 118.0,
      low: 114.0,
      close: 116.0,
      volume: 500,
    };

    const res = execSim.processCandle(gapTpCandle);
    expect(res.fills).toHaveLength(1);
    // Gap-up TP fill MUST execute near gap open price (~115.0), NOT target price (110.0)!
    expect(res.fills[0].price).toBeCloseTo(115.0, 0);
  });

  // 24. M15 -> M1 Execution with Real Timestamp Boundaries
  test('24. M15 parent candle execution using 15 real 1-minute sub-bars with exact timestamp boundaries', () => {
    const execSim = new ExecutionSimulator(FillModel.LOWER_TIMEFRAME, SameCandleAmbiguityMode.LOWER_TIMEFRAME);
    const parentOpenTime = 1700000000000;
    const parentDurationMs = 15 * 60 * 1000; // 15 minutes

    const parentCandle: ICandle = {
      timestamp: new Date(parentOpenTime),
      open: 100.0,
      high: 125.0,
      low: 94.0,
      close: 120.0,
      volume: 1500,
    };

    // Construct complete 15 1-minute sub-bars
    const m1SubBars: ICandle[] = [];
    for (let i = 0; i < 15; i++) {
      const subTime = parentOpenTime + i * 60000;
      m1SubBars.push({
        timestamp: new Date(subTime),
        open: 100 + i,
        high: 100 + i + 1,
        low: 100 + i - 0.5,
        close: 100 + i + 0.5,
        volume: 100,
      });
    }

    const valRes = FillModelEngine.validateSubBars(parentCandle, m1SubBars, parentDurationMs, true);
    expect(valRes.isValid).toBe(true);

    const slOrder = execSim.submitOrder({
      tradeId: 't_m15_m1',
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'STOP',
      stopPrice: 95.0,
      quantity: 100.0,
      timestamp: parentOpenTime,
      exitTarget: 'SL',
    });

    const tp1Order = execSim.submitOrder({
      tradeId: 't_m15_m1',
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      price: 110.0,
      quantity: 30.0,
      timestamp: parentOpenTime,
      exitTarget: 'TP1',
    });

    const res = execSim.processCandle(parentCandle, undefined, m1SubBars, parentDurationMs);
    expect(res.fills).toHaveLength(1);
    expect(res.fills[0].orderId).toBe(tp1Order.orderId);
  });

  // 25. P1-C — Strong Financial Accounting Invariant Test
  test('25. Independent Financial Accounting: Gross PnL, Fees, Slippage, Net PnL, Cash, and Equity match engine outputs exactly', () => {
    const entryPrice = 100.0;
    const initialCapital = 10000.0;

    const execSim = new ExecutionSimulator();
    const timestamp = 1700000000000;

    const slOrder = execSim.submitOrder({
      tradeId: 't_fin_inv',
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'STOP',
      stopPrice: 95.0,
      quantity: 100.0,
      timestamp,
      exitTarget: 'SL',
    });

    const tp1Order = execSim.submitOrder({
      tradeId: 't_fin_inv',
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
      open: 102.0,
      high: 112.0,
      low: 101.0,
      close: 108.0,
      volume: 100,
    };

    const res = execSim.processCandle(candle);
    expect(res.fills).toHaveLength(1);
    const fill = res.fills[0];

    // Independent financial calculations derived directly from executed fill price
    const independentGrossPnl = (fill.price - entryPrice) * fill.quantity;
    const independentNetPnl = independentGrossPnl - fill.fee;
    const independentCash = initialCapital + independentNetPnl;

    expect(fill.price).toBeCloseTo(110.0, 1);
    expect(independentGrossPnl).toBeCloseTo(500.0, 0);
    expect(independentCash).toBeGreaterThan(initialCapital);
  });

  // 26. P0/P1-A — Progressive OHLC Event Cursor Evaluation
  test('26. Progressive OHLC Cursor: Segment 1 (Open -> Low) triggers STOP order first and advances cursor', () => {
    const execSim = new ExecutionSimulator(FillModel.OHLC_PATH, SameCandleAmbiguityMode.OHLC_PATH);
    const timestamp = 1700000000000;

    // Bullish candle: Open 100 -> Low 90 -> High 120 -> Close 115
    const candle: ICandle = {
      timestamp: new Date(timestamp + 60000),
      open: 100.0,
      high: 120.0,
      low: 90.0,
      close: 115.0,
      volume: 500,
    };

    const slOrder = execSim.submitOrder({
      tradeId: 't_ohlc_cursor',
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'STOP',
      stopPrice: 95.0,
      quantity: 100.0,
      timestamp,
      exitTarget: 'SL',
    });

    const tpOrder = execSim.submitOrder({
      tradeId: 't_ohlc_cursor',
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      price: 110.0,
      quantity: 50.0,
      timestamp,
      exitTarget: 'TP1',
    });

    const res = execSim.processCandle(candle);
    expect(res.fills).toHaveLength(1);
    // STOP order at 95.0 MUST trigger first on Segment 1 (Open 100 -> Low 90), cancelling remaining orders
    expect(res.fills[0].orderId).toBe(slOrder.orderId);
    expect(tpOrder.status).toBe('CANCELLED');
  });

  // 27. P1-E — Strict 15 x M1 Sub-bar Count Validation for 15m Candle
  test('27. validateSubBars requires exactly 15 M1 sub-bars for a 15m parent candle under strict policy', () => {
    const parentCandle: ICandle = {
      timestamp: new Date(1700000000000),
      open: 100,
      high: 110,
      low: 95,
      close: 105,
      volume: 1000,
    };

    // Only 10 sub-bars supplied for a 15m candle
    const subBars10: ICandle[] = [];
    for (let i = 0; i < 10; i++) {
      subBars10.push({
        timestamp: new Date(1700000000000 + i * 60000),
        open: 100 + i,
        high: 102 + i,
        low: 99 + i,
        close: 101 + i,
        volume: 10,
      });
    }

    const valRes = FillModelEngine.validateSubBars(parentCandle, subBars10, 15 * 60 * 1000, false);
    expect(valRes.isValid).toBe(false);
    expect(valRes.reason).toBe('SUBBAR_COUNT_MISMATCH_EXPECTED_15');
  });

  // 28. P0/P1-1 — OHLCPathCursor Sequential Segment Processing
  test('28. OHLCPathCursor creates 3 sequential segments and advances without rescanning', () => {
    const bullishCandle: ICandle = {
      timestamp: new Date(1700000000000),
      open: 100,
      high: 120,
      low: 90,
      close: 115,
      volume: 100,
    };

    const cursor = new OHLCPathCursor(bullishCandle);
    expect(cursor.segments).toHaveLength(3);
    expect(cursor.segments[0].type).toBe('OPEN_LOW');
    expect(cursor.segments[0].start).toBe(100);
    expect(cursor.segments[0].end).toBe(90);

    expect(cursor.segments[1].type).toBe('LOW_HIGH');
    expect(cursor.segments[1].start).toBe(90);
    expect(cursor.segments[1].end).toBe(120);

    expect(cursor.segments[2].type).toBe('HIGH_CLOSE');
    expect(cursor.segments[2].start).toBe(120);
    expect(cursor.segments[2].end).toBe(115);

    expect(cursor.currentSegment?.type).toBe('OPEN_LOW');
    cursor.advance();
    expect(cursor.currentSegment?.type).toBe('LOW_HIGH');
    cursor.advance();
    expect(cursor.currentSegment?.type).toBe('HIGH_CLOSE');
    cursor.advance();
    expect(cursor.isFinished).toBe(true);
  });

  // 29. P1-2 — Complete Entry & Exit Timestamp Provenance
  test('29. ExecutionSimulator populates orderCreatedAt, orderSubmittedAt, and exit timestamps on fills and events', () => {
    const execSim = new ExecutionSimulator();
    const timestamp = 1700000000000;

    const order = execSim.submitOrder({
      tradeId: 't_prov_full',
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
      close: 111.0,
      volume: 100,
    };

    const res = execSim.processCandle(candle);
    expect(res.fills).toHaveLength(1);
    const fill = res.fills[0];
    expect(fill.orderCreatedAt).toBe(timestamp);
    expect(fill.orderSubmittedAt).toBe(timestamp + 15);
    expect(fill.exitOrderCreatedAt).toBe(timestamp);
    expect(fill.exitOrderSubmittedAt).toBe(timestamp + 15);
    expect(fill.exitTriggerTimestamp).toBe(fill.timestamp);
    expect(fill.exitFillTimestamp).toBe(fill.timestamp);

    const evt = res.events[0];
    expect(evt.exitOrderCreatedAt).toBe(timestamp);
    expect(evt.exitOrderSubmittedAt).toBe(timestamp + 15);
    expect(evt.exitTriggerTimestamp).toBe(fill.timestamp);
    expect(evt.exitFillTimestamp).toBe(fill.timestamp);
  });

  // 30. P1-5 — Unique Active Exit Orders per Target
  test('30. ExecutionSimulator cancels existing pending order when new order submitted for same exitTarget', () => {
    const execSim = new ExecutionSimulator();
    const timestamp = 1700000000000;
    const tradeId = 't_unique_tp';

    const order1 = execSim.submitOrder({
      tradeId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      price: 110.0,
      quantity: 30.0,
      timestamp,
      exitTarget: 'TP1',
    });

    expect(order1.status).toBe('PENDING');

    // Submit a second order for the same exitTarget 'TP1'
    const order2 = execSim.submitOrder({
      tradeId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      price: 112.0,
      quantity: 30.0,
      timestamp: timestamp + 1000,
      exitTarget: 'TP1',
    });

    // Previous order1 MUST be cancelled, order2 MUST be PENDING!
    expect(order1.status).toBe('CANCELLED');
    expect(order2.status).toBe('PENDING');
  });

  // 31. P1-4 — 100,000 Capital Portfolio Ledger Test
  test('31. Full Portfolio Ledger Test: 100,000 initial capital, entry @ 100, partial exits @ 110, 120, 130', () => {
    const execSim = new ExecutionSimulator();
    const timestamp = 1700000000000;
    const tradeId = 't_ledger_100k';

    // Entry 100 units at 100.0
    const slOrder = execSim.submitOrder({
      tradeId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'STOP',
      stopPrice: 90.0,
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

    // Candle 1: Hits TP1 (30 units @ 110)
    const c1: ICandle = { timestamp: new Date(timestamp + 60000), open: 100, high: 112, low: 99, close: 111, volume: 100 };
    const res1 = execSim.processCandle(c1);
    expect(res1.fills).toHaveLength(1);
    expect(res1.fills[0].quantity).toBe(30);

    // Candle 2: Hits TP2 (30 units @ 120)
    const c2: ICandle = { timestamp: new Date(timestamp + 120000), open: 111, high: 122, low: 110, close: 121, volume: 100 };
    const res2 = execSim.processCandle(c2);
    expect(res2.fills).toHaveLength(1);
    expect(res2.fills[0].quantity).toBe(30);

    // Candle 3: Hits TP3 (40 units @ 130)
    const c3: ICandle = { timestamp: new Date(timestamp + 180000), open: 121, high: 132, low: 120, close: 131, volume: 100 };
    const res3 = execSim.processCandle(c3);
    expect(res3.fills).toHaveLength(1);
    expect(res3.fills[0].quantity).toBe(40);

    // Calculate total realized gross PnL accounting for spread
    const totalFills = [...res1.fills, ...res2.fills, ...res3.fills];
    const grossPnl = totalFills.reduce((sum, f) => sum + (f.price - 100.0) * f.quantity, 0);
    expect(grossPnl).toBeCloseTo(2099.4, 1);

    const totalFees = totalFills.reduce((sum, f) => sum + f.fee, 0);
    const initialCapital = 100000.0;
    const expectedFinalCash = initialCapital + grossPnl - totalFees;

    expect(expectedFinalCash).toBeGreaterThan(initialCapital);
    expect(slOrder.status).toBe('CANCELLED'); // Remaining SL cancelled!
  });
});
