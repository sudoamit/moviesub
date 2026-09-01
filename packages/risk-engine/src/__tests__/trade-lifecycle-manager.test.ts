import { TradeLifecycleManager } from '../trade-lifecycle-manager';
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
});
