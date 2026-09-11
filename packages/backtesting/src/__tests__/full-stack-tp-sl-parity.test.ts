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
  isShortPosition,
  toOrderSide,
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

describe('AI Fix 77 — Full-Stack TP/SL Parity, Independent Sizing, Explicit TP Policy & Invariants', () => {
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
  // Test 1: Full-Stack vs Direct Execution Parity with Independent Sizing
  // -------------------------------------------------------------------------
  test('T01: Full-Stack BacktestSimulator vs Direct ExecutionSimulator + Lifecycle Parity (Independent Sizing)', () => {
    // Generate 35 deterministic candles
    // Bars 0..29: Warmup flat candles at 100
    // Bar 30: Signal generated at close (100.0)
    // Bar 31: Entry bar opens at 100.0, fills market order at 100.0
    // Bar 32: Candle rallies to 106.0 -> triggers TP1 at 105.0 -> Breakeven stop moved to 100.0
    // Bar 33: Candle drops to 99.0 -> triggers Trailing Stop at 100.0 -> Position closed
    // Bar 34: Cooldown bar
    const candles: ICandle[] = [];
    for (let i = 0; i < 30; i++) {
      candles.push(createCandle(i, 100.0, 100.5, 99.5, 100.0));
    }
    candles.push(createCandle(30, 100.0, 100.5, 99.5, 100.0)); // Signal bar (close: 100.0)
    candles.push(createCandle(31, 100.0, 100.8, 99.8, 100.2)); // Entry bar (open: 100.0)
    candles.push(createCandle(32, 100.2, 106.0, 100.0, 105.5)); // TP1 bar (high: 106.0 >= 105.0)
    candles.push(createCandle(33, 105.5, 105.5, 99.0, 99.2));   // Breakeven bar (low: 99.0 <= 100.0)
    candles.push(createCandle(34, 99.2, 100.0, 99.0, 99.5));

    // Independent Sizing Calculation
    const initialCapital = 100000;
    const riskPercent = 0.01; // 1%
    const riskAmount = initialCapital * riskPercent; // $1,000
    const entryPrice = 100.0;
    const stopLoss = 95.0;
    const riskDistance = entryPrice - stopLoss; // 5.0
    const expectedQuantity = Math.floor(riskAmount / riskDistance); // Exactly 200 units

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
      initialCapital,
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
        autoDeriveTargets: true,
      },
      fillModel: FillModel.OHLC_PATH,
      ambiguityMode: SameCandleAmbiguityMode.CONSERVATIVE,
      slippageBps: 0,
      feeRate: 0.0004,
    });

    expect(fullStackResult.trades.length).toBe(1);
    const fsTrade = fullStackResult.trades[0];
    expect(fsTrade.positionSize).toBe(expectedQuantity);

    // 2. Run Direct ExecutionSimulator Pipeline using strictly independent quantity
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

    // Submit entry order at Bar 30 close using independent expectedQuantity
    const entryOrder = directSim.submitOrder({
      tradeId: 't_direct_1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      price: 100.0,
      quantity: expectedQuantity,
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

    // Update resting stop to breakeven via first-class API
    directSim.updateStopPrice(directLot.tradeId, directLot.entryPrice, 'TRAILING_STOP');

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
    expect(directTrade.positionSize).toBe(expectedQuantity);
    expect(fsTrade.entryPrice).toBe(directTrade.entryPrice);
    expect(fsTrade.exitPrice).toBe(directTrade.exitPrice);
    expect(fsTrade.exitReason).toBe(directTrade.exitReason);
    expect(fsTrade.grossPnL).toBe(directTrade.grossPnL);
    expect(fsTrade.netPnL).toBe(directTrade.netPnL);
    expect(fsTrade.realizedR).toBe(directTrade.realizedR);
    expect(fsTrade.positionSize).toBe(directTrade.positionSize);
  });

  // -------------------------------------------------------------------------
  // Test 2: Same-Candle Ambiguity & OHLC Path Trajectory (Bullish & Bearish)
  // -------------------------------------------------------------------------
  test('T02: Same-Candle Ambiguity Full-Stack Resolution for both LONG and SHORT positions', () => {
    // 30 warmup candles
    const baseCandles: ICandle[] = [];
    for (let i = 0; i < 30; i++) {
      baseCandles.push(createCandle(i, 100, 101, 99, 100));
    }
    baseCandles.push(createCandle(30, 100, 101, 99, 100)); // Signal bar
    baseCandles.push(createCandle(31, 100, 101, 99, 100)); // Entry bar

    // 1. Bullish Position - Conservative Ambiguous Candle (Open -> Low -> High -> Close)
    // Low leg visited first -> SL at 90 hits first
    const bullishConservativeCandle = createCandle(32, 100, 112, 88, 101);
    const resBullCons = BacktestSimulator.runSimulation({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      initialCapital: 100000,
      candles: [...baseCandles, bullishConservativeCandle],
      warmupBars: 30,
      minimumCandles: 30,
      strategyMode: 'SMC',
      strategyConfig: {
        deterministicSignals: [
          {
            id: 'sig_long_cons',
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
    expect(resBullCons.trades.length).toBe(1);
    expect(resBullCons.trades[0].exitReason).toBe(SignalState.SL_HIT);
    expect(resBullCons.trades[0].exitPrice).toBeCloseTo(90.0, 1);

    // 2. Bullish Position - Optimistic Ambiguous Candle (Open -> High -> Low -> Close)
    // High leg visited first -> TP1 at 110 hits first
    const bullishOptimisticCandle = createCandle(32, 100, 112, 88, 99);
    const resBullOpt = BacktestSimulator.runSimulation({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      initialCapital: 100000,
      candles: [...baseCandles, bullishOptimisticCandle],
      warmupBars: 30,
      minimumCandles: 30,
      strategyMode: 'SMC',
      strategyConfig: {
        deterministicSignals: [
          {
            id: 'sig_long_opt',
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
    expect(resBullOpt.trades.length).toBe(1);
    expect(resBullOpt.trades[0].exitReason).toBe(SignalState.TP1_HIT);
    expect(resBullOpt.trades[0].exitPrice).toBeCloseTo(110.0, 1);

    // 3. Short Position - Conservative Ambiguous Candle (Open -> High -> Low -> Close)
    // High leg visited first -> SL at 110 hits first for short
    const shortConservativeCandle = createCandle(32, 100, 112, 88, 99);
    const resShortCons = BacktestSimulator.runSimulation({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      initialCapital: 100000,
      candles: [...baseCandles, shortConservativeCandle],
      warmupBars: 30,
      minimumCandles: 30,
      strategyMode: 'SMC',
      strategyConfig: {
        deterministicSignals: [
          {
            id: 'sig_short_cons',
            direction: 'BEARISH',
            score: 85,
            entryPrice: 100.0,
            stopLoss: 110.0,
            tp1: 90.0,
          },
        ],
      },
      ambiguityMode: SameCandleAmbiguityMode.CONSERVATIVE,
      fillModel: FillModel.OHLC_PATH,
      slippageBps: 0,
    });
    expect(resShortCons.trades.length).toBe(1);
    expect(resShortCons.trades[0].exitReason).toBe(SignalState.SL_HIT);
    expect(resShortCons.trades[0].exitPrice).toBeCloseTo(110.0, 1);

    // 4. Short Position - Optimistic Ambiguous Candle (Open -> Low -> High -> Close)
    // Low leg visited first -> TP1 at 90 hits first for short
    const shortOptimisticCandle = createCandle(32, 100, 112, 88, 101);
    const resShortOpt = BacktestSimulator.runSimulation({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      initialCapital: 100000,
      candles: [...baseCandles, shortOptimisticCandle],
      warmupBars: 30,
      minimumCandles: 30,
      strategyMode: 'SMC',
      strategyConfig: {
        deterministicSignals: [
          {
            id: 'sig_short_opt',
            direction: 'BEARISH',
            score: 85,
            entryPrice: 100.0,
            stopLoss: 110.0,
            tp1: 90.0,
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
    expect(resShortOpt.trades.length).toBe(1);
    expect(resShortOpt.trades[0].exitReason).toBe(SignalState.TP1_HIT);
    expect(resShortOpt.trades[0].exitPrice).toBeCloseTo(90.0, 1);

    // 5. Direct Segment Conflict Tie-Breaker
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

    const consResolution = FillModelEngine.resolveSegmentConflict(triggeredOrders, 100, 120, SameCandleAmbiguityMode.CONSERVATIVE);
    expect(consResolution.winningOrder?.orderType).toBe('STOP');
    expect(consResolution.reason).toBe('CONSERVATIVE_STOP_FIRST');

    const optResolution = FillModelEngine.resolveSegmentConflict(triggeredOrders, 100, 120, SameCandleAmbiguityMode.OPTIMISTIC);
    expect(optResolution.winningOrder?.orderType).toBe('LIMIT');
    expect(optResolution.reason).toBe('OPTIMISTIC_TARGET_FIRST');
  });

  // -------------------------------------------------------------------------
  // Test 3: Fail-Closed Invalid Risk Configuration & Explicit TP Policy
  // -------------------------------------------------------------------------
  test('T03: Fail-Closed Invalid Risk Configuration & Explicit TP Policy', () => {
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

    // 4. Inverted Stop Loss relative to execution price throws INVALID_POSITION_PROTECTION
    expect(() =>
      TradeLifecycleManager.createPositionLot({ ...validSignal, stopLoss: 105 }, 100, 10, t0),
    ).toThrow('INVALID_POSITION_PROTECTION');

    expect(() =>
      TradeLifecycleManager.createPositionLot(
        { ...validSignal, direction: Direction.BEARISH, stopLoss: 95 },
        100,
        10,
        t0,
      ),
    ).toThrow('INVALID_POSITION_PROTECTION');

    // 5. Missing Take-Profit with autoDeriveTargets = false throws INVALID_SIGNAL_TAKE_PROFIT
    const policyNoDerive = { ...DEFAULT_PARTIAL_EXIT_POLICY, autoDeriveTargets: false };
    expect(() =>
      TradeLifecycleManager.createPositionLot(
        { ...validSignal, stopLoss: 95, takeProfits: undefined as any },
        100,
        10,
        t0,
        undefined,
        0,
        0,
        policyNoDerive,
      ),
    ).toThrow('INVALID_SIGNAL_TAKE_PROFIT');

    // 6. Missing Take-Profit with autoDeriveTargets = true succeeds cleanly
    const policyWithDerive = { ...DEFAULT_PARTIAL_EXIT_POLICY, autoDeriveTargets: true };
    const derivedLot = TradeLifecycleManager.createPositionLot(
      { ...validSignal, stopLoss: 95, takeProfits: undefined as any },
      100,
      10,
      t0,
      undefined,
      0,
      0,
      policyWithDerive,
    );
    expect(derivedLot.tp1).toBe(107.5); // 100 + 5 * 1.5
    expect(derivedLot.tp2).toBe(112.5); // 100 + 5 * 2.5
    expect(derivedLot.tp3).toBe(120.0); // 100 + 5 * 4.0
  });

  // -------------------------------------------------------------------------
  // Test 4: Direction Normalization & PositionSide Domain Typing
  // -------------------------------------------------------------------------
  test('T04: Direction Normalization & PositionSide Domain Typing', () => {
    expect(normalizeDirection(Direction.BULLISH)).toBe(PositionSide.LONG);
    expect(normalizeDirection('LONG')).toBe(PositionSide.LONG);
    expect(normalizeDirection('bullish')).toBe(PositionSide.LONG);

    expect(normalizeDirection(Direction.BEARISH)).toBe(PositionSide.SHORT);
    expect(normalizeDirection('SHORT')).toBe(PositionSide.SHORT);
    expect(normalizeDirection('bearish')).toBe(PositionSide.SHORT);

    // BUY and SELL are order actions, not position directions
    expect(normalizeDirection('BUY')).toBe('NEUTRAL');
    expect(normalizeDirection('SELL')).toBe('NEUTRAL');
    expect(normalizeDirection(Direction.NEUTRAL)).toBe('NEUTRAL');
    expect(normalizeDirection(undefined)).toBe('NEUTRAL');

    // toOrderSide mapping
    expect(toOrderSide(PositionSide.LONG, 'ENTRY')).toBe('BUY');
    expect(toOrderSide(PositionSide.LONG, 'EXIT')).toBe('SELL');
    expect(toOrderSide(PositionSide.SHORT, 'ENTRY')).toBe('SELL');
    expect(toOrderSide(PositionSide.SHORT, 'EXIT')).toBe('BUY');

    expect(isLongPosition(Direction.BULLISH)).toBe(true);
    expect(isLongPosition('LONG')).toBe(true);
    expect(isLongPosition('SHORT')).toBe(false);
    expect(isLongPosition(Direction.BEARISH)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 5: Cash vs Equity Accounting Invariants
  // -------------------------------------------------------------------------
  test('T05: Cash vs Equity Accounting Invariants during active position lifecycle', () => {
    const candles: ICandle[] = [];
    for (let i = 0; i < 30; i++) {
      candles.push(createCandle(i, 100.0, 100.5, 99.5, 100.0));
    }
    candles.push(createCandle(30, 100.0, 100.5, 99.5, 100.0)); // Bar 30 Signal
    candles.push(createCandle(31, 100.0, 102.0, 99.5, 102.0)); // Bar 31 Entry fills at 100.0, close at 102.0 (unrealized profit)
    candles.push(createCandle(32, 102.0, 104.0, 101.0, 104.0)); // Bar 32 Position remains open, close at 104.0
    candles.push(createCandle(33, 104.0, 112.0, 103.0, 111.0)); // Bar 33 Hits full TP at 110.0 -> Closes

    const res = BacktestSimulator.runSimulation({
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
            id: 'sig_equity_inv',
            direction: 'BULLISH',
            score: 85,
            entryPrice: 100.0,
            stopLoss: 95.0,
            tp1: 110.0,
          },
        ],
      },
      partialExitPolicy: {
        tp1Ratio: 1.0,
        tp2Ratio: 0.0,
        tp3Ratio: 0.0,
        moveStopToBreakevenOnTp1: false,
        trailStopOnTp2: false,
      },
      fillModel: FillModel.OHLC_PATH,
      slippageBps: 0,
      feeRate: 0.0004,
    });

    expect(res.trades.length).toBe(1);
    const trade = res.trades[0];

    // Final cash and equity must reconcile with realized net PnL exactly
    expect(res.finalEquity).toBeCloseTo(res.initialCapital + res.netPnL, 2);
  });
});
