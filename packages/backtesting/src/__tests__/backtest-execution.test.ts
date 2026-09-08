import { Direction, ICandle, SignalGrade, SignalState } from '@quant/shared';
import { TradeLifecycleManager } from '@quant/risk-engine';
import {
  ExecutionSimulator,
  FeeModel,
  FillModel,
  FillModelEngine,
  SameCandleAmbiguityMode,
  SlippageModel,
  SpreadModel,
} from '../execution';
import { MarketDataRouter } from '../market-data-router';

describe('Backtest Execution & Accounting Hardening', () => {
  const baseTime = 1756972800000;

  describe('Fill Models & Authoritative ExecutionSimulator', () => {
    it('NEXT_BAR_MARKET: Fills on next candle open price with spread and slippage', () => {
      const exec = new ExecutionSimulator(FillModel.NEXT_BAR_MARKET);
      const order = exec.submitOrder({
        tradeId: 't1',
        symbol: 'BTCUSDT',
        side: 'BUY',
        orderType: 'MARKET',
        quantity: 1,
        timestamp: baseTime,
      });

      const currentCandle: ICandle = {
        timestamp: new Date(baseTime),
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 100,
      };

      const nextCandle: ICandle = {
        timestamp: new Date(baseTime + 15 * 60 * 1000),
        open: 105,
        high: 108,
        low: 104,
        close: 107,
        volume: 100,
      };

      // Process current candle (should NOT fill on same candle open when NEXT_BAR_MARKET)
      const res1 = exec.processCandle(currentCandle, nextCandle);
      expect(res1.fills.length).toBe(1);
      expect(res1.fills[0].price).toBeGreaterThanOrEqual(105);
    });

    it('LIMIT_TOUCH: Fills when candle touches target limit price', () => {
      const order = {
        orderId: 'o1',
        clientOrderId: 'c1',
        tradeId: 't1',
        symbol: 'NIFTY',
        side: 'BUY' as const,
        orderType: 'LIMIT' as const,
        price: 100,
        quantity: 10,
        remainingQuantity: 10,
        status: 'PENDING' as const,
        createdAt: baseTime,
        submittedAt: baseTime,
        fees: 0,
        slippage: 0,
      };

      const candleNoTouch: ICandle = {
        timestamp: new Date(baseTime),
        open: 105,
        high: 110,
        low: 102,
        close: 108,
        volume: 100,
      };

      const resNoTouch = FillModelEngine.evaluateFill(order, candleNoTouch, undefined, FillModel.LIMIT_TOUCH);
      expect(resNoTouch.isFilled).toBe(false);

      const candleTouch: ICandle = {
        timestamp: new Date(baseTime + 15 * 60 * 1000),
        open: 105,
        high: 110,
        low: 98,
        close: 102,
        volume: 100,
      };

      const resTouch = FillModelEngine.evaluateFill(order, candleTouch, undefined, FillModel.LIMIT_TOUCH);
      expect(resTouch.isFilled).toBe(true);
      expect(resTouch.fill?.price).toBe(100);
    });

    it('LOWER_TIMEFRAME: Fails closed with MISSING_LOWER_TF_DATA when sub-bar candles are missing', () => {
      const order = {
        orderId: 'o2',
        clientOrderId: 'c2',
        tradeId: 't2',
        symbol: 'BTCUSDT',
        side: 'BUY' as const,
        orderType: 'LIMIT' as const,
        price: 100,
        quantity: 1,
        remainingQuantity: 1,
        status: 'PENDING' as const,
        createdAt: baseTime,
        submittedAt: baseTime,
        fees: 0,
        slippage: 0,
      };

      const candle: ICandle = {
        timestamp: new Date(baseTime),
        open: 105,
        high: 110,
        low: 95,
        close: 102,
        volume: 100,
      };

      const res = FillModelEngine.evaluateFill(order, candle, undefined, FillModel.LOWER_TIMEFRAME, []);
      expect(res.isFilled).toBe(false);
      expect(res.reason).toBe('MISSING_LOWER_TF_DATA');
    });
  });

  describe('Gap Execution & Slippage Direction', () => {
    it('should apply adverse slippage to BUY (higher) and SELL (lower) market orders', () => {
      const price = 100;
      const qty = 10;

      const buySlip = SlippageModel.calculateSlippage(price, qty, 'BUY', 'MARKET');
      const sellSlip = SlippageModel.calculateSlippage(price, qty, 'SELL', 'MARKET');

      expect(buySlip.executedPrice).toBeGreaterThan(price);
      expect(sellSlip.executedPrice).toBeLessThan(price);
    });

    it('should execute STOP orders at gap-down open price when market gaps past stop loss', () => {
      const order = {
        orderId: 'o_stop1',
        clientOrderId: 'c_stop1',
        tradeId: 't_stop1',
        symbol: 'NIFTY',
        side: 'SELL' as const,
        orderType: 'STOP' as const,
        stopPrice: 95,
        quantity: 10,
        remainingQuantity: 10,
        status: 'PENDING' as const,
        createdAt: baseTime,
        submittedAt: baseTime,
        fees: 0,
        slippage: 0,
      };

      // Gap down candle opening at 90 (below stop loss of 95)
      const gapCandle: ICandle = {
        timestamp: new Date(baseTime + 15 * 60 * 1000),
        open: 90,
        high: 91,
        low: 88,
        close: 89,
        volume: 2000,
      };

      const res = FillModelEngine.evaluateFill(order, gapCandle, undefined, FillModel.OHLC_PATH);
      expect(res.isFilled).toBe(true);
      // The executed fill price MUST be <= 90 (gap open minus adverse spread/slippage), not 95!
      expect(res.fill?.price).toBeLessThanOrEqual(90);
    });
  });

  describe('Deterministic ID Replay', () => {
    it('should generate identical, reproducible sequence IDs across independent runs', () => {
      const sim1 = new ExecutionSimulator(FillModel.NEXT_BAR_MARKET, SameCandleAmbiguityMode.CONSERVATIVE, { submissionLatencyMs: 0, processingLatencyMs: 0 }, 'run1');
      const sim2 = new ExecutionSimulator(FillModel.NEXT_BAR_MARKET, SameCandleAmbiguityMode.CONSERVATIVE, { submissionLatencyMs: 0, processingLatencyMs: 0 }, 'run1');

      const o1 = sim1.submitOrder({ tradeId: 't1', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quantity: 1, timestamp: baseTime });
      const o2 = sim2.submitOrder({ tradeId: 't1', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quantity: 1, timestamp: baseTime });

      expect(o1.orderId).toBe(o2.orderId);
      expect(o1.clientOrderId).toBe(o2.clientOrderId);
    });
  });

  describe('Multi-Timeframe Data Router & Strict Isolation', () => {
    it('should strictly exclude unclosed HTF candles and return empty htfSlice', () => {
      const router = new MarketDataRouter({
        executionCandles: [
          { timestamp: new Date(baseTime), open: 100, high: 101, low: 99, close: 100, volume: 100 },
          {
            timestamp: new Date(baseTime + 15 * 60 * 1000),
            open: 100,
            high: 102,
            low: 99,
            close: 101,
            volume: 100,
          },
        ],
        htf1Candles: [
          {
            timestamp: new Date(baseTime),
            open: 100,
            high: 105,
            low: 98,
            close: 104,
            volume: 1000,
          },
        ],
        executionTimeframe: '15m',
        htf1Timeframe: '1h',
      });

      // At 10:15 (index 1), the 10:00-11:00 1h candle is NOT closed yet!
      const data = router.getAvailableMarketDataAt(1);
      expect(data.htf1Slice.length).toBe(0);
    });
  });
});
