import {
  Direction,
  ICandle,
  PositionSide,
} from '@quant/shared';
import {
  ExecutionSimulator,
  FillModel,
  SameCandleAmbiguityMode,
  IOrder,
  IFill,
} from '../execution';

describe('Execution Risk Drift & Non-Positive Risk Defense Tests (AI Fix 79 & 80)', () => {
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

  // -------------------------------------------------------------------------
  // 1. LONG Directional Risk Drift Tests
  // -------------------------------------------------------------------------
  describe('LONG Position Risk Drift', () => {
    test('rejects adverse risk drift exceeding maxRiskDrift', () => {
      const execSim = new ExecutionSimulator(
        FillModel.NEXT_BAR_MARKET,
        SameCandleAmbiguityMode.CONSERVATIVE,
        { submissionLatencyMs: 0, processingLatencyMs: 0 },
        'test_long_drift',
        zeroSlippage,
      );

      const order = execSim.submitOrder({
        tradeId: 'trade_long_drift_1',
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: PositionSide.LONG,
        orderType: 'MARKET',
        quantity: 10,
        timestamp: t0,
        referencePrice: 100,
        stopLoss: 90, // initial risk = 10
        maxRiskDrift: 0.25, // max allowed drift = 2.5
        exitTarget: 'ENTRY',
      });

      // Gap open at 105 -> actual risk = 15, drift = (15 - 10)/10 = +50% > 25%
      const candle = createCandle(1, 105, 106, 104, 105);
      const result = execSim.processSingleExecutionBar(candle);

      expect(order.status).toBe('REJECTED');
      expect(order.rejectionReason).toContain('REJECTED_EXCESSIVE_RISK_DRIFT');
      expect(result.fills.length).toBe(0);
      expect(result.events.length).toBe(1);
      expect(result.events[0].eventType).toBe('ORDER_REJECTED');
    });

    test('accepts favorable price improvement without rejection', () => {
      const execSim = new ExecutionSimulator(
        FillModel.NEXT_BAR_MARKET,
        SameCandleAmbiguityMode.CONSERVATIVE,
        { submissionLatencyMs: 0, processingLatencyMs: 0 },
        'test_long_fav',
        zeroSlippage,
      );

      const order = execSim.submitOrder({
        tradeId: 'trade_long_fav_1',
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: PositionSide.LONG,
        orderType: 'MARKET',
        quantity: 10,
        timestamp: t0,
        referencePrice: 100,
        stopLoss: 90, // initial risk = 10
        maxRiskDrift: 0.25,
        exitTarget: 'ENTRY',
      });

      // Favorable open at 98 -> actual risk = 8, drift = (8 - 10)/10 = -20% <= 25%
      const candle = createCandle(1, 98, 99, 97, 98);
      const result = execSim.processSingleExecutionBar(candle);

      expect(order.status).toBe('FILLED');
      expect(result.fills.length).toBe(1);
      expect(result.fills[0].price).toBeCloseTo(98.0, 1);
    });

    test('defense-in-depth: rejects non-positive actual risk (gap below stop)', () => {
      const execSim = new ExecutionSimulator(
        FillModel.NEXT_BAR_MARKET,
        SameCandleAmbiguityMode.CONSERVATIVE,
        { submissionLatencyMs: 0, processingLatencyMs: 0 },
        'test_long_neg_risk',
        zeroSlippage,
      );

      const order = execSim.submitOrder({
        tradeId: 'trade_long_neg_1',
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: PositionSide.LONG,
        orderType: 'MARKET',
        quantity: 10,
        timestamp: t0,
        referencePrice: 100,
        stopLoss: 90,
        maxRiskDrift: 0.25,
        exitTarget: 'ENTRY',
      });

      // Gap open at 88 (below stop loss 90) -> actualRisk = -2 <= 0
      const candle = createCandle(1, 88, 89, 87, 88);
      const result = execSim.processSingleExecutionBar(candle);

      expect(order.status).toBe('REJECTED');
      expect(order.rejectionReason).toContain('REJECTED_GAP_THROUGH_STOP');
      expect(result.fills.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 2. SHORT Directional Risk Drift Tests
  // -------------------------------------------------------------------------
  describe('SHORT Position Risk Drift', () => {
    test('rejects adverse risk drift exceeding maxRiskDrift', () => {
      const execSim = new ExecutionSimulator(
        FillModel.NEXT_BAR_MARKET,
        SameCandleAmbiguityMode.CONSERVATIVE,
        { submissionLatencyMs: 0, processingLatencyMs: 0 },
        'test_short_drift',
        zeroSlippage,
      );

      const order = execSim.submitOrder({
        tradeId: 'trade_short_drift_1',
        symbol: 'BTCUSDT',
        side: 'SELL',
        positionSide: PositionSide.SHORT,
        orderType: 'MARKET',
        quantity: 10,
        timestamp: t0,
        referencePrice: 100,
        stopLoss: 110, // initial risk = 10
        maxRiskDrift: 0.25,
        exitTarget: 'ENTRY',
      });

      // Gap open at 95 -> for SHORT, actual risk = 110 - 95 = 15, drift = +50% > 25%
      const candle = createCandle(1, 95, 96, 94, 95);
      const result = execSim.processSingleExecutionBar(candle);

      expect(order.status).toBe('REJECTED');
      expect(order.rejectionReason).toContain('REJECTED_EXCESSIVE_RISK_DRIFT');
      expect(result.fills.length).toBe(0);
    });

    test('accepts favorable price improvement without rejection', () => {
      const execSim = new ExecutionSimulator(
        FillModel.NEXT_BAR_MARKET,
        SameCandleAmbiguityMode.CONSERVATIVE,
        { submissionLatencyMs: 0, processingLatencyMs: 0 },
        'test_short_fav',
        zeroSlippage,
      );

      const order = execSim.submitOrder({
        tradeId: 'trade_short_fav_1',
        symbol: 'BTCUSDT',
        side: 'SELL',
        positionSide: PositionSide.SHORT,
        orderType: 'MARKET',
        quantity: 10,
        timestamp: t0,
        referencePrice: 100,
        stopLoss: 110, // initial risk = 10
        maxRiskDrift: 0.25,
        exitTarget: 'ENTRY',
      });

      // Favorable open at 102 -> for SHORT, actual risk = 110 - 102 = 8, drift = -20% <= 25%
      const candle = createCandle(1, 102, 103, 101, 102);
      const result = execSim.processSingleExecutionBar(candle);

      expect(order.status).toBe('FILLED');
      expect(result.fills.length).toBe(1);
      expect(result.fills[0].price).toBeCloseTo(102.0, 1);
    });

    test('defense-in-depth: rejects non-positive actual risk (gap above stop)', () => {
      const execSim = new ExecutionSimulator(
        FillModel.NEXT_BAR_MARKET,
        SameCandleAmbiguityMode.CONSERVATIVE,
        { submissionLatencyMs: 0, processingLatencyMs: 0 },
        'test_short_neg_risk',
        zeroSlippage,
      );

      const order = execSim.submitOrder({
        tradeId: 'trade_short_neg_1',
        symbol: 'BTCUSDT',
        side: 'SELL',
        positionSide: PositionSide.SHORT,
        orderType: 'MARKET',
        quantity: 10,
        timestamp: t0,
        referencePrice: 100,
        stopLoss: 110,
        maxRiskDrift: 0.25,
        exitTarget: 'ENTRY',
      });

      // Gap open at 112 (above stop loss 110) -> actualRisk = 110 - 112 = -2 <= 0
      const candle = createCandle(1, 112, 113, 111, 112);
      const result = execSim.processSingleExecutionBar(candle);

      expect(order.status).toBe('REJECTED');
      expect(order.rejectionReason).toContain('REJECTED_GAP_THROUGH_STOP');
      expect(result.fills.length).toBe(0);
    });
  });
});
