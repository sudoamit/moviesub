import { StrategySignal } from '@quant/shared';
import { SignalAggregationService } from '../signal-aggregation.service';

describe('Phase 25 — Strategy Signal Aggregation & Conflict Resolution Engine', () => {
  let service: SignalAggregationService;
  const baseTime = new Date('2026-01-15T10:00:00.000Z');

  beforeEach(() => {
    service = new SignalAggregationService();
  });

  const createSignal = (overrides: Partial<StrategySignal> = {}): StrategySignal => ({
    signalId: `sig_${Math.random().toString(36).substring(2, 9)}`,
    strategyId: 'strat_smc_fvg',
    strategyType: 'SMC',
    symbol: 'NIFTY',
    direction: 'BUY',
    confidence: 0.8,
    weight: 1.0,
    priority: 5,
    timestamp: baseTime,
    halfLifeMs: 300000, // 5 minutes = 300,000ms
    entryPrice: 24100,
    stopLoss: 24050,
    takeProfit: 24200,
    ...overrides,
  });

  describe('1. Exponential Signal Decay & Half-Life Modeling', () => {
    it('should calculate exact decayed confidence over elapsed half-lives', () => {
      const signal = createSignal({ confidence: 0.8, halfLifeMs: 300000 });

      // At t=0: full confidence 0.80
      const c0 = service.applySignalDecay(signal, baseTime);
      expect(c0).toBeCloseTo(0.8, 5);

      // At t=5min (1 half-life): confidence should be 0.40 (50% decay)
      const t1 = new Date(baseTime.getTime() + 300000);
      const c1 = service.applySignalDecay(signal, t1);
      expect(c1).toBeCloseTo(0.4, 5);

      // At t=10min (2 half-lives): confidence should be 0.20 (75% decay)
      const t2 = new Date(baseTime.getTime() + 600000);
      const c2 = service.applySignalDecay(signal, t2);
      expect(c2).toBeCloseTo(0.2, 5);

      // At t=15min (3 half-lives): confidence should be 0.10 (87.5% decay)
      const t3 = new Date(baseTime.getTime() + 900000);
      const c3 = service.applySignalDecay(signal, t3);
      expect(c3).toBeCloseTo(0.1, 5);
    });

    it('should correctly detect expired signals past max age or confidence floor', () => {
      const signal = createSignal({ confidence: 0.8, halfLifeMs: 300000 });

      // At 10 min (2 half-lives, c=0.20): not expired
      const t2 = new Date(baseTime.getTime() + 600000);
      expect(service.isSignalExpired(signal, t2)).toBe(false);

      // At 25 min (> 4 half-lives = 20 min): expired by max age
      const tExpired = new Date(baseTime.getTime() + 1500000);
      expect(service.isSignalExpired(signal, tExpired)).toBe(true);

      // Decayed confidence below floor 0.05
      const lowConfSignal = createSignal({ confidence: 0.08, halfLifeMs: 300000 });
      const tOneHalfLife = new Date(baseTime.getTime() + 300000); // decays to 0.04 < 0.05
      expect(service.isSignalExpired(lowConfSignal, tOneHalfLife, undefined, 0.05)).toBe(true);
    });

    it('should neutralize when all signals for a symbol are expired', () => {
      const oldSignal = createSignal({
        timestamp: new Date(baseTime.getTime() - 3600000), // 1 hour ago
        halfLifeMs: 300000,
      });

      const result = service.aggregateSignals([oldSignal], { referenceTime: baseTime });

      expect(result.action).toBe('NEUTRAL');
      expect(result.reason).toContain('All strategy signals have expired');
      expect(result.contributingSignals[0].isExpired).toBe(true);
    });
  });

  describe('2. Conflict Resolution Mode: NET_POSITIONING', () => {
    it('should execute BUY when weighted BUY signals exceed SELL signals past threshold', () => {
      // 2 BUY signals with total weight = 2.0, avg conf = 0.85
      // 1 SELL signal with weight = 1.0, conf = 0.40
      const sigBuy1 = createSignal({
        signalId: 'buy_1',
        strategyType: 'SMC',
        direction: 'BUY',
        confidence: 0.9,
        weight: 1.0,
      });
      const sigBuy2 = createSignal({
        signalId: 'buy_2',
        strategyType: 'ORDER_FLOW',
        direction: 'BUY',
        confidence: 0.8,
        weight: 1.0,
      });
      const sigSell1 = createSignal({
        signalId: 'sell_1',
        strategyType: 'MEAN_REVERSION',
        direction: 'SELL',
        confidence: 0.4,
        weight: 1.0,
      });

      const result = service.aggregateSignals([sigBuy1, sigBuy2, sigSell1], {
        resolutionMode: 'NET_POSITIONING',
        referenceTime: baseTime,
        netConvictionThreshold: 0.15,
      });

      expect(result.action).toBe('BUY');
      expect(result.conflictsDetected).toBe(true);
      expect(result.netScore).toBeGreaterThan(0.15);
      expect(result.compositeConfidence).toBeGreaterThan(0);
      expect(result.reason).toContain('BUY consensus via net positioning');
    });

    it('should neutralize to NEUTRAL when opposing signals are balanced within threshold', () => {
      // 1 BUY with conf 0.70, weight 1.0
      // 1 SELL with conf 0.65, weight 1.0
      // Net score ~= (0.70 - 0.65) / 1.35 = 0.037 < 0.15 threshold
      const sigBuy = createSignal({
        direction: 'BUY',
        confidence: 0.7,
        weight: 1.0,
      });
      const sigSell = createSignal({
        direction: 'SELL',
        confidence: 0.65,
        weight: 1.0,
      });

      const result = service.aggregateSignals([sigBuy, sigSell], {
        resolutionMode: 'NET_POSITIONING',
        referenceTime: baseTime,
        netConvictionThreshold: 0.15,
      });

      expect(result.action).toBe('NEUTRAL');
      expect(result.conflictsDetected).toBe(true);
      expect(result.compositeConfidence).toBe(0);
      expect(result.reason).toContain('does not meet conviction threshold');
    });
  });

  describe('3. Conflict Resolution Mode: PRIORITY_ARBITRATION', () => {
    it('should allow higher-priority strategy signal to overrule lower-priority opposing signal', () => {
      // SMC signal is BUY with Priority 10, confidence 0.70
      const htfSMC = createSignal({
        strategyType: 'SMC_STRUCTURAL',
        direction: 'BUY',
        confidence: 0.7,
        priority: 10,
      });

      // Mean Reversion signal is SELL with Priority 4, confidence 0.95
      const ltfMR = createSignal({
        strategyType: 'MEAN_REVERSION_SCALP',
        direction: 'SELL',
        confidence: 0.95,
        priority: 4,
      });

      const result = service.aggregateSignals([htfSMC, ltfMR], {
        resolutionMode: 'PRIORITY_ARBITRATION',
        referenceTime: baseTime,
      });

      expect(result.action).toBe('BUY');
      expect(result.conflictsDetected).toBe(true);
      expect(result.conflictDetails).toContain('BUY priority (10) overruled SELL priority (4)');
      expect(result.reason).toContain('priority arbitration');
    });

    it('should execute SELL when SELL priority exceeds BUY priority', () => {
      const buyLowPri = createSignal({
        direction: 'BUY',
        priority: 3,
      });
      const sellHighPri = createSignal({
        direction: 'SELL',
        priority: 9,
      });

      const result = service.aggregateSignals([buyLowPri, sellHighPri], {
        resolutionMode: 'PRIORITY_ARBITRATION',
        referenceTime: baseTime,
      });

      expect(result.action).toBe('SELL');
      expect(result.conflictDetails).toContain('SELL priority (9) overruled BUY priority (3)');
    });
  });

  describe('4. Conflict Resolution Mode: CANCEL_OUT (Zero-Tolerance)', () => {
    it('should immediately neutralize trade when conflicting directions are detected', () => {
      const sigBuy = createSignal({
        direction: 'BUY',
        confidence: 0.85,
      });
      const sigSell = createSignal({
        direction: 'SELL',
        confidence: 0.85,
      });

      const result = service.aggregateSignals([sigBuy, sigSell], {
        resolutionMode: 'CANCEL_OUT',
        referenceTime: baseTime,
      });

      expect(result.action).toBe('NEUTRAL');
      expect(result.conflictsDetected).toBe(true);
      expect(result.compositeConfidence).toBe(0);
      expect(result.confluenceMultiplier).toBe(0);
      expect(result.reason).toContain('CANCEL_OUT mode; trade suppressed');
    });
  });

  describe('5. Conflict Resolution Mode: HTF_ALIGNMENT_ONLY', () => {
    it('should filter out counter-trend LTF signals and execute in direction of HTF bias', () => {
      const sigBuy = createSignal({
        direction: 'BUY',
        confidence: 0.75,
      });
      const sigSell = createSignal({
        direction: 'SELL',
        confidence: 0.8,
      });

      // Macro HTF Bias is BUY
      const result = service.aggregateSignals([sigBuy, sigSell], {
        resolutionMode: 'HTF_ALIGNMENT_ONLY',
        htfBias: 'BUY',
        referenceTime: baseTime,
      });

      expect(result.action).toBe('BUY');
      expect(result.conflictsDetected).toBe(true);
      expect(result.conflictDetails).toContain('HTF trend bias (BUY) selected BUY signals');
      expect(result.reason).toContain('aligned with higher-timeframe trend bias');
    });
  });

  describe('6. Multi-Timeframe Confluence Scoring (HTF x LTF)', () => {
    it('should boost confidence when LTF trigger agrees with HTF trend', () => {
      const htfSignal = createSignal({
        direction: 'BUY',
        confidence: 0.8,
        timeframe: '1h',
      });
      const ltfSignal = createSignal({
        direction: 'BUY',
        confidence: 0.6,
        timeframe: '5m',
      });

      const confluence = service.calculateMultiTimeframeConfluence({
        htfSignal,
        ltfSignal,
        alignmentBoost: 0.5, // +50% of HTF confidence: 1 + 0.5 * 0.8 = 1.40x
      });

      expect(confluence.isAligned).toBe(true);
      expect(confluence.status).toBe('ALIGNED');
      expect(confluence.confluenceMultiplier).toBeCloseTo(1.4, 4);
      expect(confluence.finalConfidence).toBeCloseTo(0.6 * 1.4, 4); // 0.84
      expect(confluence.details).toContain('Aligned with HTF trend');
    });

    it('should penalize counter-trend LTF confidence in non-strict mode', () => {
      const htfSignal = createSignal({
        direction: 'SELL',
        confidence: 0.8,
        timeframe: '1h',
      });
      const ltfSignal = createSignal({
        direction: 'BUY',
        confidence: 0.6,
        timeframe: '5m',
      });

      const confluence = service.calculateMultiTimeframeConfluence({
        htfSignal,
        ltfSignal,
        counterTrendPenalty: 0.5, // 1 - 0.5 * 0.8 = 0.60x
        strictAlignment: false,
      });

      expect(confluence.isAligned).toBe(false);
      expect(confluence.status).toBe('COUNTER_TREND_PENALIZED');
      expect(confluence.confluenceMultiplier).toBeCloseTo(0.6, 4);
      expect(confluence.finalConfidence).toBeCloseTo(0.36, 4);
    });

    it('should strictly reject counter-trend LTF signals when strictAlignment is enabled', () => {
      const htfSignal = createSignal({
        direction: 'SELL',
        confidence: 0.9,
        timeframe: '4h',
      });
      const ltfSignal = createSignal({
        direction: 'BUY',
        confidence: 0.8,
        timeframe: '1m',
      });

      const confluence = service.calculateMultiTimeframeConfluence({
        htfSignal,
        ltfSignal,
        strictAlignment: true,
      });

      expect(confluence.isAligned).toBe(false);
      expect(confluence.compositeDirection).toBe('NEUTRAL');
      expect(confluence.status).toBe('COUNTER_TREND_REJECTED');
      expect(confluence.finalConfidence).toBe(0);
      expect(confluence.confluenceMultiplier).toBe(0);
      expect(confluence.details).toContain('strictly rejected');
    });
  });

  describe('7. Robustness and Consensus Edge Cases', () => {
    it('should pass through a single valid signal without conflict', () => {
      const single = createSignal({
        direction: 'BUY',
        confidence: 0.85,
      });

      const result = service.aggregateSignals([single], { referenceTime: baseTime });

      expect(result.action).toBe('BUY');
      expect(result.conflictsDetected).toBe(false);
      expect(result.compositeConfidence).toBeCloseTo(0.85, 4);
      expect(result.reason).toContain('Unanimous BUY consensus');
    });

    it('should return NEUTRAL on empty signals array', () => {
      const result = service.aggregateSignals([]);
      expect(result.action).toBe('NEUTRAL');
      expect(result.reason).toContain('No strategy signals provided');
    });
  });
});
