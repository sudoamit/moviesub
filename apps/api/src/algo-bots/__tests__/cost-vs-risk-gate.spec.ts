import { Direction, getAuthoritativeDescriptor, SignalGrade, SignalState, TradeDecisionType, TransactionCostScheduleManager } from '@quant/shared';
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

  describe('BTCUSDT_PERP (futures, 0.05% fees, shorts allowed)', () => {
    const perpBot = { ...bot, id: 'bot_perp_gate', symbol: 'BTCUSDT_PERP', direction: 'ANY', lots: 10 };
    const bearish = (stopLoss: number): any => {
      const risk = stopLoss - 83000;
      return {
        ...signal(stopLoss),
        id: `sig_perp_${stopLoss}`,
        symbol: 'BTCUSDT_PERP',
        direction: Direction.BEARISH,
        takeProfits: { tp1: 83000 - risk * 1.5, tp2: 83000 - risk * 2.5, tp3: 83000 - risk * 4 },
      };
    };
    const evaluatePerp = (sig: any) =>
      service.evaluatePreTradeDecision({
        bot: perpBot,
        signal: sig,
        portfolio: { accountId: 'acc', initialCapital: 10000000, cashBalance: 10000000, availableMargin: 10000000, openPositions: [] } as any,
        liveQuote: { symbol: 'BTCUSDT_PERP', price: 83000, timestamp: new Date() } as any,
      } as any);

    it('takes a BEARISH perp signal at 5x (a spot short would be rejected)', () => {
      const res = evaluatePerp(bearish(83000 * 1.005));
      expect(res.decisionReasonCode).not.toBe('SPOT_SHORT_SELLING_FORBIDDEN');
      expect(res.decision).toBe(TradeDecisionType.TAKE);
      expect(res.plannedLevels?.leverage).toBe(5);
    });

    it('sizes by risk: 0.5% of capital lost at the stop, lots only a ceiling', () => {
      const riskBot = { ...perpBot, lots: 5000, riskPercentage: 0.5 };
      const res = service.evaluatePreTradeDecision({
        bot: riskBot,
        signal: bearish(83000 * 1.005),
        portfolio: { accountId: 'acc', initialCapital: 10000000, cashBalance: 10000000, availableMargin: 10000000, openPositions: [] } as any,
        liveQuote: { symbol: 'BTCUSDT_PERP', price: 83000, timestamp: new Date() } as any,
      } as any);
      expect(res.decision).toBe(TradeDecisionType.TAKE);
      const qty = res.plannedLevels!.quantity;
      const riskInr = res.plannedLevels!.riskAmount;
      // ~₹50,000 at risk (floored to 0.001 BTC), i.e. roughly 1.3 BTC for a 415-point stop
      expect(riskInr).toBeLessThanOrEqual(50000);
      expect(riskInr).toBeGreaterThan(49000);
      expect(qty).toBeGreaterThan(1);
      expect(Number((qty / 0.001).toFixed(6)) % 1).toBe(0);
    });

    it('a 0.25% stop passes the cost gate on futures fees (~0.4R) that would fail on spot fees (~0.8R)', () => {
      const res = evaluatePerp(bearish(83000 * 1.0025));
      expect(res.decisionReasonCode).not.toBe('COST_EXCEEDS_EDGE');
    });
  });

  describe('chased entry (live price has moved away from the planned entry)', () => {
    const perpBot = { ...bot, id: 'bot_perp_chase', symbol: 'BTCUSDT_PERP', direction: 'ANY', lots: 5000, riskPercentage: 0.5 };
    // The screenshot setup: short planned at 84,226.90, stop 84,645.98, TP1 83,388.74
    const shortSignal: any = {
      ...signal(84645.98),
      id: 'sig_perp_chase',
      symbol: 'BTCUSDT_PERP',
      direction: Direction.BEARISH,
      entryZone: { min: 84033.6, max: 84420.2, optimal: 84226.9 },
      stopLoss: 84645.98,
      takeProfits: { tp1: 83388.74, tp2: 82760.12, tp3: 81712.42 },
    };
    const evaluateAt = (live: number) =>
      service.evaluatePreTradeDecision({
        bot: perpBot,
        signal: shortSignal,
        portfolio: { accountId: 'acc', initialCapital: 10000000, cashBalance: 10000000, availableMargin: 10000000, openPositions: [] } as any,
        liveQuote: { symbol: 'BTCUSDT_PERP', price: live, timestamp: new Date() } as any,
      } as any);

    it('rejects when price already ran toward TP1 (TP1 pays ~0.4R from 83,745)', () => {
      const res = evaluateAt(83745.26);
      expect(res.decision).toBe(TradeDecisionType.REJECT);
      expect(JSON.stringify(res)).toContain('ENTRY_MISSED_RR_DEGRADED');
    });

    it('takes it near the planned entry and sizes risk from the live price', () => {
      const live = 84200;
      const res = evaluateAt(live);
      expect(res.decision).toBe(TradeDecisionType.TAKE);
      const fx = res.plannedLevels!.fxRate!;
      const riskFromLive = res.plannedLevels!.quantity * (84645.98 - live) * fx;
      expect(riskFromLive).toBeLessThanOrEqual(50000.01);
      expect(riskFromLive).toBeGreaterThan(49000);
    });
  });

  describe('bot leverage on the perpetual', () => {
    const levBot = (leverage: number) => ({
      ...bot, id: `bot_perp_lev_${leverage}`, symbol: 'BTCUSDT_PERP', direction: 'ANY', lots: 5000, riskPercentage: 0.5, leverage,
    });
    const short = (stopPct: number): any => {
      const sl = 83000 * (1 + stopPct);
      const risk = sl - 83000;
      return {
        ...signal(sl), id: `sig_lev_${stopPct}`, symbol: 'BTCUSDT_PERP', direction: Direction.BEARISH,
        takeProfits: { tp1: 83000 - risk * 1.5, tp2: 83000 - risk * 2.5, tp3: 83000 - risk * 4 },
      };
    };
    const run = (b: any, sig: any) =>
      service.evaluatePreTradeDecision({
        bot: b,
        signal: sig,
        portfolio: { accountId: 'acc', initialCapital: 10000000, cashBalance: 10000000, availableMargin: 10000000, openPositions: [] } as any,
        liveQuote: { symbol: 'BTCUSDT_PERP', price: 83000, timestamp: new Date() } as any,
      } as any);

    it('uses the bot leverage (50x), not the 5x default', () => {
      const res = run(levBot(50), short(0.005));
      expect(res.decision).toBe(TradeDecisionType.TAKE);
      expect(res.plannedLevels!.leverage).toBe(50);
    });

    it('rejects a 2% stop at 50x: liquidation is ~1.6% away, before the stop', () => {
      const res = run(levBot(50), short(0.02));
      expect(JSON.stringify(res)).toContain('STOP_BEYOND_LIQUIDATION');
      expect(res.decision).toBe(TradeDecisionType.REJECT);
    });
  });

  describe('option bot: missed setup on the underlying', () => {
    const niftyBot: any = {
      ...bot, id: 'bot_nifty_missed', symbol: 'NIFTY', direction: 'ANY', lots: 1,
      executionInstrument: 'NIFTY OPTION', executionInstrumentType: 'OPTION',
    };
    // Option levels rebuilt from the live premium (what the bot passes), plus the NIFTY-level setup.
    const optionSignal: any = {
      ...signal(80.75), id: 'sig_nifty_opt', symbol: 'NIFTY', direction: Direction.BEARISH,
      executionInstrumentType: 'OPTION', contractSymbol: 'NIFTY 22600 PE', strike: 22600, optionType: 'PE', expiry: '06-Oct-2026',
      isOptionLevels: true, orderSide: 'BUY',
      entryZone: { min: 115.35, max: 115.35, optimal: 115.35 }, stopLoss: 80.75,
      takeProfits: { tp1: 150, tp2: 185, tp3: 230 },
    };
    const run = (niftyLive: number) =>
      service.evaluatePreTradeDecision({
        bot: niftyBot,
        signal: optionSignal,
        portfolio: { accountId: 'acc', initialCapital: 10000000, cashBalance: 10000000, availableMargin: 10000000, openPositions: [] } as any,
        liveQuote: { symbol: 'NIFTY 22600 PE', price: 115.35, timestamp: new Date() } as any,
        underlyingLiveQuote: { price: niftyLive, timestamp: new Date() },
        underlyingLevels: { direction: 'BEARISH', stopLoss: 22717.68, tp1: 22417.68 },
      } as any);

    it('rejects once NIFTY has already reached the bearish TP1 or the stop', () => {
      expect(JSON.stringify(run(22400))).toContain('ENTRY_MISSED_RR_DEGRADED');
      expect(JSON.stringify(run(22730))).toContain('ENTRY_MISSED_RR_DEGRADED');
    });

    it('does not flag the setup while NIFTY is between the stop and TP1', () => {
      expect(JSON.stringify(run(22600))).not.toContain('ENTRY_MISSED_RR_DEGRADED');
    });
  });
});

