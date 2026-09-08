import { ExecutionSimulator } from '../execution/execution-simulator';
import { FillModelEngine } from '../execution/fill-model';
import { FillModel, SameCandleAmbiguityMode } from '../execution/types';
import { TradeLifecycleManager } from '@quant/risk-engine';
import { Direction, ICandle } from '@quant/shared';

describe('Backtesting Execution Correctness Pass (6 Targeted Fixes)', () => {
  // 1. OCO / Reserved Quantity Correctness
  test('1. OCO group automatically cancels sibling exit orders when one fills', () => {
    const execSim = new ExecutionSimulator(FillModel.OHLC_PATH, SameCandleAmbiguityMode.CONSERVATIVE);
    const timestamp = 1700000000000;
    const ocoGroup = 'oco_trade_1_1';

    // Submit SL order
    const slOrder = execSim.submitOrder({
      tradeId: 'trade_1',
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'STOP',
      stopPrice: 95.0,
      quantity: 1.0,
      timestamp,
      exitTarget: 'SL',
      ocoGroupId: ocoGroup,
    });

    // Submit TP1 order
    const tp1Order = execSim.submitOrder({
      tradeId: 'trade_1',
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      price: 110.0,
      quantity: 1.0,
      timestamp,
      exitTarget: 'TP1',
      ocoGroupId: ocoGroup,
    });

    // Candle touches TP1 target (High: 112) but not SL (Low: 98)
    const candle: ICandle = {
      timestamp: new Date(timestamp + 60000),
      open: 100.0,
      high: 112.0,
      low: 98.0,
      close: 108.0,
      volume: 100,
    };

    const res = execSim.processCandle(candle);
    expect(res.fills).toHaveLength(1);
    expect(res.fills[0].orderId).toBe(tp1Order.orderId);
    expect(res.fills[0].exitTarget).toBe('TP1');
    expect(tp1Order.status).toBe('FILLED');

    // Sibling SL order in same OCO group must be CANCELLED
    expect(slOrder.status).toBe('CANCELLED');
  });

  // 2. TP1/TP2/TP3 Identity on Orders/Fills
  test('2. Orders and fills retain target identities (ENTRY, TP1, TP2, TP3, SL)', () => {
    const execSim = new ExecutionSimulator(FillModel.OHLC_PATH, SameCandleAmbiguityMode.CONSERVATIVE);
    const timestamp = 1700000000000;

    const entryOrder = execSim.submitOrder({
      tradeId: 'trade_2',
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      quantity: 2.0,
      timestamp,
      exitTarget: 'ENTRY',
    });

    expect(entryOrder.exitTarget).toBe('ENTRY');

    const candle: ICandle = {
      timestamp: new Date(timestamp + 60000),
      open: 100.0,
      high: 102.0,
      low: 99.0,
      close: 101.0,
      volume: 50,
    };

    const res = execSim.processCandle(candle);
    expect(res.fills).toHaveLength(1);
    expect(res.fills[0].exitTarget).toBe('ENTRY');
  });

  // 3. Signal / Order Timestamps
  test('3. Rejects order submission if order timestamp precedes signal timestamp', () => {
    const execSim = new ExecutionSimulator();
    const signalTimestamp = 1700001000000;
    const invalidOrderTimestamp = 1700000000000; // 1000s earlier

    expect(() => {
      execSim.submitOrder({
        tradeId: 'trade_3',
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

  // 4. Entry Reference Price
  test('4. Entry reference price is preserved on order and fill', () => {
    const execSim = new ExecutionSimulator(FillModel.OHLC_PATH);
    const timestamp = 1700000000000;
    const refPrice = 100.0;

    const order = execSim.submitOrder({
      tradeId: 'trade_4',
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
    // Fill occurs at market open + spread
    expect(res.fills[0].price).toBeGreaterThanOrEqual(100.5);
  });

  // 5. Lower-TF Upper-Bound Validation
  test('5. validateSubBars fails closed if sub-bars exceed parent bar close boundary', () => {
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

    // Sub-bar extending past 11:00 (future data leak)
    const invalidFutureSubBars: ICandle[] = [
      { timestamp: new Date(parentOpen + 60000), open: 100, high: 102, low: 99, close: 101, volume: 10 },
      { timestamp: new Date(parentClose + 60000), open: 105, high: 108, low: 104, close: 107, volume: 10 }, // 11:01 - Future!
    ];

    const valRes = FillModelEngine.validateSubBars(parentCandle, invalidFutureSubBars, parentDurationMs);
    expect(valRes.isValid).toBe(false);
    expect(valRes.reason).toBe('SUBBAR_OUT_OF_BOUNDS_FUTURE');

    // Valid sub-bars inside [10:00, 11:00)
    const validSubBars: ICandle[] = [
      { timestamp: new Date(parentOpen + 60000), open: 100, high: 102, low: 99, close: 101, volume: 10 },
      { timestamp: new Date(parentOpen + 1800000), open: 101, high: 105, low: 100, close: 104, volume: 10 },
    ];

    const valValid = FillModelEngine.validateSubBars(parentCandle, validSubBars, parentDurationMs);
    expect(valValid.isValid).toBe(true);
  });

  // 6. Deprecate/Disable Synthetic Lifecycle Execution for Backtesting
  test('6. evaluateLotTick throws exception when invoked with forBacktest = true', () => {
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
