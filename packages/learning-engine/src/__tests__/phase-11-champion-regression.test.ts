import {
  ICandle,
  Timeframe,
  Direction,
  SignalGrade
} from '@quant/shared';
import { SignalGenerator } from '@quant/trading-engine';
import {
  createMarketSnapshot,
  createPortfolioSnapshot,
  computeDecisionFingerprint,
  SynchronizedShadowOrchestrator,
  InMemoryShadowExecutionStore,
  ShadowExecutionSimulator,
  ILiveExecutionPort,
  DecisionContext,
  TradingDecision
} from '../shadow-execution/index';
import { deepFreeze } from '../champion-challenger/evaluation-identity';

describe('Phase 11 — Champion Production Behavior Golden Regression Test', () => {
  // Helper to generate candle sequence
  const generateCandles = (count: number, trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL', basePrice = 100000): ICandle[] => {
    const candles: ICandle[] = [];
    const t0 = 1700000000000;
    let price = basePrice;
    for (let i = 0; i < count; i++) {
      const step = trend === 'BULLISH' ? 50 : trend === 'BEARISH' ? -50 : (i % 2 === 0 ? 10 : -10);
      const open = price;
      const high = price + Math.max(step, 0) + 30;
      const low = price + Math.min(step, 0) - 30;
      const close = price + step;
      candles.push({
        timestamp: new Date(t0 + i * 15 * 60 * 1000),
        open,
        high,
        low,
        close,
        volume: 20.0 + (i % 5),
        isClosed: true,
      });
      price = close;
    }
    return candles;
  };

  const championIdentity = {
    modelId: 'champ-smc-v1',
    modelVersion: '1.0.0',
    artifactHash: 'hash-champ-weights-1',
  };

  const challengerIdentity = {
    modelId: 'chall-smc-v2',
    modelVersion: '2.0.0',
    artifactHash: 'hash-chall-weights-2',
  };

  const sharedConfigs = {
    featureVersion: '2.0',
    featureSchemaHash: 'fhash-schema-canonical',
    strategyVersion: 'v2.0-smc',
    strategyConfigHash: 'shash-strat-smc',
    executionConfigVersion: 'exec-v2',
    executionConfigHash: 'ehash-exec-v2',
    riskConfigVersion: 'risk-v2',
    riskConfigHash: 'rhash-risk-v2',
    costConfigVersion: 'cost-v2',
    costConfigHash: 'cohash-cost-v2',
    portfolioStateVersion: 'port-v2',
  };

  it('proves Champion decision BEFORE Phase 11 === Champion decision AFTER Phase 11 (Bullish Regime)', async () => {
    const candles = generateCandles(60, 'BULLISH');
    const lastCandle = candles[candles.length - 1];

    // --- PRE-PHASE 11: Standalone Direct Execution ---
    const prePhase11Signal = SignalGenerator.generateSignal({
      symbol: 'BTCUSDT',
      executionCandles: candles,
      executionTimeframe: Timeframe.M15,
      asOfTimestamp: lastCandle.timestamp,
    });

    const prePhase11Action = prePhase11Signal.direction === Direction.BULLISH
      ? 'BUY'
      : prePhase11Signal.direction === Direction.BEARISH
        ? 'SELL'
        : 'HOLD';
    const prePhase11Confidence = prePhase11Signal.score / 100;
    const prePhase11Entry = prePhase11Signal.entryZone?.optimal ?? lastCandle.close;
    const prePhase11Stop = prePhase11Signal.stopLoss;
    const prePhase11TP = prePhase11Signal.takeProfits?.tp1 ?? 0;
    const prePhase11Reason = (prePhase11Signal.reasons || [prePhase11Signal.reasoning?.summary || 'SMC signal']).join('; ');

    // --- POST-PHASE 11: Orchestrated Execution ---
    const marketSnapshot = createMarketSnapshot({
      snapshotId: 'snap-regr-bull-01',
      instrument: { symbol: 'BTCUSDT', market: 'BINANCE_SPOT', tickSize: 0.1, lotSize: 0.001 },
      timestamp: lastCandle.timestamp.getTime(),
      ohlcv: {
        open: lastCandle.open,
        high: lastCandle.high,
        low: lastCandle.low,
        close: lastCandle.close,
        volume: lastCandle.volume,
      },
      bid: lastCandle.close - 0.5,
      ask: lastCandle.close + 0.5,
      volume: lastCandle.volume,
      dataSource: 'production-feed',
      dataVersion: '2.0',
    });

    const portfolioSnapshot = createPortfolioSnapshot({
      portfolioId: 'live-port-01',
      timestamp: lastCandle.timestamp.getTime(),
      cash: 250000,
      equity: 250000,
      openPositionsCount: 0,
    });

    const mockLivePort: ILiveExecutionPort = {
      isLiveBroker: true,
      submitLiveOrder: jest.fn().mockResolvedValue({ liveOrderId: 'live-order-regr-1', status: 'FILLED' }),
      cancelLiveOrder: jest.fn().mockResolvedValue(true),
    };

    const store = new InMemoryShadowExecutionStore();
    const shadowSimulator = new ShadowExecutionSimulator();

    const orchestrator = new SynchronizedShadowOrchestrator({
      store,
      livePort: mockLivePort,
      shadowPort: shadowSimulator,
    });

    const { championDecision, pairPromise } = orchestrator.executeDecisionFlow({
      snapshot: marketSnapshot,
      portfolioSnapshot,
      featureExtractor: () => ({
        features: { rawScore: prePhase11Signal.score },
        featureHash: 'fhash-bull',
        featureLatencyMs: 2,
      }),
      championEvaluator: (ctx) => {
        const signal = SignalGenerator.generateSignal({
          symbol: 'BTCUSDT',
          executionCandles: candles,
          executionTimeframe: Timeframe.M15,
          asOfTimestamp: new Date(ctx.marketSnapshot.timestamp),
        });
        const action = signal.direction === Direction.BULLISH ? 'BUY' : signal.direction === Direction.BEARISH ? 'SELL' : 'HOLD';
        return deepFreeze({
          decisionId: ctx.decisionId,
          action,
          confidence: signal.score / 100,
          signal: signal.state,
          entryPrice: signal.entryZone?.optimal ?? lastCandle.close,
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfits?.tp1 ?? 0,
          positionSize: 1.0,
          riskAmount: 1000,
          reason: (signal.reasons || [signal.reasoning?.summary || 'SMC signal']).join('; '),
          decisionFingerprint: 'fp-champ-regr-bull',
          latencies: {
            marketTimestamp: ctx.marketSnapshot.timestamp,
            featureStartTimestamp: 10,
            featureEndTimestamp: 12,
            modelStartTimestamp: 12,
            modelEndTimestamp: 15,
            decisionTimestamp: ctx.decisionTimestamp,
            dataToDecisionLatencyMs: 5,
            featureLatencyMs: 2,
            modelLatencyMs: 3,
            totalDecisionLatencyMs: 5,
          },
          context: ctx,
        });
      },
      challengerEvaluator: (ctx) => {
        return deepFreeze({
          decisionId: ctx.decisionId,
          action: 'HOLD',
          confidence: 0.5,
          signal: 'CHALL_HOLD',
          reason: 'Challenger filter',
          decisionFingerprint: 'fp-chall-regr-bull',
          latencies: {
            marketTimestamp: ctx.marketSnapshot.timestamp,
            featureStartTimestamp: 10,
            featureEndTimestamp: 12,
            modelStartTimestamp: 12,
            modelEndTimestamp: 15,
            decisionTimestamp: ctx.decisionTimestamp,
            dataToDecisionLatencyMs: 5,
            featureLatencyMs: 2,
            modelLatencyMs: 3,
            totalDecisionLatencyMs: 5,
          },
          context: ctx,
        });
      },
      championIdentity,
      challengerIdentity,
      sharedConfigs,
    });

    // 1. EXACT DECISION EQUIVALENCE
    expect(championDecision.action).toBe(prePhase11Action);
    expect(championDecision.confidence).toBe(prePhase11Confidence);
    expect(championDecision.entryPrice).toBe(prePhase11Entry);
    expect(championDecision.stopLoss).toBe(prePhase11Stop);
    expect(championDecision.takeProfit).toBe(prePhase11TP);
    expect(championDecision.reason).toBe(prePhase11Reason);

    // 2. LIVE ORDER INTENT SUBMISSION
    if (prePhase11Action === 'BUY' || prePhase11Action === 'SELL') {
      expect(mockLivePort.submitLiveOrder).toHaveBeenCalledTimes(1);
      expect(mockLivePort.submitLiveOrder).toHaveBeenCalledWith(championDecision);
    } else {
      expect(mockLivePort.submitLiveOrder).toHaveBeenCalledTimes(0);
    }

    // 3. COMPLETE PAIR INTEGRITY
    const pair = await pairPromise;
    expect(pair.championDecision.action).toBe(prePhase11Action);
    expect(pair.challengerDecision.action).toBe('HOLD');
  });

  it('proves Champion decision equivalence in Bearish / Short Setup', async () => {
    const candles = generateCandles(60, 'BEARISH');
    const lastCandle = candles[candles.length - 1];

    const preSignal = SignalGenerator.generateSignal({
      symbol: 'BTCUSDT',
      executionCandles: candles,
      executionTimeframe: Timeframe.M15,
      asOfTimestamp: lastCandle.timestamp,
    });

    const marketSnapshot = createMarketSnapshot({
      snapshotId: 'snap-regr-bear-01',
      instrument: { symbol: 'BTCUSDT', market: 'BINANCE_SPOT', tickSize: 0.1, lotSize: 0.001 },
      timestamp: lastCandle.timestamp.getTime(),
      ohlcv: {
        open: lastCandle.open,
        high: lastCandle.high,
        low: lastCandle.low,
        close: lastCandle.close,
        volume: lastCandle.volume,
      },
      bid: lastCandle.close - 0.5,
      ask: lastCandle.close + 0.5,
      volume: lastCandle.volume,
      dataSource: 'production-feed',
      dataVersion: '2.0',
    });

    const portfolioSnapshot = createPortfolioSnapshot({
      portfolioId: 'live-port-01',
      timestamp: lastCandle.timestamp.getTime(),
      cash: 250000,
      equity: 250000,
      openPositionsCount: 0,
    });

    const mockLivePort: ILiveExecutionPort = {
      isLiveBroker: true,
      submitLiveOrder: jest.fn().mockResolvedValue({ liveOrderId: 'order-bear', status: 'FILLED' }),
      cancelLiveOrder: jest.fn().mockResolvedValue(true),
    };

    const orchestrator = new SynchronizedShadowOrchestrator({
      store: new InMemoryShadowExecutionStore(),
      livePort: mockLivePort,
      shadowPort: new ShadowExecutionSimulator(),
    });

    const { championDecision } = orchestrator.executeDecisionFlow({
      snapshot: marketSnapshot,
      portfolioSnapshot,
      featureExtractor: () => ({ features: {}, featureHash: 'fhash-bear', featureLatencyMs: 1 }),
      championEvaluator: (ctx) => {
        const signal = SignalGenerator.generateSignal({
          symbol: 'BTCUSDT',
          executionCandles: candles,
          executionTimeframe: Timeframe.M15,
          asOfTimestamp: new Date(ctx.marketSnapshot.timestamp),
        });
        const action = signal.direction === Direction.BULLISH ? 'BUY' : signal.direction === Direction.BEARISH ? 'SELL' : 'HOLD';
        return deepFreeze({
          decisionId: ctx.decisionId,
          action,
          confidence: signal.score / 100,
          signal: signal.state,
          entryPrice: signal.entryZone?.optimal ?? lastCandle.close,
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfits?.tp1 ?? 0,
          positionSize: 1.0,
          riskAmount: 1000,
          reason: (signal.reasons || [signal.reasoning?.summary || 'SMC signal']).join('; '),
          decisionFingerprint: 'fp-bear',
          latencies: {
            marketTimestamp: ctx.marketSnapshot.timestamp,
            featureStartTimestamp: 0,
            featureEndTimestamp: 0,
            modelStartTimestamp: 0,
            modelEndTimestamp: 0,
            decisionTimestamp: ctx.decisionTimestamp,
            dataToDecisionLatencyMs: 0,
            featureLatencyMs: 0,
            modelLatencyMs: 0,
            totalDecisionLatencyMs: 0,
          },
          context: ctx,
        });
      },
      challengerEvaluator: (ctx) => deepFreeze({
        decisionId: ctx.decisionId,
        action: 'HOLD',
        confidence: 0.5,
        signal: 'CHALL_HOLD',
        reason: 'Hold',
        decisionFingerprint: 'fp-chall-bear',
        latencies: {
          marketTimestamp: 0,
          featureStartTimestamp: 0,
          featureEndTimestamp: 0,
          modelStartTimestamp: 0,
          modelEndTimestamp: 0,
          decisionTimestamp: 0,
          dataToDecisionLatencyMs: 0,
          featureLatencyMs: 0,
          modelLatencyMs: 0,
          totalDecisionLatencyMs: 0,
        },
        context: ctx,
      }),
      championIdentity,
      challengerIdentity,
      sharedConfigs,
    });

    expect(championDecision.confidence).toBe(preSignal.score / 100);
    expect(championDecision.entryPrice).toBe(preSignal.entryZone?.optimal ?? lastCandle.close);
    expect(championDecision.stopLoss).toBe(preSignal.stopLoss);
    expect(championDecision.takeProfit).toBe(preSignal.takeProfits?.tp1 ?? 0);
  });
});
