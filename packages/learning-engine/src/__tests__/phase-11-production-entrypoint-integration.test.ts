import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  ICandle,
  Timeframe,
  Direction
} from '@quant/shared';
import { SignalGenerator, FeatureVectorExtractor, TradeFeatureVector } from '@quant/trading-engine';
import { PositionSizer } from '@quant/risk-engine';
import {
  ProductionTradingPipeline,
  LiveMarketEvent,
  LivePortfolioAccountState,
  InMemoryShadowExecutionStore,
  FileShadowExecutionStore,
  ShadowExecutionSimulator,
  ILiveExecutionPort,
  computeDecisionFingerprint,
  ShadowOutcomeEvaluator,
  TradingAction
} from '../shadow-execution/index';
import { canonicalJsonStringify } from '../canonical-serializer';

describe('Phase 11 — Production Entrypoint Integration & Real Runtime Verification', () => {
  // Candle Generator
  const generateCandles = (count: number, trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL', basePrice = 100000): ICandle[] => {
    const candles: ICandle[] = [];
    const t0 = 1700000000000;
    let price = basePrice;
    for (let i = 0; i < count; i++) {
      const step = trend === 'BULLISH' ? 50 : trend === 'BEARISH' ? -50 : (i % 2 === 0 ? 5 : -5);
      const open = price;
      const high = price + Math.max(step, 0) + 20;
      const low = price + Math.min(step, 0) - 20;
      const close = price + step;
      candles.push({
        timestamp: new Date(t0 + i * 15 * 60 * 1000),
        open,
        high,
        low,
        close,
        volume: 25.0 + (i % 5),
        isClosed: true,
      });
      price = close;
    }
    return candles;
  };

  const championModel = {
    modelId: 'champ-v1-prod',
    modelVersion: '1.0.0',
    artifactHash: 'hash-champ-weights-prod-1',
  };

  const challengerModel = {
    modelId: 'chall-v2-prod',
    modelVersion: '2.0.0',
    artifactHash: 'hash-chall-weights-prod-2',
  };

  const defaultRiskConfig = {
    riskPercentage: 1.0,
    maxRiskPercentage: 2.5,
    maxLeverage: 10,
    lotSize: 1,
  };

  it('1 & 2 & 3 & 4: processes real market event through production pipeline, Risk Engine, and Live vs Shadow execution boundaries', async () => {
    const candles = generateCandles(60, 'BULLISH');
    const lastCandle = candles[candles.length - 1];
    const eventTime = lastCandle.timestamp.getTime();

    const mockLivePort: ILiveExecutionPort = {
      isLiveBroker: true,
      submitLiveOrder: jest.fn().mockResolvedValue({ liveOrderId: 'live-prod-order-1', status: 'PLACED' }),
      cancelLiveOrder: jest.fn().mockResolvedValue(true),
    };

    const store = new InMemoryShadowExecutionStore();
    const shadowSimulator = new ShadowExecutionSimulator({ initialCapital: 100000 });
    const shadowSubmitSpy = jest.spyOn(shadowSimulator, 'submitShadowOrder');

    const strategyConfig = {
      deterministicSignal: {
        direction: Direction.BULLISH,
        score: 95,
        entryPrice: 100,
        stopLoss: 95,
        takeProfits: { tp1: 110, tp2: 120, tp3: 130 },
      },
    };

    const pipeline = new ProductionTradingPipeline({
      store,
      liveExecutionPort: mockLivePort,
      shadowExecutionPort: shadowSimulator,
      championModel,
      challengerModel,
      riskConfig: defaultRiskConfig,
      featureVersion: '2.0',
      featureSchemaHash: 'fhash_schema_prod',
      strategyVersion: 'v2.0-smc',
      strategyConfigHash: 'shash_strat_prod',
      strategyConfig,
      executionConfigVersion: 'exec-v2',
      executionConfigHash: 'ehash_exec_prod',
      riskConfigVersion: 'risk-v2',
      riskConfigHash: 'rhash_risk_prod',
      costConfigVersion: 'cost-v2',
      costConfigHash: 'chash_cost_prod',
    });

    const marketEvent: LiveMarketEvent = {
      symbol: 'BTCUSDT',
      market: 'BINANCE_SPOT',
      candles,
      executionTimeframe: Timeframe.M15,
      timestamp: eventTime,
      bid: lastCandle.close - 0.5,
      ask: lastCandle.close + 0.5,
      volume: lastCandle.volume,
    };

    const portfolioState: LivePortfolioAccountState = {
      portfolioId: 'live-portfolio-prod-1',
      cash: 100000,
      equity: 100000,
      openPositions: [],
      timestamp: eventTime,
    };

    // PROCESS EVENT THROUGH REAL PRODUCTION ENTRYPOINT
    const { championDecision, pairPromise } = await pipeline.processMarketEvent(marketEvent, portfolioState);

    // 1. RISK ENGINE VERIFICATION: Position size was computed by Phase 7 PositionSizer (not hardcoded)
    const expectedSizing = PositionSizer.calculatePosition({
      accountBalance: portfolioState.equity,
      riskPercentage: defaultRiskConfig.riskPercentage,
      entryPrice: championDecision.entryPrice || lastCandle.close,
      stopLoss: championDecision.stopLoss || lastCandle.close * 0.95,
      lotSize: defaultRiskConfig.lotSize,
      maxRiskPercentage: defaultRiskConfig.maxRiskPercentage,
      maxLeverage: defaultRiskConfig.maxLeverage,
    });

    expect(championDecision.positionSize).toBe(expectedSizing.roundedUnits);
    expect(championDecision.riskAmount).toBe(expectedSizing.riskAmount);
    expect(championDecision.positionSize).toBeGreaterThan(0);

    // 2. LIVE EXECUTION BOUNDARY: Champion submitted order to live broker
    if (championDecision.action === 'BUY' || championDecision.action === 'SELL') {
      expect(mockLivePort.submitLiveOrder).toHaveBeenCalledTimes(1);
      expect(mockLivePort.submitLiveOrder).toHaveBeenCalledWith(championDecision);
    }

    // 3. REAL FEATURE VECTOR HASHING: featureInputHash matches canonical SHA-256 of extracted 17D features
    const extractedFeatures = FeatureVectorExtractor.extract({
      signal: SignalGenerator.generateSignal({
        symbol: marketEvent.symbol,
        executionCandles: candles,
        executionTimeframe: Timeframe.M15,
        asOfTimestamp: new Date(eventTime),
        strategyConfig,
      }),
      candles,
      asOfTimestamp: new Date(eventTime),
    });
    const expectedFeatureHash = createHash('sha256')
      .update(canonicalJsonStringify(extractedFeatures))
      .digest('hex');

    expect(championDecision.context.featureInputHash).toBe(expectedFeatureHash);

    // 4. CANONICAL FINGERPRINT: Decision fingerprint is computed canonically
    const expectedFingerprint = computeDecisionFingerprint({
      modelIdentity: championModel,
      snapshotId: championDecision.context.snapshotId,
      snapshotHash: championDecision.context.snapshotHash,
      portfolioStateHash: championDecision.context.portfolioStateHash,
      featureVersion: '2.0',
      featureSchemaHash: 'fhash_schema_prod',
      featureInputHash: expectedFeatureHash,
      featureDataCutoff: eventTime,
      strategyConfigHash: 'shash_strat_prod',
      executionConfigHash: 'ehash_exec_prod',
      riskConfigHash: 'rhash_risk_prod',
      costConfigHash: 'chash_cost_prod',
      action: championDecision.action,
      signal: championDecision.signal,
      entryPrice: championDecision.entryPrice,
      stopLoss: championDecision.stopLoss,
      takeProfit: championDecision.takeProfit,
      positionSize: championDecision.positionSize,
      riskAmount: championDecision.riskAmount,
    });
    expect(championDecision.decisionFingerprint).toBe(expectedFingerprint);

    // 5. MEASURED MONOTONIC TIMINGS: Latencies are real positive numbers
    expect(championDecision.latencies.featureLatencyMs).toBeGreaterThanOrEqual(0.01);
    expect(championDecision.latencies.modelLatencyMs).toBeGreaterThanOrEqual(0.01);
    expect(championDecision.latencies.totalDecisionLatencyMs).toBeGreaterThanOrEqual(1);

    // 6. SHADOW EXECUTION & ISOLATION: Challenger completes in background
    const pair = await pairPromise;
    expect(pair.pairId).toBeDefined();
    expect(pair.snapshotId).toBe(championDecision.context.snapshotId);

    // Challenger called shadow execution simulator
    if (pair.challengerDecision.action === 'BUY' || pair.challengerDecision.action === 'SELL') {
      expect(shadowSubmitSpy).toHaveBeenCalled();
    }

    // CRITICAL: Live port call count NEVER exceeded 1 (Challenger never had access)
    expect(mockLivePort.submitLiveOrder).toHaveBeenCalledTimes(1);
  });

  it('Problem #2: executes real differentiated ML inference for Champion vs Challenger with model artifacts', async () => {
    const candles = generateCandles(60, 'BULLISH');
    const lastCandle = candles[candles.length - 1];
    const eventTime = lastCandle.timestamp.getTime();

    const mockLivePort: ILiveExecutionPort = {
      isLiveBroker: true,
      submitLiveOrder: jest.fn().mockResolvedValue({ liveOrderId: 'live-prod-order-2', status: 'PLACED' }),
      cancelLiveOrder: jest.fn().mockResolvedValue(true),
    };

    const store = new InMemoryShadowExecutionStore();
    const shadowSimulator = new ShadowExecutionSimulator();

    const strategyConfig = {
      deterministicSignal: {
        direction: Direction.BULLISH,
        score: 90,
        entryPrice: 100,
        stopLoss: 95,
        takeProfits: { tp1: 110, tp2: 120, tp3: 130 },
      },
    };

    // Real ML model artifact inference: computes calibrated logistic activation from extracted feature vector
    const evaluateArtifactWeights = (features: TradeFeatureVector, weights: Record<string, number>, bias: number) => {
      let score = bias;
      for (const [key, val] of Object.entries(features)) {
        if (typeof val === 'number' && key in weights) {
          score += val * weights[key];
        }
      }
      const prob = 1.0 / (1.0 + Math.exp(-score));
      const action: TradingAction = prob >= 0.70 ? 'BUY' : 'HOLD';
      return {
        action,
        confidence: Number(prob.toFixed(3)),
        probabilityWin: Number(prob.toFixed(3)),
      };
    };

    // Champion model artifact weights: standard momentum weights
    const champWeights = { smcScore: 2.5, relativeVolume: 1.2, return1Bar: 1.0 };
    // Challenger model artifact weights: ultra-conservative weighting requiring high mean reversion
    const challWeights = { smcScore: 0.1, relativeVolume: -1.5, return1Bar: -2.0 };

    const pipeline = new ProductionTradingPipeline({
      store,
      liveExecutionPort: mockLivePort,
      shadowExecutionPort: shadowSimulator,
      championModel,
      challengerModel,
      strategyConfig,
      championModelEvaluator: async (features) => evaluateArtifactWeights(features, champWeights, 1.0),
      challengerModelEvaluator: async (features) => evaluateArtifactWeights(features, challWeights, -1.0),
    });

    const marketEvent: LiveMarketEvent = {
      symbol: 'BTCUSDT',
      candles,
      timestamp: eventTime,
      bid: 99.5,
      ask: 100.5,
      volume: 10,
    };

    const portfolioState: LivePortfolioAccountState = {
      portfolioId: 'live-port-ml-diff',
      cash: 100000,
      equity: 100000,
      openPositions: [],
      timestamp: eventTime,
    };

    const { championDecision, pairPromise } = await pipeline.processMarketEvent(marketEvent, portfolioState);

    expect(championDecision.action).toBe('BUY');
    expect(championDecision.confidence).toBeGreaterThanOrEqual(0.70);
    expect(mockLivePort.submitLiveOrder).toHaveBeenCalledTimes(1);

    const pair = await pairPromise;
    expect(pair.challengerDecision.action).toBe('HOLD');
    expect(pair.challengerDecision.confidence).toBeLessThan(0.70);
    expect(pair.divergence).toBe('DISAGREE');
    expect(pair.divergenceType).toBe('CHAMPION_ONLY_ACTION');
  });

  it('Problem #4 & #5: proves atomic concurrency gate prevents duplicate live orders under parallel execution', async () => {
    const candles = generateCandles(60, 'BULLISH');
    const lastCandle = candles[candles.length - 1];
    const eventTime = lastCandle.timestamp.getTime();

    const mockLivePort: ILiveExecutionPort = {
      isLiveBroker: true,
      submitLiveOrder: jest.fn().mockResolvedValue({ liveOrderId: 'order-concurrent-1', status: 'PLACED' }),
      cancelLiveOrder: jest.fn().mockResolvedValue(true),
    };

    const store = new InMemoryShadowExecutionStore();
    const shadowSimulator = new ShadowExecutionSimulator();

    const strategyConfig = {
      deterministicSignal: {
        direction: Direction.BULLISH,
        score: 95,
        entryPrice: 100,
        stopLoss: 95,
        takeProfits: { tp1: 110, tp2: 120, tp3: 130 },
      },
    };

    const pipeline = new ProductionTradingPipeline({
      store,
      liveExecutionPort: mockLivePort,
      shadowExecutionPort: shadowSimulator,
      championModel,
      challengerModel,
      strategyConfig,
    });

    const marketEvent: LiveMarketEvent = {
      snapshotId: 'snap-concurrent-race-01',
      symbol: 'BTCUSDT',
      candles,
      timestamp: eventTime,
      bid: 99.5,
      ask: 100.5,
      volume: 10,
    };

    const portfolioState: LivePortfolioAccountState = {
      portfolioId: 'port-race-1',
      cash: 100000,
      equity: 100000,
      openPositions: [],
      timestamp: eventTime,
    };

    // Run 4 simultaneous concurrent workers racing on the EXACT same market event
    const results = await Promise.allSettled([
      pipeline.processMarketEvent(marketEvent, portfolioState),
      pipeline.processMarketEvent(marketEvent, portfolioState),
      pipeline.processMarketEvent(marketEvent, portfolioState),
      pipeline.processMarketEvent(marketEvent, portfolioState),
    ]);

    // At least 1 succeeded
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    // CRITICAL: Live order was submitted STRICTLY ONCE despite 4 concurrent callers
    expect(mockLivePort.submitLiveOrder).toHaveBeenCalledTimes(1);

    // Wait for shadow evaluation to complete
    const firstSuccess = (fulfilled[0] as PromiseFulfilledResult<any>).value;
    await firstSuccess.pairPromise;

    // Store contains strictly 1 decision pair and 1 snapshot
    expect(store.getAllPairs().length).toBe(1);
    expect(store.getAllSnapshots().length).toBe(1);
  });

  it('Cross-process concurrency: proves atomic file locks prevent duplicate live orders across distinct process instances', async () => {
    const testDir = path.join(__dirname, 'temp_prod_cross_proc_test');
    const testFile = path.join(testDir, 'cross-process-shadow.json');
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    fs.mkdirSync(testDir, { recursive: true });

    try {
      // Two completely separate FileShadowExecutionStore instances simulating 2 OS processes
      const proc1Store = new FileShadowExecutionStore(testFile);
      const proc2Store = new FileShadowExecutionStore(testFile);

      const mockLivePort1: ILiveExecutionPort = {
        isLiveBroker: true,
        submitLiveOrder: jest.fn().mockResolvedValue({ liveOrderId: 'p1-ord', status: 'PLACED' }),
        cancelLiveOrder: jest.fn().mockResolvedValue(true),
      };
      const mockLivePort2: ILiveExecutionPort = {
        isLiveBroker: true,
        submitLiveOrder: jest.fn().mockResolvedValue({ liveOrderId: 'p2-ord', status: 'PLACED' }),
        cancelLiveOrder: jest.fn().mockResolvedValue(true),
      };

      const strategyConfig = {
        deterministicSignal: {
          direction: Direction.BULLISH,
          score: 95,
          entryPrice: 100,
          stopLoss: 95,
          takeProfits: { tp1: 110, tp2: 120, tp3: 130 },
        },
      };

      const p1 = new ProductionTradingPipeline({
        store: proc1Store,
        liveExecutionPort: mockLivePort1,
        shadowExecutionPort: new ShadowExecutionSimulator(),
        championModel,
        challengerModel,
        strategyConfig,
      });

      const p2 = new ProductionTradingPipeline({
        store: proc2Store,
        liveExecutionPort: mockLivePort2,
        shadowExecutionPort: new ShadowExecutionSimulator(),
        championModel,
        challengerModel,
        strategyConfig,
      });

      const candles = generateCandles(60, 'BULLISH');
      const lastCandle = candles[candles.length - 1];
      const eventTime = lastCandle.timestamp.getTime();

      const event: LiveMarketEvent = {
        snapshotId: 'cross-proc-snap-01',
        symbol: 'BTCUSDT',
        candles,
        timestamp: eventTime,
        bid: lastCandle.close - 0.5,
        ask: lastCandle.close + 0.5,
        volume: 10,
      };

      const portState: LivePortfolioAccountState = {
        portfolioId: 'port-cross-1',
        cash: 100000,
        equity: 100000,
        openPositions: [],
        timestamp: eventTime,
      };

      // Execute concurrently from two independent process stores
      const results = await Promise.allSettled([
        p1.processMarketEvent(event, portState),
        p2.processMarketEvent(event, portState),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      // Exactly 1 live order placed across both processes
      const totalLiveOrders = (mockLivePort1.submitLiveOrder as jest.Mock).mock.calls.length +
                             (mockLivePort2.submitLiveOrder as jest.Mock).mock.calls.length;
      expect(totalLiveOrders).toBe(1);
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('Problem #7: proves slow Challenger does NOT block Champion execution return', async () => {
    const candles = generateCandles(60, 'BULLISH');
    const lastCandle = candles[candles.length - 1];
    const eventTime = lastCandle.timestamp.getTime();

    const mockLivePort: ILiveExecutionPort = {
      isLiveBroker: true,
      submitLiveOrder: jest.fn().mockResolvedValue({ liveOrderId: 'order-slow-chall', status: 'PLACED' }),
      cancelLiveOrder: jest.fn().mockResolvedValue(true),
    };

    const store = new InMemoryShadowExecutionStore();
    const shadowSimulator = new ShadowExecutionSimulator();

    const pipeline = new ProductionTradingPipeline({
      store,
      liveExecutionPort: mockLivePort,
      shadowExecutionPort: shadowSimulator,
      championModel,
      challengerModel,
      challengerModelEvaluator: async () => {
        // Artificially delay Challenger evaluation by 200ms
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { action: 'BUY', confidence: 0.88 };
      },
    });

    const marketEvent: LiveMarketEvent = {
      symbol: 'BTCUSDT',
      candles,
      timestamp: eventTime,
      bid: 99.5,
      ask: 100.5,
      volume: 10,
    };

    const portfolioState: LivePortfolioAccountState = {
      portfolioId: 'port-slow-test',
      cash: 100000,
      equity: 100000,
      openPositions: [],
      timestamp: eventTime,
    };

    const start = performance.now();
    const { championDecision, pairPromise } = await pipeline.processMarketEvent(marketEvent, portfolioState);
    const duration = performance.now() - start;

    // Champion critical path returns immediately (<50ms) without waiting for 200ms Challenger
    expect(duration).toBeLessThan(50);
    expect(championDecision.decisionId).toBeDefined();

    // Challenger completes in background asynchronously
    const pair = await pairPromise;
    expect(pair.challengerDecision.action).toBe('BUY');
  });

  it('5 & 6: proves Challenger is strictly shadow-only and cannot mutate live portfolio state', async () => {
    const candles = generateCandles(60, 'BULLISH');
    const lastCandle = candles[candles.length - 1];
    const eventTime = lastCandle.timestamp.getTime();

    const livePortfolioState: LivePortfolioAccountState = {
      portfolioId: 'live-port-isolation-test',
      cash: 500000,
      equity: 500000,
      openPositions: [{ symbol: 'BTCUSDT', size: 1.0, entryPrice: 90000 }],
      timestamp: eventTime,
    };

    const initialLiveCash = livePortfolioState.cash;
    const initialLiveEquity = livePortfolioState.equity;
    const initialLivePositionsCount = livePortfolioState.openPositions.length;

    const mockLivePort: ILiveExecutionPort = {
      isLiveBroker: true,
      submitLiveOrder: jest.fn().mockResolvedValue({ liveOrderId: 'live-ord-2', status: 'PLACED' }),
      cancelLiveOrder: jest.fn().mockResolvedValue(true),
    };

    const shadowSimulator = new ShadowExecutionSimulator({ initialCapital: 100000 });
    const store = new InMemoryShadowExecutionStore();

    const pipeline = new ProductionTradingPipeline({
      store,
      liveExecutionPort: mockLivePort,
      shadowExecutionPort: shadowSimulator,
      championModel,
      challengerModel,
      riskConfig: defaultRiskConfig,
    });

    const { pairPromise } = await pipeline.processMarketEvent({
      symbol: 'BTCUSDT',
      candles,
      timestamp: eventTime,
      bid: lastCandle.close - 1,
      ask: lastCandle.close + 1,
      volume: 100,
    }, livePortfolioState);

    await pairPromise;

    // Live portfolio state must remain COMPLETELY UNMUTATED by shadow execution
    expect(livePortfolioState.cash).toBe(initialLiveCash);
    expect(livePortfolioState.equity).toBe(initialLiveEquity);
    expect(livePortfolioState.openPositions.length).toBe(initialLivePositionsCount);

    // Shadow portfolio state is mutated in shadow simulator
    expect(shadowSimulator.getShadowCash()).toBeLessThanOrEqual(100000);
  });

  it('7: Golden Regression — PRE-PHASE-11 Champion === POST-PHASE-11 Champion through real production pipeline', async () => {
    const candles = generateCandles(60, 'BULLISH');
    const lastCandle = candles[candles.length - 1];
    const eventTime = lastCandle.timestamp.getTime();

    const strategyConfig = {
      deterministicSignal: {
        direction: Direction.BULLISH,
        score: 92,
        entryPrice: 100,
        stopLoss: 95,
        takeProfits: { tp1: 110, tp2: 120, tp3: 130 },
      },
    };

    // 1. PRE-PHASE-11 DIRECT EXECUTION (Reference)
    const preSignal = SignalGenerator.generateSignal({
      symbol: 'BTCUSDT',
      executionCandles: candles,
      executionTimeframe: Timeframe.M15,
      asOfTimestamp: lastCandle.timestamp,
      strategyConfig,
    });
    const preAction = preSignal.direction === Direction.BULLISH ? 'BUY' : preSignal.direction === Direction.BEARISH ? 'SELL' : 'HOLD';
    const preSizing = PositionSizer.calculatePosition({
      accountBalance: 100000,
      riskPercentage: defaultRiskConfig.riskPercentage,
      entryPrice: preSignal.entryZone?.optimal ?? lastCandle.close,
      stopLoss: preSignal.stopLoss,
      lotSize: defaultRiskConfig.lotSize,
      maxRiskPercentage: defaultRiskConfig.maxRiskPercentage,
      maxLeverage: defaultRiskConfig.maxLeverage,
    });

    // 2. POST-PHASE-11 PRODUCTION PIPELINE EXECUTION
    const store = new InMemoryShadowExecutionStore();
    const shadowSimulator = new ShadowExecutionSimulator();
    const pipeline = new ProductionTradingPipeline({
      store,
      shadowExecutionPort: shadowSimulator,
      championModel,
      challengerModel,
      riskConfig: defaultRiskConfig,
      strategyConfig,
    });

    const { championDecision } = await pipeline.processMarketEvent({
      symbol: 'BTCUSDT',
      candles,
      timestamp: eventTime,
      bid: lastCandle.close - 0.5,
      ask: lastCandle.close + 0.5,
      volume: lastCandle.volume,
    }, {
      portfolioId: 'port-1',
      cash: 100000,
      equity: 100000,
      openPositions: [],
      timestamp: eventTime,
    });

    // 3. ASSERT 100% GOLDEN REGRESSION EQUIVALENCE
    expect(championDecision.action).toBe(preAction);
    expect(championDecision.confidence).toBe(preSignal.score / 100);
    expect(championDecision.entryPrice).toBe(preSignal.entryZone?.optimal ?? lastCandle.close);
    expect(championDecision.stopLoss).toBe(preSignal.stopLoss);
    expect(championDecision.takeProfit).toBe(preSignal.takeProfits?.tp1 ?? 0);
    expect(championDecision.positionSize).toBe(preSizing.roundedUnits);
    expect(championDecision.riskAmount).toBe(preSizing.riskAmount);
  });

  it('10: Neutral / HOLD Scenario produces NO live order', async () => {
    // Generate flat candles that produce no breakout / neutral
    const candles = generateCandles(60, 'NEUTRAL');
    const lastCandle = candles[candles.length - 1];
    const eventTime = lastCandle.timestamp.getTime();

    const mockLivePort: ILiveExecutionPort = {
      isLiveBroker: true,
      submitLiveOrder: jest.fn().mockResolvedValue({ liveOrderId: 'order-should-not-exist', status: 'REJECTED' }),
      cancelLiveOrder: jest.fn().mockResolvedValue(true),
    };

    const store = new InMemoryShadowExecutionStore();
    const shadowSimulator = new ShadowExecutionSimulator();

    const pipeline = new ProductionTradingPipeline({
      store,
      liveExecutionPort: mockLivePort,
      shadowExecutionPort: shadowSimulator,
      championModel,
      challengerModel,
      strategyConfig: {
        minScore: 999, // Force NO_TRADE / HOLD
      },
    });

    const { championDecision } = await pipeline.processMarketEvent({
      symbol: 'BTCUSDT',
      candles,
      timestamp: eventTime,
      bid: lastCandle.close - 0.1,
      ask: lastCandle.close + 0.1,
      volume: 10,
    }, {
      portfolioId: 'port-1',
      cash: 100000,
      equity: 100000,
      openPositions: [],
      timestamp: eventTime,
    });

    expect(championDecision.action).toBe('HOLD');
    expect(championDecision.positionSize).toBe(0);
    expect(mockLivePort.submitLiveOrder).toHaveBeenCalledTimes(0);
  });

  it('12 & 13: Atomic idempotency & process restart recovery using FileShadowExecutionStore', async () => {
    const testDir = path.join(__dirname, 'temp_prod_shadow_test');
    const testFile = path.join(testDir, 'prod-shadow-execution.json');

    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });

    try {
      const store1 = new FileShadowExecutionStore(testFile);
      const shadowSimulator = new ShadowExecutionSimulator();

      const pipeline1 = new ProductionTradingPipeline({
        store: store1,
        shadowExecutionPort: shadowSimulator,
        championModel,
        challengerModel,
      });

      const candles = generateCandles(60, 'BULLISH');
      const lastCandle = candles[candles.length - 1];
      const eventTime = lastCandle.timestamp.getTime();

      const event: LiveMarketEvent = {
        snapshotId: 'snap-atomic-01',
        symbol: 'BTCUSDT',
        candles,
        timestamp: eventTime,
        bid: lastCandle.close - 0.5,
        ask: lastCandle.close + 0.5,
        volume: lastCandle.volume,
      };

      const portState: LivePortfolioAccountState = {
        portfolioId: 'port-atom-1',
        cash: 100000,
        equity: 100000,
        openPositions: [],
        timestamp: eventTime,
      };

      // 1. Process event first time
      const res1 = await pipeline1.processMarketEvent(event, portState);
      expect(res1.championDecision).toBeDefined();

      // 2. Process duplicate event -> Idempotently returns existing
      const res2 = await pipeline1.processMarketEvent(event, portState);
      expect(res2.championDecision.decisionId).toBe(res1.championDecision.decisionId);

      // 3. Process restart simulation
      const store2 = new FileShadowExecutionStore(testFile);
      expect(store2.getSnapshot('snap-atomic-01')?.snapshotId).toBe('snap-atomic-01');
      expect(store2.getDecision(res1.championDecision.decisionId)?.decisionId).toBe(res1.championDecision.decisionId);
    } finally {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    }
  });

  it('14: verifies outcome attribution causality without mutating DecisionContext', async () => {
    const candles = generateCandles(60, 'BULLISH');
    const lastCandle = candles[candles.length - 1];
    const eventTime = lastCandle.timestamp.getTime();

    const store = new InMemoryShadowExecutionStore();
    const shadowSimulator = new ShadowExecutionSimulator();

    const pipeline = new ProductionTradingPipeline({
      store,
      shadowExecutionPort: shadowSimulator,
      championModel,
      challengerModel,
    });

    const { championDecision } = await pipeline.processMarketEvent({
      symbol: 'BTCUSDT',
      candles,
      timestamp: eventTime,
      bid: lastCandle.close - 0.5,
      ask: lastCandle.close + 0.5,
      volume: lastCandle.volume,
    }, {
      portfolioId: 'port-1',
      cash: 100000,
      equity: 100000,
      openPositions: [],
      timestamp: eventTime,
    });

    const origFp = championDecision.decisionFingerprint;

    const outcome = ShadowOutcomeEvaluator.attributeOutcome({
      outcomeId: 'out-causality-1',
      decision: championDecision,
      outcomeStartTimestamp: eventTime,
      outcomeEndTimestamp: eventTime + 3600000,
      entryFill: {
        fillId: 'f-1',
        shadowOrderId: 'so-1',
        fillPrice: 100000,
        filledQuantity: 1,
        fillTimestamp: eventTime,
        fee: 10,
        slippage: 5,
      },
      exitFill: {
        fillId: 'f-exit-1',
        shadowOrderId: 'so-1',
        fillPrice: 105000,
        filledQuantity: 1,
        fillTimestamp: eventTime + 3600000,
        fee: 10,
        slippage: 0,
      },
      grossPnL: 5000,
      fees: 20,
      slippage: 5,
      netPnL: 4975,
      maxFavorableExcursion: 5200,
      maxAdverseExcursion: -100,
      holdingDurationMs: 3600000,
      exitReason: 'TARGET_HIT',
      outcomeStatus: 'EVALUATED',
    });

    expect(outcome.netPnL).toBe(4975);
    expect(championDecision.decisionFingerprint).toBe(origFp);
    expect(Object.isFrozen(championDecision)).toBe(true);
    expect(Object.isFrozen(championDecision.context)).toBe(true);
  });

  it('16: Fail-closed behavior on temporal invariant violations', async () => {
    const store = new InMemoryShadowExecutionStore();
    const shadowSimulator = new ShadowExecutionSimulator();

    const pipeline = new ProductionTradingPipeline({
      store,
      shadowExecutionPort: shadowSimulator,
      championModel,
      challengerModel,
      maxAllowedSkewMs: 1000,
    });

    const candles = generateCandles(60, 'BULLISH');
    const lastCandle = candles[candles.length - 1];
    const eventTime = lastCandle.timestamp.getTime();

    // Skewed portfolio snapshot (10 seconds older than market snapshot)
    await expect(async () => {
      await pipeline.processMarketEvent({
        symbol: 'BTCUSDT',
        candles,
        timestamp: eventTime,
        bid: 100000,
        ask: 100001,
        volume: 10,
      }, {
        portfolioId: 'port-skew',
        cash: 100000,
        equity: 100000,
        openPositions: [],
        timestamp: eventTime - 10000, // 10s skew
      });
    }).rejects.toThrow(/POINT_IN_TIME_SKEW_ERROR/);
  });
});
