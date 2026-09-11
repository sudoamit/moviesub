import {
  Direction,
  ICandle,
  ISignalSetup,
  SignalGrade,
  SignalState,
  Timeframe,
  PositionSide,
  normalizeDirection,
  isLongPosition,
} from '@quant/shared';
import {
  TradeLifecycleManager,
  DEFAULT_PARTIAL_EXIT_POLICY,
  PositionLot,
} from '@quant/risk-engine';
import { BacktestSimulator } from '../backtest-simulator';
import {
  ExecutionSimulator,
  FillModel,
  FillModelEngine,
  SameCandleAmbiguityMode,
  IOrder,
  IFill,
} from '../execution';

describe('AI Fix 76 — Full-Stack TP/SL Integration & Single-Authority Parity', () => {
  const t0 = 1700000000000;
  const interval = 15 * 60 * 1000; // 15m

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

  // -------------------------------------------------------------------------
  // Test 1: Full-Stack vs Direct Execution Parity
  // -------------------------------------------------------------------------
  test('T01: Full-Stack BacktestSimulator vs Direct ExecutionSimulator + Lifecycle Parity', () => {
    // 30 warmup candles around 100
    const candles: ICandle[] = [];
    for (let i = 0; i < 30; i++) {
      candles.push(createCandle(i, 100, 101, 99, 100));
    }
    // Bar 30: Signal generation bar (close 100)
    candles.push(createCandle(30, 100, 101, 99, 100));
    // Bar 31: Entry execution bar (open 100)
    candles.push(createCandle(31, 100, 102, 99, 101));
    // Bar 32: TP1 target bar (high reaches 106 >= 105 TP1)
    candles.push(createCandle(32, 101, 106, 100, 105));
    // Bar 33: Pullback to breakeven stop (low drops to 99 <= 100 BE stop)
    candles.push(createCandle(33, 105, 105, 98, 99));

    const deterministicSignal: ISignalSetup = {
      id: 'sig_parity_1',
      symbol: 'BTCUSDT',
      timeframe: '15m',
      direction: Direction.BULLISH,
      state: SignalState.ACTIVE,
      grade: SignalGrade.A_PLUS,
      score: 85,
      entryZone: { min: 99.5, max: 100.5, optimal: 100.0 },
      stopLoss: 95.0,
      takeProfits: { tp1: 105.0, tp2: 110.0, tp3: 115.0 },
      riskRewardRatios: { rr1: 1.0, rr2: 2.0, rr3: 3.0 },
      reasoning: {
        summary: 'Deterministic Parity Test',
        htfStructure: 'BULLISH',
        liquidityReason: 'SWEEP',
        triggerReason: 'ORDER_BLOCK',
        invalidationReason: 'BELOW_SWING_LOW',
        confirmedChecklist: ['SWEEP', 'CHoCH'],
      },
      scoreBreakdown: {
        htfBias: 10,
        liquiditySweep: 10,
        bos: 10,
        fvg: 10,
        orderBlock: 10,
        displacement: 10,
        volumeConfirmation: 10,
        premiumDiscount: 5,
        riskReward: 5,
        indicatorAlignment: 5,
        totalScore: 85,
        grade: SignalGrade.A_PLUS,
      },
      timestamp: new Date(t0 + 30 * interval),
    };

    // 1. Run Full-Stack Simulation
    const fullStackResult = BacktestSimulator.runSimulation({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      initialCapital: 100000,
      candles,
      warmupBars: 30,
      minimumCandles: 30,
      strategyMode: 'SMC',
      strategyConfig: {
        deterministicSignals: [
          {
            id: 'sig_parity_1',
            direction: 'BULLISH',
            score: 85,
            entryPrice: 100.0,
            stopLoss: 95.0,
            tp1: 105.0,
            tp2: 110.0,
            tp3: 115.0,
          },
        ],
      },
      partialExitPolicy: {
        tp1Ratio: 0.5,
        tp2Ratio: 0.5,
        tp3Ratio: 0.0,
        moveStopToBreakevenOnTp1: true,
        trailStopOnTp2: false,
      },
      fillModel: FillModel.OHLC_PATH,
      ambiguityMode: SameCandleAmbiguityMode.CONSERVATIVE,
      slippageBps: 0,
      feeRate: 0.0004,
    });

    expect(fullStackResult.trades.length).toBe(1);
    const fsTrade = fullStackResult.trades[0];

    // 2. Run Direct ExecutionSimulator Pipeline with matching execution configs
    const directSim = new ExecutionSimulator(
      FillModel.OHLC_PATH,
      SameCandleAmbiguityMode.CONSERVATIVE,
      { submissionLatencyMs: 0, processingLatencyMs: 0 },
      'direct_run',
      {
        baseSlippageBps: 0,
        volatilityMultiplier: 1.5,
        impactMultiplier: 0.8,
        maxSlippageBps: 25.0,
      },
      { brokerageRateBps: 4.0 },
    );

    // Submit entry order at Bar 30 close using the identical position size calculated by BacktestSimulator
    const entryOrder = directSim.submitOrder({
      tradeId: 't_direct_1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      price: 100.0,
      quantity: fsTrade.positionSize,
      timestamp: t0 + 30 * interval,
      exitTarget: 'ENTRY',
    });

    // Bar 31: Entry fills
    const bar31Res = directSim.processCandle(candles[31]);
    expect(bar31Res.fills.length).toBe(1);
    const entryFill = bar31Res.fills[0];

    let directLot: PositionLot | null = TradeLifecycleManager.createPositionLot(
      deterministicSignal,
      entryFill.price,
      entryFill.quantity,
      entryFill.timestamp,
      entryOrder.orderId,
      entryFill.fee,
      entryFill.slippage,
    );

    // Submit resting exit orders
    const slOrder = directSim.submitOrder({
      tradeId: directLot.tradeId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'STOP',
      stopPrice: directLot.currentStopLoss,
      quantity: directLot.remainingQuantity,
      timestamp: entryFill.timestamp,
      exitTarget: 'SL',
    });
    const tp1Order = directSim.submitOrder({
      tradeId: directLot.tradeId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      price: directLot.tp1,
      quantity: Math.round(directLot.initialQuantity * 0.5),
      timestamp: entryFill.timestamp,
      exitTarget: 'TP1',
      referencePrice: directLot.entryPrice,
    });

    // Bar 32: TP1 triggers
    const bar32Res = directSim.processCandle(candles[32]);
    expect(bar32Res.fills.length).toBe(1);
    const tp1Fill = bar32Res.fills[0];

    const exit1 = TradeLifecycleManager.processExitFill(
      directLot,
      { ...tp1Fill, targetType: 'TP1' },
      { tp1Ratio: 0.5, tp2Ratio: 0.5, tp3Ratio: 0.0, moveStopToBreakevenOnTp1: true, trailStopOnTp2: false },
      'OHLC_PATH',
      'CONSERVATIVE',
    );
    directLot = exit1.lot;
    expect(exit1.isClosed).toBe(false);
    expect(exit1.isBreakevenStopTriggered).toBe(true);

    // Bar 33: Breakeven Stop triggers
    const bar33Res = directSim.processCandle(candles[33]);
    expect(bar33Res.fills.length).toBe(1);
    const slFill = bar33Res.fills[0];

    const exit2 = TradeLifecycleManager.processExitFill(
      directLot,
      { ...slFill, targetType: 'TRAILING_STOP' },
      { tp1Ratio: 0.5, tp2Ratio: 0.5, tp3Ratio: 0.0, moveStopToBreakevenOnTp1: true, trailStopOnTp2: false },
      'OHLC_PATH',
      'CONSERVATIVE',
    );
    expect(exit2.isClosed).toBe(true);
    const directTrade = exit2.completedTrade!;

    // 3. Assert Exact Bit-For-Bit Equivalence
    expect(fsTrade.entryPrice).toBe(directTrade.entryPrice);
    expect(fsTrade.exitPrice).toBe(directTrade.exitPrice);
    expect(fsTrade.exitReason).toBe(directTrade.exitReason);
    expect(fsTrade.grossPnL).toBe(directTrade.grossPnL);
    expect(fsTrade.netPnL).toBe(directTrade.netPnL);
    expect(fsTrade.realizedR).toBe(directTrade.realizedR);
    expect(fsTrade.positionSize).toBe(directTrade.positionSize);
  });

  // -------------------------------------------------------------------------
  // Test 2: Same-Candle Ambiguity & OHLC Path Trajectory Full-Stack Resolution
  // -------------------------------------------------------------------------
  test('T02: Same-Candle Ambiguity Full-Stack Resolution matches ExecutionSimulator strictly', () => {
    // 30 warmup candles
    const baseCandles: ICandle[] = [];
    for (let i = 0; i < 30; i++) {
      baseCandles.push(createCandle(i, 100, 101, 99, 100));
    }
    baseCandles.push(createCandle(30, 100, 101, 99, 100)); // Signal bar
    baseCandles.push(createCandle(31, 100, 101, 99, 100)); // Entry bar

    // 1. Bullish Ambiguous Candle 32: Open 100, High 112, Low 88, Close 101
    // OHLC Path: Open (100) -> Low (88) -> High (112) -> Close (101)
    // Low leg is visited first -> SL at 90 triggers first
    const bullishAmbiguousCandle = createCandle(32, 100, 112, 88, 101);
    const runCandlesBullish = [...baseCandles, bullishAmbiguousCandle];

    const resBullish = BacktestSimulator.runSimulation({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      initialCapital: 100000,
      candles: runCandlesBullish,
      warmupBars: 30,
      minimumCandles: 30,
      strategyMode: 'SMC',
      strategyConfig: {
        deterministicSignals: [
          {
            id: 'sig_ambig_bull',
            direction: 'BULLISH',
            score: 85,
            entryPrice: 100.0,
            stopLoss: 90.0,
            tp1: 110.0,
          },
        ],
      },
      ambiguityMode: SameCandleAmbiguityMode.CONSERVATIVE,
      fillModel: FillModel.OHLC_PATH,
      slippageBps: 0,
    });
    expect(resBullish.trades.length).toBe(1);
    expect(resBullish.trades[0].exitReason).toBe(SignalState.SL_HIT);
    expect(resBullish.trades[0].exitPrice).toBeCloseTo(90.0, 1);

    // 2. Bearish Ambiguous Candle 32: Open 100, High 112, Low 88, Close 99
    // OHLC Path: Open (100) -> High (112) -> Low (88) -> Close (99)
    // High leg is visited first -> TP at 110 triggers first
    const bearishAmbiguousCandle = createCandle(32, 100, 112, 88, 99);
    const runCandlesBearish = [...baseCandles, bearishAmbiguousCandle];

    const resBearish = BacktestSimulator.runSimulation({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      initialCapital: 100000,
      candles: runCandlesBearish,
      warmupBars: 30,
      minimumCandles: 30,
      strategyMode: 'SMC',
      strategyConfig: {
        deterministicSignals: [
          {
            id: 'sig_ambig_bear',
            direction: 'BULLISH',
            score: 85,
            entryPrice: 100.0,
            stopLoss: 90.0,
            tp1: 110.0,
          },
        ],
      },
      ambiguityMode: SameCandleAmbiguityMode.OPTIMISTIC,
      fillModel: FillModel.OHLC_PATH,
      slippageBps: 0,
      partialExitPolicy: {
        tp1Ratio: 1.0,
        tp2Ratio: 0.0,
        tp3Ratio: 0.0,
        moveStopToBreakevenOnTp1: false,
        trailStopOnTp2: false,
      },
    });
    expect(resBearish.trades.length).toBe(1);
    expect(resBearish.trades[0].exitReason).toBe(SignalState.TP1_HIT);
    expect(resBearish.trades[0].exitPrice).toBeCloseTo(110.0, 1);

    // 3. Direct Segment Ambiguity Resolution (CONSERVATIVE vs OPTIMISTIC)
    const slOrder: IOrder = {
      orderId: 'ord_sl_ambig',
      clientOrderId: 'c_sl',
      tradeId: 't_ambig',
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'STOP',
      stopPrice: 90,
      quantity: 10,
      remainingQuantity: 10,
      status: 'PENDING',
      createdAt: t0,
      submittedAt: t0,
      exitTarget: 'SL',
      fees: 0,
      slippage: 0,
    };
    const tpOrder: IOrder = {
      orderId: 'ord_tp_ambig',
      clientOrderId: 'c_tp',
      tradeId: 't_ambig',
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      price: 110,
      quantity: 10,
      remainingQuantity: 10,
      status: 'PENDING',
      createdAt: t0,
      submittedAt: t0,
      exitTarget: 'TP1',
      fees: 0,
      slippage: 0,
    };

    const triggeredOrders = [
      { order: slOrder, fill: { fillId: 'f1', orderId: 'ord_sl_ambig', tradeId: 't_ambig', symbol: 'BTCUSDT', side: 'SELL' as const, price: 90, quantity: 10, fee: 0, slippage: 0, timestamp: t0, isPartial: false } },
      { order: tpOrder, fill: { fillId: 'f2', orderId: 'ord_tp_ambig', tradeId: 't_ambig', symbol: 'BTCUSDT', side: 'SELL' as const, price: 110, quantity: 10, fee: 0, slippage: 0, timestamp: t0, isPartial: false } },
    ];

    // Equidistant from segStart = 100:
    const consResolution = FillModelEngine.resolveSegmentConflict(triggeredOrders, 100, 120, SameCandleAmbiguityMode.CONSERVATIVE);
    expect(consResolution.winningOrder?.orderType).toBe('STOP');
    expect(consResolution.reason).toBe('CONSERVATIVE_STOP_FIRST');

    const optResolution = FillModelEngine.resolveSegmentConflict(triggeredOrders, 100, 120, SameCandleAmbiguityMode.OPTIMISTIC);
    expect(optResolution.winningOrder?.orderType).toBe('LIMIT');
    expect(optResolution.reason).toBe('OPTIMISTIC_TARGET_FIRST');
  });

  // -------------------------------------------------------------------------
  // Test 3: Fail-Closed Invalid Risk Configuration
  // -------------------------------------------------------------------------
  test('T03: Fail-Closed Invalid Risk Configuration throws without manufacturing synthetic stops', () => {
    const validSignal: ISignalSetup = {
      id: 'sig_invalid_sl',
      symbol: 'BTCUSDT',
      timeframe: '15m',
      direction: Direction.BULLISH,
      state: SignalState.ACTIVE,
      grade: SignalGrade.A_PLUS,
      score: 85,
      entryZone: { min: 99.5, max: 100.5, optimal: 100.0 },
      stopLoss: 0, // Invalid zero stop
      takeProfits: { tp1: 110.0, tp2: 120.0, tp3: 130.0 },
      riskRewardRatios: { rr1: 1.0, rr2: 2.0, rr3: 3.0 },
      reasoning: {
        summary: 'Invalid Risk Test',
        htfStructure: 'BULLISH',
        liquidityReason: 'SWEEP',
        triggerReason: 'ORDER_BLOCK',
        invalidationReason: 'BELOW_SWING_LOW',
        confirmedChecklist: ['SWEEP', 'CHoCH'],
      },
      scoreBreakdown: {
        htfBias: 10,
        liquiditySweep: 10,
        bos: 10,
        fvg: 10,
        orderBlock: 10,
        displacement: 10,
        volumeConfirmation: 10,
        premiumDiscount: 5,
        riskReward: 5,
        indicatorAlignment: 5,
        totalScore: 85,
        grade: SignalGrade.A_PLUS,
      },
    };

    // 1. Zero stopLoss throws INVALID_SIGNAL_STOP_LOSS
    expect(() => TradeLifecycleManager.createPositionLot(validSignal, 100, 10, t0)).toThrow(
      'INVALID_SIGNAL_STOP_LOSS',
    );

    // 2. Negative stopLoss throws INVALID_SIGNAL_STOP_LOSS
    expect(() =>
      TradeLifecycleManager.createPositionLot({ ...validSignal, stopLoss: -10 }, 100, 10, t0),
    ).toThrow('INVALID_SIGNAL_STOP_LOSS');

    // 3. Undefined stopLoss throws INVALID_SIGNAL_STOP_LOSS
    expect(() =>
      TradeLifecycleManager.createPositionLot({ ...validSignal, stopLoss: undefined as any }, 100, 10, t0),
    ).toThrow('INVALID_SIGNAL_STOP_LOSS');

    // 4. NaN stopLoss throws INVALID_SIGNAL_STOP_LOSS
    expect(() =>
      TradeLifecycleManager.createPositionLot(
        { ...validSignal, direction: Direction.BEARISH, stopLoss: NaN },
        100,
        10,
        t0,
      ),
    ).toThrow('INVALID_SIGNAL_STOP_LOSS');
  });

  // -------------------------------------------------------------------------
  // Test 4: Direction Normalization & PositionSide Domain Typing
  // -------------------------------------------------------------------------
  test('T04: Direction Normalization & PositionSide Domain Typing works seamlessly without as any', () => {
    expect(normalizeDirection(Direction.BULLISH)).toBe(PositionSide.LONG);
    expect(normalizeDirection('LONG')).toBe(PositionSide.LONG);
    expect(normalizeDirection('BUY')).toBe(PositionSide.LONG);
    expect(normalizeDirection('bullish')).toBe(PositionSide.LONG);

    expect(normalizeDirection(Direction.BEARISH)).toBe(PositionSide.SHORT);
    expect(normalizeDirection('SHORT')).toBe(PositionSide.SHORT);
    expect(normalizeDirection('SELL')).toBe(PositionSide.SHORT);
    expect(normalizeDirection('bearish')).toBe(PositionSide.SHORT);

    expect(normalizeDirection(Direction.NEUTRAL)).toBe('NEUTRAL');
    expect(normalizeDirection(undefined)).toBe('NEUTRAL');

    expect(isLongPosition(Direction.BULLISH)).toBe(true);
    expect(isLongPosition('LONG')).toBe(true);
    expect(isLongPosition('SHORT')).toBe(false);
    expect(isLongPosition(Direction.BEARISH)).toBe(false);
  });
});
