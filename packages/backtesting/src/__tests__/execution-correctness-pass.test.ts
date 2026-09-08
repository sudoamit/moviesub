import { ExecutionSimulator } from '../execution/execution-simulator';
import { FillModelEngine } from '../execution/fill-model';
import { FillModel, SameCandleAmbiguityMode } from '../execution/types';
import { TradeLifecycleManager } from '@quant/risk-engine';
import { Direction, ICandle } from '@quant/shared';

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
      exitTarget: 'TP2',
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
    expect(res.fills[1].exitTarget).toBe('TP2');
    expect(res.fills[1].quantity).toBe(30);
    expect(res.fills[2].exitTarget).toBe('SL');
    expect(res.fills[2].quantity).toBe(40);

    expect(tp1Order.status).toBe('FILLED');
    expect(tp2Order.status).toBe('FILLED');
    expect(slOrder.status).toBe('FILLED');
  });

  // 6. Signal / Order Timestamps Validation
  test('6. Rejects order submission if order timestamp precedes signal timestamp', () => {
    const execSim = new ExecutionSimulator();
    const signalTimestamp = 1700001000000;
    const invalidOrderTimestamp = 1700000000000; // 1000s earlier

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

  // 7. Entry Reference Price Preservation
  test('7. Entry reference price is preserved on order and fill', () => {
    const execSim = new ExecutionSimulator(FillModel.OHLC_PATH);
    const timestamp = 1700000000000;
    const refPrice = 100.0;

    const order = execSim.submitOrder({
      tradeId: 'trade_ref',
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      quantity: 1.0,
      timestamp,
      referencePrice: refPrice,
    });

    expect(order.referencePrice).toBe(100.0);

    const candle: ICandle = {
      timestamp: new Date(timestamp + 60000),
      open: 100.5,
      high: 102.0,
      low: 100.0,
      close: 101.0,
      volume: 10,
    };

    const res = execSim.processCandle(candle);
    expect(res.fills).toHaveLength(1);
    expect(res.fills[0].price).toBeGreaterThanOrEqual(100.5);
  });

  // 8. Lower-TF Upper-Bound Validation
  test('8. validateSubBars fails closed if sub-bars exceed parent bar close boundary', () => {
    const parentOpen = 1700000000000; // 10:00
    const parentDurationMs = 3600000; // 1 Hour (10:00 to 11:00)
    const parentClose = parentOpen + parentDurationMs;

    const parentCandle: ICandle = {
      timestamp: new Date(parentOpen),
      open: 100,
      high: 110,
      low: 95,
      close: 105,
      volume: 1000,
    };

    const invalidFutureSubBars: ICandle[] = [
      { timestamp: new Date(parentOpen + 60000), open: 100, high: 102, low: 99, close: 101, volume: 10 },
      { timestamp: new Date(parentClose + 60000), open: 105, high: 108, low: 104, close: 107, volume: 10 },
    ];

    const valRes = FillModelEngine.validateSubBars(parentCandle, invalidFutureSubBars, parentDurationMs);
    expect(valRes.isValid).toBe(false);
    expect(valRes.reason).toBe('SUBBAR_OUT_OF_BOUNDS_FUTURE');
  });

  // 9. Deprecate/Disable Synthetic Lifecycle Execution for Backtesting
  test('9. evaluateLotTick throws exception when invoked with forBacktest = true', () => {
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

    expect(() => {
      TradeLifecycleManager.evaluateLotTick(lot, candle, undefined, undefined, true);
    }).toThrow('Synthetic lifecycle evaluation (evaluateLotTick) is deprecated and disabled for backtesting. Backtests must use ExecutionSimulator.');
  });
});
