import {
  Direction,
  ICandle,
  PositionSide,
} from '@quant/shared';
import {
  ExecutionSimulator,
  FillModel,
  SameCandleAmbiguityMode,
} from '../execution';

describe('Execution Order State Monotonicity & Zero-Side-Effect Invariant Tests (AI Fix 78, 79, & 80)', () => {
  const t0 = 1700000000000;
  const interval = 15 * 60 * 1000;
  const zeroSlippage = { baseSlippageBps: 0, volatilityMultiplier: 0, impactMultiplier: 0, maxSlippageBps: 0 };

  function createCandle(index: number, open: number, high: number, low: number, close: number): ICandle {
    return {
      timestamp: new Date(t0 + index * interval),
      open,
      high,
      low,
      close,
      volume: 1000,
    };
  }

  test('enforces strict order state monotonicity: PENDING -> REJECTED with zero side effects', () => {
    const execSim = new ExecutionSimulator(
      FillModel.NEXT_BAR_MARKET,
      SameCandleAmbiguityMode.CONSERVATIVE,
      { submissionLatencyMs: 0, processingLatencyMs: 0 },
      'test_mono_1',
      zeroSlippage,
    );

    const entryOrder = execSim.submitOrder({
      tradeId: 'trade_mono_1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: PositionSide.LONG,
      orderType: 'MARKET',
      quantity: 10,
      timestamp: t0,
      referencePrice: 100,
      stopLoss: 95,
      exitTarget: 'ENTRY',
    });

    // 1. Assert pristine initial state
    expect(entryOrder.status).toBe('PENDING');
    expect(entryOrder.filledQuantity).toBe(0);
    expect(entryOrder.remainingQuantity).toBe(10);
    expect(entryOrder.fees).toBe(0);
    expect(entryOrder.slippage).toBe(0);
    expect(execSim.getAllFills().length).toBe(0);
    expect(execSim.getAllEvents().length).toBe(0);

    // 2. Gap candle opening at 90 (below stopLoss of 95)
    const gapCandle = createCandle(1, 90, 91, 89, 90);
    const result = execSim.processSingleExecutionBar(gapCandle);

    // 3. Assert strict monotonic transition PENDING -> REJECTED (never touched FILLED)
    expect(entryOrder.status).toBe('REJECTED');
    expect(entryOrder.rejectionReason).toContain('REJECTED_GAP_THROUGH_STOP');
    expect(entryOrder.filledQuantity).toBe(0);
    expect(entryOrder.remainingQuantity).toBe(10);
    expect(entryOrder.fees).toBe(0);
    expect(entryOrder.slippage).toBe(0);
    expect(entryOrder.avgFillPrice).toBeUndefined();
    expect(entryOrder.firstFilledAt).toBeUndefined();
    expect(entryOrder.completedAt).toBeUndefined();

    // 4. Assert zero side-effects on simulator collections
    expect(result.fills.length).toBe(0);
    expect(execSim.getAllFills().length).toBe(0);
    expect(result.events.length).toBe(1);
    expect(execSim.getAllEvents().length).toBe(1);
    expect(result.events[0].eventType).toBe('ORDER_REJECTED');
    expect(result.events[0].fees).toBe(0);
    expect(result.events[0].slippage).toBe(0);

    // 5. Assert checkpoint serialization and restoration
    const cp = execSim.createCheckpoint();
    expect(cp.fills.length).toBe(0);
    expect(cp.orders.length).toBe(1);
    expect(cp.orders[0].status).toBe('REJECTED');
    expect(cp.orders[0].positionSide).toBe(PositionSide.LONG);

    const restoredSim = new ExecutionSimulator();
    restoredSim.restoreCheckpoint(cp);
    expect(restoredSim.getAllFills().length).toBe(0);
    expect(restoredSim.getOrder(entryOrder.orderId)?.status).toBe('REJECTED');
    expect(restoredSim.getOrder(entryOrder.orderId)?.positionSide).toBe(PositionSide.LONG);
  });
});
