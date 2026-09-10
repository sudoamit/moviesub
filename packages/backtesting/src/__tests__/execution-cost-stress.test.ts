import { ICandle } from '@quant/shared';
import {
  ExecutionSimulator,
  FeeModel,
  FillModel,
  FillModelEngine,
  IOrder,
  ISlippageConfig,
  SlippageModel,
  SpreadModel,
} from '../execution';

describe('Execution cost stress semantics', () => {
  const candle: ICandle = {
    timestamp: new Date(1756972800000),
    open: 100,
    high: 105,
    low: 95,
    close: 102,
    volume: 1000,
  };
  const slippageConfig: ISlippageConfig = {
    baseSlippageBps: 2,
    volatilityMultiplier: 0,
    impactMultiplier: 0,
    maxSlippageBps: 100,
  };

  it.each([
    ['fee', (stress: any) => FeeModel.calculateFees('BTCUSDT', 100, 1, 'BUY', false, undefined, stress)],
    ['spread', (stress: any) => SpreadModel.getHalfSpread(100, 'NIFTY', undefined, stress)],
  ])('%s is monotonic across NORMAL, 2x, and 3x', (_name, calculate) => {
    const normal = calculate({ mode: 'NORMAL' });
    const double = calculate({ mode: 'MULTIPLIER', multiplier: 2 });
    const triple = calculate({ mode: 'MULTIPLIER', multiplier: 3 });

    expect(normal).toBeGreaterThan(0);
    expect(double).toBeGreaterThan(normal);
    expect(triple).toBeGreaterThan(double);
  });

  it('slippage is monotonic across NORMAL, 2x, and 3x', () => {
    const normal = SlippageModel.calculateSlippage(100, 1, 'BUY', 'MARKET', candle, slippageConfig, { mode: 'NORMAL' });
    const double = SlippageModel.calculateSlippage(100, 1, 'BUY', 'MARKET', candle, slippageConfig, { mode: 'MULTIPLIER', multiplier: 2 });
    const triple = SlippageModel.calculateSlippage(100, 1, 'BUY', 'MARKET', candle, slippageConfig, { mode: 'MULTIPLIER', multiplier: 3 });

    expect(double.slippageAmount).toBeGreaterThan(normal.slippageAmount);
    expect(triple.slippageAmount).toBeGreaterThan(double.slippageAmount);
  });

  it('ABSOLUTE spread configuration overrides symbol defaults', () => {
    const spread = SpreadModel.getHalfSpread(100, 'NIFTY', undefined, {
      mode: 'ABSOLUTE',
      spreadConfig: { baseSpreadBps: 10, illiquidMultiplier: 1 },
    });

    expect(spread).toBe(0.05);
  });

  it('propagates cost stress through ExecutionSimulator fills', () => {
    const createFill = (multiplier: number) => {
      const simulator = new ExecutionSimulator(
        FillModel.OHLC_PATH,
        undefined,
        { submissionLatencyMs: 0, processingLatencyMs: 0 },
        `stress-${multiplier}`,
        slippageConfig,
        undefined,
        undefined,
        { mode: multiplier === 1 ? 'NORMAL' : 'MULTIPLIER', multiplier },
      );
      simulator.submitOrder({
        tradeId: 'trade-1',
        symbol: 'BTCUSDT',
        side: 'BUY',
        orderType: 'MARKET',
        quantity: 1,
        timestamp: candle.timestamp instanceof Date ? candle.timestamp.getTime() : 0,
      });
      return simulator.processCandle(candle).fills[0];
    };

    const normal = createFill(1);
    const double = createFill(2);
    const triple = createFill(3);

    expect(double.price).toBeGreaterThan(normal.price);
    expect(triple.price).toBeGreaterThan(double.price);
    expect(double.fee).toBeGreaterThan(normal.fee);
    expect(triple.fee).toBeGreaterThan(double.fee);
  });

  it('builds stressed fills through the shared FillModelEngine path', () => {
    const order: IOrder = {
      orderId: 'order-1',
      clientOrderId: 'client-1',
      tradeId: 'trade-1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      quantity: 1,
      remainingQuantity: 1,
      status: 'PENDING',
      createdAt: candle.timestamp instanceof Date ? candle.timestamp.getTime() : 0,
      submittedAt: candle.timestamp instanceof Date ? candle.timestamp.getTime() : 0,
      fees: 0,
      slippage: 0,
    };
    const fill = FillModelEngine.evaluateFill(order, candle, undefined, FillModel.OHLC_PATH, undefined, undefined, slippageConfig, undefined, undefined, {
      mode: 'MULTIPLIER',
      multiplier: 3,
    }).fill;

    expect(fill).toBeDefined();
    expect(fill!.fee).toBeGreaterThan(0);
    expect(fill!.price).toBeGreaterThan(candle.open);
  });
});