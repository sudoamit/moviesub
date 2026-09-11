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

describe('Phase 11 — Real Pipeline Integration & Golden Regression', () => {
  // Generate realistic candles
  const generateRealCandles = (count: number, basePrice = 100000): ICandle[] => {
    const candles: ICandle[] = [];
    const t0 = 1700000000000;
    let price = basePrice;
    for (let i = 0; i < count; i++) {
      const open = price;
      const high = price + 100;
      const low = price - 80;
      const close = price + 40;
      candles.push({
        timestamp: new Date(t0 + i * 15 * 60 * 1000),
        open,
        high,
        low,
        close,
        volume: 15.0 + (i % 5),
        isClosed: true,
      });
      price = close;
    }
    return candles;
  };

  const candles = generateRealCandles(60);
  const lastCandle = candles[candles.length - 1];

  const marketSnapshot = createMarketSnapshot({
    snapshotId: 'snap-real-01',
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
    cash: 100000,
    equity: 100000,
    openPositionsCount: 0,
  });

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

  it('Issue 1 & 2: traces real SignalGenerator pipeline and proves Champion decision is unchanged (Golden Regression)', () => {
    // 1. Standalone Champion execution through SignalGenerator
    const standaloneSignal = SignalGenerator.generateSignal({
      symbol: 'BTCUSDT',
      executionCandles: candles,
      executionTimeframe: Timeframe.M15,
      asOfTimestamp: lastCandle.timestamp,
    });

    const mockLivePort: ILiveExecutionPort = {
      isLiveBroker: true,
      submitLiveOrder: jest.fn().mockResolvedValue({ liveOrderId: 'order-1', status: 'FILLED' }),
      cancelLiveOrder: jest.fn().mockResolvedValue(true),
    };

    const store = new InMemoryShadowExecutionStore();
    const shadowSimulator = new ShadowExecutionSimulator();

    const orchestrator = new SynchronizedShadowOrchestrator({
      store,
      livePort: mockLivePort,
      shadowPort: shadowSimulator,
    });

    // 2. Execute via SynchronizedShadowOrchestrator using the real SignalGenerator
    const { championDecision, pairPromise } = orchestrator.executeDecisionFlow({
      snapshot: marketSnapshot,
      portfolioSnapshot,
      featureExtractor: () => {
        return {
          features: { smcScore: 75, rsi: 55, atr: 120 },
          featureHash: 'feat-hash-real-123',
          featureLatencyMs: 3,
        };
      },
      championEvaluator: (ctx, features) => {
        const signal = SignalGenerator.generateSignal({
          symbol: 'BTCUSDT',
          executionCandles: candles,
          executionTimeframe: Timeframe.M15,
          asOfTimestamp: new Date(ctx.marketSnapshot.timestamp),
        });

        const action = signal.direction === Direction.BULLISH ? 'BUY' : signal.direction === Direction.BEARISH ? 'SELL' : 'HOLD';
        const entryPrice = signal.entryZone?.optimal ?? 100000;
        const takeProfit = signal.takeProfits?.tp1 ?? 0;
        const confidence = signal.score / 100;
        const reasonStr = (signal.reasons || [signal.reasoning?.summary || 'SMC signal']).join('; ');

        return deepFreeze({
          decisionId: ctx.decisionId,
          action,
          confidence,
          signal: signal.state,
          entryPrice,
          stopLoss: signal.stopLoss,
          takeProfit,
          positionSize: 0.5,
          riskAmount: 500,
          reason: reasonStr,
          decisionFingerprint: computeDecisionFingerprint({
            modelIdentity: ctx.modelIdentity,
            snapshotId: ctx.snapshotId,
            snapshotHash: ctx.snapshotHash,
            portfolioStateHash: ctx.portfolioStateHash,
            featureVersion: ctx.featureVersion,
            featureSchemaHash: ctx.featureSchemaHash,
            featureInputHash: ctx.featureInputHash,
            featureDataCutoff: ctx.featureDataCutoff,
            action,
            signal: signal.state,
            entryPrice,
            stopLoss: signal.stopLoss,
            takeProfit,
            positionSize: 0.5,
            riskAmount: 500,
          }),
          latencies: {
            marketTimestamp: ctx.marketSnapshot.timestamp,
            featureStartTimestamp: 100,
            featureEndTimestamp: 103,
            modelStartTimestamp: 103,
            modelEndTimestamp: 107,
            decisionTimestamp: ctx.decisionTimestamp,
            dataToDecisionLatencyMs: 7,
            featureLatencyMs: 3,
            modelLatencyMs: 4,
            totalDecisionLatencyMs: 7,
          },
          context: ctx,
        });
      },
      challengerEvaluator: (ctx, features) => {
        return deepFreeze({
          decisionId: ctx.decisionId,
          action: 'HOLD',
          confidence: 0.60,
          signal: 'CHALLENGER_HOLD',
          reason: 'Challenger requires higher threshold',
          decisionFingerprint: 'chall_fp_1',
          latencies: {
            marketTimestamp: ctx.marketSnapshot.timestamp,
            featureStartTimestamp: 100,
            featureEndTimestamp: 103,
            modelStartTimestamp: 103,
            modelEndTimestamp: 107,
            decisionTimestamp: ctx.decisionTimestamp,
            dataToDecisionLatencyMs: 7,
            featureLatencyMs: 3,
            modelLatencyMs: 4,
            totalDecisionLatencyMs: 7,
          },
          context: ctx,
        });
      },
      championIdentity,
      challengerIdentity,
      sharedConfigs,
    });

    // GOLDEN REGRESSION & EXECUTION BOUNDARY ASSERTIONS:
    expect(championDecision.confidence).toBe(standaloneSignal.score / 100);
    expect(championDecision.entryPrice).toBe(standaloneSignal.entryZone?.optimal ?? 100000);
    expect(championDecision.stopLoss).toBe(standaloneSignal.stopLoss);
    expect(championDecision.takeProfit).toBe(standaloneSignal.takeProfits?.tp1 ?? 0);

    if (championDecision.action === 'BUY' || championDecision.action === 'SELL') {
      expect(mockLivePort.submitLiveOrder).toHaveBeenCalledTimes(1);
      expect(mockLivePort.submitLiveOrder).toHaveBeenCalledWith(championDecision);
    }

    return pairPromise.then((pair) => {
      expect(pair.divergence).toBeDefined();
      expect(pair.snapshotId).toBe(marketSnapshot.snapshotId);
      expect(pair.snapshotHash).toBe(marketSnapshot.snapshotHash);
    });
  });

  it('Issue 1 & 3: proves strict execution boundary — Champion calls Live, Challenger calls Shadow only, Never Live', async () => {
    const mockLivePort: ILiveExecutionPort = {
      isLiveBroker: true,
      submitLiveOrder: jest.fn().mockResolvedValue({ liveOrderId: 'order-boundary-1', status: 'PLACED' }),
      cancelLiveOrder: jest.fn().mockResolvedValue(true),
    };

    const store = new InMemoryShadowExecutionStore();
    const shadowSimulator = new ShadowExecutionSimulator();
    const shadowSubmitSpy = jest.spyOn(shadowSimulator, 'submitShadowOrder');

    const orchestrator = new SynchronizedShadowOrchestrator({
      store,
      livePort: mockLivePort,
      shadowPort: shadowSimulator,
    });

    const { championDecision, pairPromise } = orchestrator.executeDecisionFlow({
      snapshot: marketSnapshot,
      portfolioSnapshot,
      featureExtractor: () => ({ features: {}, featureHash: 'fhash', featureLatencyMs: 1 }),
      championEvaluator: (ctx) => deepFreeze({
        decisionId: ctx.decisionId,
        action: 'BUY',
        confidence: 0.90,
        signal: 'CHAMP_BUY',
        entryPrice: 100000,
        stopLoss: 98000,
        takeProfit: 105000,
        positionSize: 1.0,
        riskAmount: 2000,
        reason: 'Champion buy signal',
        decisionFingerprint: 'dp-champ-live',
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
      challengerEvaluator: (ctx) => deepFreeze({
        decisionId: ctx.decisionId,
        action: 'BUY',
        confidence: 0.95,
        signal: 'CHALL_BUY',
        entryPrice: 100000,
        stopLoss: 98000,
        takeProfit: 105000,
        positionSize: 2.0,
        riskAmount: 4000,
        reason: 'Challenger buy signal',
        decisionFingerprint: 'dp-chall-shadow',
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

    // 1. Champion immediately submitted live order
    expect(mockLivePort.submitLiveOrder).toHaveBeenCalledTimes(1);
    expect(mockLivePort.submitLiveOrder).toHaveBeenCalledWith(championDecision);

    // 2. Wait for Challenger shadow execution
    const pair = await pairPromise;
    expect(pair.pairId).toBeDefined();

    // 3. Challenger submitted shadow order via ShadowExecutionPort
    expect(shadowSubmitSpy).toHaveBeenCalledTimes(1);
    expect(shadowSubmitSpy).toHaveBeenCalledWith(expect.objectContaining({
      side: 'BUY',
      quantity: 2.0,
      requestedPrice: 100000,
    }));

    // 4. CRITICAL: Challenger NEVER touched Live Execution Port (still exactly 1 call from Champion)
    expect(mockLivePort.submitLiveOrder).toHaveBeenCalledTimes(1);

    // 5. Shadow simulator recorded open position, while live broker received live order
    expect(shadowSimulator.getShadowPortfolioState().openPositions.length).toBe(1);
  });

  it('Issue 10: proves slow Challenger does NOT block Champion execution return', async () => {
    const store = new InMemoryShadowExecutionStore();
    const shadowSimulator = new ShadowExecutionSimulator();

    const orchestrator = new SynchronizedShadowOrchestrator({
      store,
      shadowPort: shadowSimulator,
    });

    const start = Date.now();

    const { championDecision, pairPromise } = orchestrator.executeDecisionFlow({
      snapshot: marketSnapshot,
      portfolioSnapshot,
      featureExtractor: () => ({
        features: {},
        featureHash: 'fhash',
        featureLatencyMs: 1,
      }),
      championEvaluator: (ctx) => {
        return deepFreeze({
          decisionId: ctx.decisionId,
          action: 'HOLD',
          confidence: 0.8,
          signal: 'CHAMP_SIGNAL',
          reason: 'Fast champion',
          decisionFingerprint: 'fp_c',
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
        });
      },
      challengerEvaluator: async (ctx) => {
        // Artificially delay Challenger by 150ms
        await new Promise((resolve) => setTimeout(resolve, 150));
        return deepFreeze({
          decisionId: ctx.decisionId,
          action: 'HOLD',
          confidence: 0.85,
          signal: 'SLOW_CHALL_SIGNAL',
          reason: 'Slow challenger',
          decisionFingerprint: 'fp_slow_chall',
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
        });
      },
      championIdentity,
      challengerIdentity,
      sharedConfigs,
    });

    const champDuration = Date.now() - start;

    // Champion must return immediately (< 50ms) regardless of Challenger 150ms delay
    expect(champDuration).toBeLessThan(50);
    expect(championDecision.decisionId).toBeDefined();

    // The pair completes asynchronously
    const pair = await pairPromise;
    expect(pair.divergence).toBe('AGREE');
    expect(pair.challengerDecision.signal).toBe('SLOW_CHALL_SIGNAL');
  });
});
