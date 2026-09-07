import { TradeLifecycleManager, DEFAULT_PARTIAL_EXIT_POLICY } from '../trade-lifecycle-manager';
import { Direction, ISignalSetup, SignalGrade, SignalState, Timeframe } from '@quant/shared';

describe('TradeLifecycleManager', () => {
  const signal: ISignalSetup = {
    id: 'sig-1',
    symbol: 'NIFTY',
    direction: Direction.BULLISH,
    timeframe: Timeframe.M15,
    state: SignalState.PENDING,
    grade: SignalGrade.A_PLUS,
    score: 90,
    entryZone: { min: 25000, max: 25050, optimal: 25025 },
    stopLoss: 24900,
    takeProfits: { tp1: 25212.5, tp2: 25337.5, tp3: 25525 },
    riskRewardRatios: { rr1: 1.5, rr2: 2.5, rr3: 4.0 },
    reasoning: {
      htfStructure: 'Bullish',
      liquidityReason: 'SSL swept',
      triggerReason: 'FVG tap',
      invalidationReason: 'SL below 24900',
      confirmedChecklist: ['HTF', 'FVG'],
      summary: 'Long setup',
    },
    scoreBreakdown: {
      htfBias: 20,
      liquiditySweep: 15,
      bos: 15,
      fvg: 7,
      orderBlock: 8,
      displacement: 10,
      premiumDiscount: 10,
      volumeConfirmation: 5,
      riskReward: 5,
      indicatorAlignment: 5,
      totalScore: 90,
      grade: SignalGrade.A_PLUS,
    },
    timestamp: new Date(),
  };

  it('should activate a pending signal when price enters entry zone', () => {
    const tickCandle = {
      timestamp: new Date(),
      open: 25030,
      high: 25040,
      low: 25020,
      close: 25025,
      volume: 1000,
    };

    const update = TradeLifecycleManager.evaluateTick(signal, tickCandle);
    expect(update.newState).toBe(SignalState.ACTIVE);
    expect(update.isClosed).toBe(false);
  });

  it('should trigger SL_HIT when price drops below stop loss', () => {
    const activeSignal = { ...signal, state: SignalState.ACTIVE };
    const tickCandle = {
      timestamp: new Date(),
      open: 24950,
      high: 24960,
      low: 24890,
      close: 24895,
      volume: 1000,
    };

    const update = TradeLifecycleManager.evaluateTick(activeSignal, tickCandle);
    expect(update.newState).toBe(SignalState.SL_HIT);
    expect(update.pnlRMultiple).toBe(-1.0);
    expect(update.isClosed).toBe(true);
  });

  it('should trigger TP1_HIT when price reaches Target 1', () => {
    const activeSignal = { ...signal, state: SignalState.ACTIVE };
    const tickCandle = {
      timestamp: new Date(),
      open: 25150,
      high: 25220,
      low: 25140,
      close: 25215,
      volume: 1000,
    };

    const update = TradeLifecycleManager.evaluateTick(activeSignal, tickCandle);
    expect(update.newState).toBe(SignalState.TP1_HIT);
    expect(update.pnlRMultiple).toBe(1.5);
    expect(update.isClosed).toBe(false);
  });

  describe('PositionLot Multi-Tier Lifecycle & Partial Scale-Out', () => {
    it('should create an immutable PositionLot with initial execution event', () => {
      const lot = TradeLifecycleManager.createPositionLot(signal, 25000, 100, 1756972800000);
      expect(lot.initialQuantity).toBe(100);
      expect(lot.remainingQuantity).toBe(100);
      expect(lot.status).toBe('OPEN');
      expect(lot.events.length).toBe(1);
      expect(lot.events[0].eventType).toBe('ENTRY_FILLED');
      expect(lot.partialFills.length).toBe(1);
    });

    it('should scale out 30% at TP1 and move stop loss to breakeven', () => {
      const lot = TradeLifecycleManager.createPositionLot(signal, 25000, 100, 1756972800000);
      const tp1Candle = {
        timestamp: new Date(1756973700000),
        open: 25100,
        high: 25220, // Breaches TP1 (25212.5)
        low: 25080,
        close: 25200,
        volume: 5000,
      };

      const res = TradeLifecycleManager.evaluateLotTick(
        lot,
        tp1Candle,
        DEFAULT_PARTIAL_EXIT_POLICY,
      );
      expect(res.isClosed).toBe(false);
      expect(res.lot.status).toBe('PARTIALLY_CLOSED');
      expect(res.lot.remainingQuantity).toBe(70); // 100 - 30 = 70
      expect(res.lot.currentStopLoss).toBe(25000); // Moved to Breakeven
      expect(res.lot.realizedPnl).toBeGreaterThan(0);
      expect(res.events.some((e) => e.eventType === 'TP1_FILLED')).toBe(true);
      expect(res.events.some((e) => e.eventType === 'STOP_MOVED')).toBe(true);
    });

    it('should track MAE and MFE correctly across ticks', () => {
      const lot = TradeLifecycleManager.createPositionLot(signal, 25000, 100, 1756972800000);
      const adverseCandle = {
        timestamp: new Date(1756973700000),
        open: 25000,
        high: 25080,
        low: 24940, // Adverse excursion of 60 points
        close: 25020,
        volume: 2000,
      };

      TradeLifecycleManager.evaluateLotTick(lot, adverseCandle);
      expect(lot.mae).toBe(60);
      expect(lot.mfe).toBe(80);
    });
  });
});
