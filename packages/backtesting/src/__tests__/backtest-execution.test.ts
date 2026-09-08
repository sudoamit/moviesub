import { Direction, ICandle, SignalGrade, SignalState } from '@quant/shared';
import { TradeLifecycleManager } from '@quant/risk-engine';
import { FeeModel, SlippageModel, SpreadModel } from '../execution';
import { MarketDataRouter } from '../market-data-router';

describe('Backtest Execution & Accounting Hardening', () => {
  const baseTime = 1756972800000;

  describe('Slippage & Spread Direction', () => {
    it('should apply adverse slippage to BUY (higher) and SELL (lower) market orders', () => {
      const price = 100;
      const qty = 10;

      const buySlip = SlippageModel.calculateSlippage(price, qty, 'BUY', 'MARKET');
      const sellSlip = SlippageModel.calculateSlippage(price, qty, 'SELL', 'MARKET');

      expect(buySlip.executedPrice).toBeGreaterThan(price);
      expect(sellSlip.executedPrice).toBeLessThan(price);
    });

    it('should add spread half-cost adversely to execution price', () => {
      const price = 100;
      const halfSpread = SpreadModel.getHalfSpread(price, 'BTCUSDT');
      expect(halfSpread).toBeGreaterThan(0);
    });
  });

  describe('Gap Execution Handling', () => {
    it('should execute Long SL at gap-down open price when market gaps below stop loss', () => {
      const lot = TradeLifecycleManager.createPositionLot(
        {
          id: 'sig_1',
          symbol: 'NIFTY',
          direction: Direction.BULLISH,
          state: SignalState.ACTIVE,
          score: 80,
          grade: SignalGrade.A_PLUS,
          timeframe: '15m',
          timestamp: new Date(baseTime),
          entryZone: { min: 100, max: 102, optimal: 100 },
          stopLoss: 95,
          takeProfits: { tp1: 105, tp2: 110, tp3: 120 },
          riskRewardRatios: { rr1: 1.5, rr2: 2.5, rr3: 4.0 },
          reasoning: {
            htfStructure: 'Bullish',
            liquidityReason: 'Sweep',
            triggerReason: 'BOS',
            invalidationReason: 'SL',
            confirmedChecklist: [],
            summary: 'Ok',
          },
          scoreBreakdown: {
            htfBias: 10,
            liquiditySweep: 10,
            bos: 10,
            fvg: 10,
            orderBlock: 10,
            displacement: 10,
            volumeConfirmation: 10,
            premiumDiscount: 10,
            riskReward: 10,
            indicatorAlignment: 10,
            totalScore: 100,
            grade: SignalGrade.A_PLUS,
          },
        },
        100,
        10,
        baseTime,
      );

      // Gap down candle opening at 90 (below SL of 95)
      const gapCandle: ICandle = {
        timestamp: new Date(baseTime + 15 * 60 * 1000),
        open: 90,
        high: 91,
        low: 88,
        close: 89,
        volume: 2000,
      };

      const result = TradeLifecycleManager.evaluateLotTick(lot, gapCandle);

      expect(result.isClosed).toBe(true);
      expect(result.state).toBe(SignalState.SL_HIT);
      // The exit price MUST be 90 (the gap open price), not 95!
      const lastFill = result.lot.partialFills[result.lot.partialFills.length - 1];
      expect(lastFill.price).toBe(90);
    });

    it('should execute Long TP at gap-up open price when market gaps above target', () => {
      const lot = TradeLifecycleManager.createPositionLot(
        {
          id: 'sig_2',
          symbol: 'NIFTY',
          direction: Direction.BULLISH,
          state: SignalState.ACTIVE,
          score: 80,
          grade: SignalGrade.A_PLUS,
          timeframe: '15m',
          timestamp: new Date(baseTime),
          entryZone: { min: 100, max: 102, optimal: 100 },
          stopLoss: 95,
          takeProfits: { tp1: 105, tp2: 110, tp3: 120 },
          riskRewardRatios: { rr1: 1.5, rr2: 2.5, rr3: 4.0 },
          reasoning: {
            htfStructure: 'Bullish',
            liquidityReason: 'Sweep',
            triggerReason: 'BOS',
            invalidationReason: 'SL',
            confirmedChecklist: [],
            summary: 'Ok',
          },
          scoreBreakdown: {
            htfBias: 10,
            liquiditySweep: 10,
            bos: 10,
            fvg: 10,
            orderBlock: 10,
            displacement: 10,
            volumeConfirmation: 10,
            premiumDiscount: 10,
            riskReward: 10,
            indicatorAlignment: 10,
            totalScore: 100,
            grade: SignalGrade.A_PLUS,
          },
        },
        100,
        10,
        baseTime,
      );

      // Gap up candle opening at 125 (above TP3 of 120)
      const gapUpCandle: ICandle = {
        timestamp: new Date(baseTime + 15 * 60 * 1000),
        open: 125,
        high: 130,
        low: 124,
        close: 128,
        volume: 2000,
      };

      const result = TradeLifecycleManager.evaluateLotTick(lot, gapUpCandle);

      expect(result.isClosed).toBe(true);
      expect(result.state).toBe(SignalState.TP3_HIT);
      // The exit price MUST be 125 (the gap open price), not 120!
      const lastFill = result.lot.partialFills[result.lot.partialFills.length - 1];
      expect(lastFill.price).toBe(125);
    });
  });

  describe('Fee Model Accounting', () => {
    it('should calculate non-zero transaction fees for Crypto, Gold, and Indian Equity', () => {
      const cryptoFee = FeeModel.calculateFees('BTCUSDT', 50000, 1, 'BUY', false);
      const goldFee = FeeModel.calculateFees('XAUUSD', 2000, 5, 'BUY', false);
      const nseFee = FeeModel.calculateFees('RELIANCE', 2500, 100, 'SELL', false);

      expect(cryptoFee).toBeGreaterThan(0);
      expect(goldFee).toBeGreaterThan(0);
      expect(nseFee).toBeGreaterThan(0);
    });
  });

  describe('Multi-Timeframe Data Router', () => {
    it('should strictly exclude unclosed HTF candles', () => {
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