describe('Cost gate fails closed (COST_DATA_UNAVAILABLE)', () => {
  const service = new TradeDecisionService({} as any);
  const nowMs = Date.now();
  const bot: any = { id: 'bot_fc', symbol: 'BTCUSDT_SPOT', strategy: 'SMC', direction: 'BULLISH', timeframe: '15m', minScore: 70, smcCondition: 'ANY_CONFLUENCE', lots: 100, autoExecutePaper: true, isActive: true };
  const signal: any = {
    id: 'sig_fc', symbol: 'BTCUSDT_SPOT', strategy: 'SMC', strategyMode: 'SMC', timeframe: '15m', direction: Direction.BULLISH,
    state: SignalState.ACTIVE, grade: SignalGrade.A_PLUS, score: 90, canonicalCandleTime: nowMs, canonicalDecisionTime: new Date(nowMs),
    entryZone: { min: 82990, max: 83010, optimal: 83000 }, stopLoss: 83000 * 0.99,
    takeProfits: { tp1: 83000 * 1.015, tp2: 83000 * 1.025, tp3: 83000 * 1.04 }, riskRewardRatios: { rr1: 1.5, rr2: 2.5, rr3: 4 },
    reasoning: { summary: 'fail closed' }, scoreBreakdown: { totalScore: 90 },
    triggerEvidence: { orderBlock: { matched: true, timestamp: new Date(nowMs - 60000) }, fvg: { matched: true, timestamp: new Date(nowMs - 60000) }, liquiditySweep: { matched: true, timestamp: new Date(nowMs - 60000) }, structureBreak: { matched: true, timestamp: new Date(nowMs - 60000) } },
    timestamp: new Date(nowMs),
  };
  const evaluate = () =>
    service.evaluatePreTradeDecision({
      bot, signal,
      portfolio: { accountId: 'acc', initialCapital: 10000000, cashBalance: 10000000, availableMargin: 10000000, openPositions: [] } as any,
      liveQuote: { symbol: 'BTCUSDT_SPOT', price: 83000, timestamp: new Date() } as any,
    } as any);
  afterEach(() => jest.restoreAllMocks());

  it('baseline: the same setup is taken when costs resolve (1% stop)', () => {
    expect(evaluate().decision).toBe(TradeDecisionType.TAKE);
  });

  it('REGRESSION: a cost-schedule error rejects the trade (previously logged at debug level and the trade continued)', () => {
    jest.spyOn(TransactionCostScheduleManager.prototype, 'calculateCostForSymbol').mockImplementation(() => { throw new Error('fee schedule missing'); });
    const res = evaluate();
    expect(res.decision).toBe(TradeDecisionType.REJECT);
    expect(res.decisionReasonCode).toBe('COST_DATA_UNAVAILABLE');
    expect(res.decisionReason).toMatch(/fee schedule missing/);
  });

  it('a non-numeric fee (NaN) rejects instead of silently passing NaN > 0.5 === false', () => {
    jest.spyOn(TransactionCostScheduleManager.prototype, 'calculateCostForSymbol').mockReturnValue({ totalChargesAccount: NaN } as any);
    const res = evaluate();
    expect(res.decision).toBe(TradeDecisionType.REJECT);
    expect(res.decisionReasonCode).toBe('COST_DATA_UNAVAILABLE');
  });

  it('an unknown fee schedule (invalid cost configuration) rejects', () => {
    const real = getAuthoritativeDescriptor('BTCUSDT_SPOT');
    jest.spyOn(TransactionCostScheduleManager.prototype, 'calculateCostForSymbol').mockImplementation((turnover: unknown) =>
      TransactionCostScheduleManager.getInstance().calculateCost({ descriptor: { ...real, costScheduleId: 'NOT_A_SCHEDULE' as any }, turnoverQuote: Number(turnover) }),
    );
    const res = evaluate();
    expect(res.decisionReasonCode).toBe('COST_DATA_UNAVAILABLE');
    expect(res.decisionReason).toMatch(/unknown cost schedule/);
  });
});
