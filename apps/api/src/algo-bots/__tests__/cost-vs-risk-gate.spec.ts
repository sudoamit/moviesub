import { Direction, SignalGrade, SignalState, TradeDecisionType } from '@quant/shared';
import { TradeDecisionService } from '../trade-decision.service';

/**
 * Gate 13.5: a trade whose estimated round-trip fees exceed 0.5R of planned risk is fee-negative and must be
 * rejected (COST_EXCEEDS_EDGE). BTC spot fees are ~0.1% per side; the old Saiyan BTC stop of 120 points at
 * ~83,000 made fees ~1.4R per trade.
 */
describe('Cost-vs-risk gate (COST_EXCEEDS_EDGE)', () => {
  const service = new TradeDecisionService({} as any);
  const nowMs = Date.now();

  const bot: any = {
    id: 'bot_cost_gate',
    symbol: 'BTCUSDT_SPOT',
    strategy: 'SMC',
    direction: 'BULLISH',
    timeframe: '15m',
    minScore: 70,
    smcCondition: 'ANY_CONFLUENCE',
    lots: 100, // 0.01 BTC
    autoExecutePaper: true,
    isActive: true,
  };

  const signal = (stopLoss: number): any => ({
    id: `sig_cost_${stopLoss}`,
    symbol: 'BTCUSDT_SPOT',
    strategy: 'SMC',
    strategyMode: 'SMC',
    timeframe: '15m',
    direction: Direction.BULLISH,
    state: SignalState.ACTIVE,
    grade: SignalGrade.A_PLUS,
    score: 90,
    canonicalCandleTime: nowMs,
    canonicalDecisionTime: new Date(nowMs),
    entryZone: { min: 82990, max: 83010, optimal: 83000 },
    stopLoss,
    takeProfits: { tp1: 83000 + (83000 - stopLoss) * 1.5, tp2: 83000 + (83000 - stopLoss) * 2.5, tp3: 83000 + (83000 - stopLoss) * 4 },
    riskRewardRatios: { rr1: 1.5, rr2: 2.5, rr3: 4 },
    reasoning: { summary: 'cost gate' },
    scoreBreakdown: { totalScore: 90 },
    triggerEvidence: {
      orderBlock: { matched: true, timestamp: new Date(nowMs - 60000) },
      fvg: { matched: true, timestamp: new Date(nowMs - 60000) },
      liquiditySweep: { matched: true, timestamp: new Date(nowMs - 60000) },
      structureBreak: { matched: true, timestamp: new Date(nowMs - 60000) },
    },
    timestamp: new Date(nowMs),
  });

  const evaluate = (stopLoss: number) =>
    service.evaluatePreTradeDecision({
      bot,
      signal: signal(stopLoss),
      portfolio: { accountId: 'acc', initialCapital: 10000000, cashBalance: 10000000, availableMargin: 10000000, openPositions: [] } as any,
      liveQuote: { symbol: 'BTCUSDT_SPOT', price: 83000, timestamp: new Date() } as any,
    } as any);

  it('rejects a tight 120-point BTC stop: round-trip fees ~1.4R', () => {
    const res = evaluate(82880);
    expect(res.decision).toBe(TradeDecisionType.REJECT);
    expect(res.decisionReasonCode).toBe('COST_EXCEEDS_EDGE');
  });

  it('accepts a 0.5% BTC stop: round-trip fees ~0.4R', () => {
    const res = evaluate(83000 * 0.995);
    expect(res.decisionReasonCode).not.toBe('COST_EXCEEDS_EDGE');
    expect(res.decision).toBe(TradeDecisionType.TAKE);
  });
});
