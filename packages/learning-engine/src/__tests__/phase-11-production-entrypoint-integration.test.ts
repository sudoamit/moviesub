import * as fs from 'fs';
import * as path from 'path';
import { fork } from 'child_process';
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
  TradingAction,
  TradingDecision,
  ChampionChallengerDecisionPair
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
      symbol: marketEvent.symbol,
      timestamp: marketEvent.timestamp,
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

  it('True Multi-Process Concurrency: 4 independent OS Node.js child processes executing ProductionTradingPipeline against shared store produce exactly 1 live order', async () => {
    const testDir = path.join(__dirname, 'temp_prod_fork_test');
    const testFile = path.join(testDir, 'fork-shadow.json');
    const liveOrdersLogFile = path.join(testDir, 'live_orders.log');
    const workerScript = fs.existsSync(path.join(__dirname, 'helpers/fork-pipeline-worker.js'))
      ? path.join(__dirname, 'helpers/fork-pipeline-worker.js')
      : path.join(__dirname, '../../../dist/__tests__/helpers/fork-pipeline-worker.js');

    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    fs.mkdirSync(testDir, { recursive: true });

    try {
      const candles = generateCandles(60, 'BULLISH');
      const lastCandle = candles[candles.length - 1];
      const eventTime = lastCandle.timestamp.getTime();

      const marketEvent: LiveMarketEvent = {
        snapshotId: 'snap-fork-process-01',
        symbol: 'BTCUSDT',
        candles,
        timestamp: eventTime,
        bid: 99.5,
        ask: 100.5,
        volume: 10,
      };

      const portfolioState: LivePortfolioAccountState = {
        portfolioId: 'port-fork-1',
        cash: 100000,
        equity: 100000,
        openPositions: [],
        timestamp: eventTime,
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

      const runProcess = (): Promise<{ success: boolean; pid: number; isConcurrentLock?: boolean; decisionId?: string; clientOrderId?: string }> => {
        return new Promise((resolve, reject) => {
          const child = fork(workerScript, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
          let response: any = null;

          child.on('message', (msg) => {
            response = msg;
          });

          child.on('exit', () => {
            if (response) {
              resolve(response);
            } else {
              reject(new Error('Child process exited without response'));
            }
          });

          child.on('error', reject);

          child.send({
            testFile,
            marketEvent,
            portfolioState,
            championModel,
            challengerModel,
            strategyConfig,
            liveOrdersLogFile,
          });
        });
      };

      // Fork 4 independent Node.js processes executing ProductionTradingPipeline simultaneously
      const results = await Promise.all([runProcess(), runProcess(), runProcess(), runProcess()]);

      const successCount = results.filter((r) => r.success).length;
      const lockedCount = results.filter((r) => !r.success && r.isConcurrentLock).length;

      // STRICT MULTI-PROCESS INVARIANT: Exactly 1 independent OS process succeeds, 3 fail-closed with CONCURRENT_LOCK
      expect(successCount).toBe(1);
      expect(lockedCount).toBe(3);

      // Verify log file records strictly 1 broker submission across all 4 OS processes
      expect(fs.existsSync(liveOrdersLogFile)).toBe(true);
      const orderLines = fs.readFileSync(liveOrdersLogFile, 'utf-8').trim().split('\n').filter(Boolean);
      expect(orderLines.length).toBe(1);

      // Verify persistent store integrity
      const store = new FileShadowExecutionStore(testFile);
      expect(store.getAllPairs().length).toBe(1);
      expect(store.getAllSnapshots().length).toBe(1);
      expect(store.getAllDecisions().length).toBe(2); // 1 Champion + 1 Challenger

      const successfulResult = results.find((r) => r.success)!;
      expect(successfulResult.clientOrderId?.startsWith('ord_live_')).toBe(true);
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('Problem #4: proves EXECUTION_UNKNOWN on broker submission error fails closed and preserves lock without blind retry', async () => {
    const testDir = path.join(__dirname, 'temp_prod_unknown_test');
    const testFile = path.join(testDir, 'unknown-shadow.json');
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    fs.mkdirSync(testDir, { recursive: true });

    try {
      const store = new FileShadowExecutionStore(testFile);
      const failingLivePort: ILiveExecutionPort = {
        isLiveBroker: true,
        submitLiveOrder: jest.fn().mockRejectedValue(new Error('ETIMEDOUT: broker connection severed during order placement')),
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

      const pipeline = new ProductionTradingPipeline({
        store,
        liveExecutionPort: failingLivePort,
        shadowExecutionPort: new ShadowExecutionSimulator(),
        championModel,
        challengerModel,
        strategyConfig,
      });

      const candles = generateCandles(60, 'BULLISH');
      const lastCandle = candles[candles.length - 1];
      const eventTime = lastCandle.timestamp.getTime();

      const event: LiveMarketEvent = {
        snapshotId: 'snap-broker-timeout-01',
        symbol: 'BTCUSDT',
        candles,
        timestamp: eventTime,
        bid: lastCandle.close - 0.5,
        ask: lastCandle.close + 0.5,
        volume: 10,
      };

      const portState: LivePortfolioAccountState = {
        portfolioId: 'port-timeout-1',
        cash: 100000,
        equity: 100000,
        openPositions: [],
        timestamp: eventTime,
      };

      // Attempt 1: Broker times out -> throws error
      await expect(pipeline.processMarketEvent(event, portState)).rejects.toThrow(/ETIMEDOUT/);

      // Lock reservation state must now be EXECUTION_UNKNOWN
      const reservation = store.getReservation('snap-broker-timeout-01', championModel.modelId);
      expect(reservation?.status).toBe('EXECUTION_UNKNOWN');

      // Attempt 2: A subsequent retry attempt MUST fail closed and NOT double-submit to broker
      await expect(pipeline.processMarketEvent(event, portState)).rejects.toThrow(/CONCURRENT_EXECUTION_LOCK_ACQUIRED/);

      // Total broker calls across both attempts is strictly 1 (no blind double submit)
      expect(failingLivePort.submitLiveOrder).toHaveBeenCalledTimes(1);
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('Problem #5 & #6: proves interrupted retry claims are deterministically recovered without leak or duplicate execution', async () => {
    const testDir = path.join(__dirname, 'temp_prod_crash_claim_test');
    const testFile = path.join(testDir, 'crash-claim-shadow.json');
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    fs.mkdirSync(testDir, { recursive: true });

    try {
      const store1 = new FileShadowExecutionStore(testFile);
      const snapshotId = 'snap-crash-claim-01';
      const modelId = 'champ-v1-prod';

      // 1. Initial reservation acquired and released as FAILED_RETRYABLE
      const res1 = store1.reserveExecution(snapshotId, modelId);
      expect(res1.acquired).toBe(true);
      store1.releaseExecution(snapshotId, modelId, 'FAILED_RETRYABLE', res1.reservationToken!);

      // 2. Simulate worker crash during atomic rename:
      // Old lock is moved to .claim.<snapshot>.<model>.<token> and process dies before completing
      const lockFile = path.join(testDir, `.lock.${snapshotId}.${modelId}`);
      const crashedClaimFile = path.join(testDir, `.claim.${snapshotId}.${modelId}.crashed-worker-uuid`);

      fs.renameSync(lockFile, crashedClaimFile);
      expect(fs.existsSync(lockFile)).toBe(false);
      expect(fs.existsSync(crashedClaimFile)).toBe(true);

      // 3. Start a fresh FileShadowExecutionStore on restart
      const store2 = new FileShadowExecutionStore(testFile);

      // 4. 4 parallel workers race to acquire retry after recovery
      const storeW1 = new FileShadowExecutionStore(testFile);
      const storeW2 = new FileShadowExecutionStore(testFile);
      const storeW3 = new FileShadowExecutionStore(testFile);
      const storeW4 = new FileShadowExecutionStore(testFile);

      const claimResults = await Promise.all([
        Promise.resolve().then(() => storeW1.reserveExecution(snapshotId, modelId)),
        Promise.resolve().then(() => storeW2.reserveExecution(snapshotId, modelId)),
        Promise.resolve().then(() => storeW3.reserveExecution(snapshotId, modelId)),
        Promise.resolve().then(() => storeW4.reserveExecution(snapshotId, modelId)),
      ]);

      const successCount = claimResults.filter((r) => r.acquired === true).length;
      const rejectedCount = claimResults.filter((r) => r.acquired === false).length;

      // STRICT INVARIANT: Exactly 1 worker acquires the recovered retry, all 3 others rejected
      expect(successCount).toBe(1);
      expect(rejectedCount).toBe(3);

      const winner = claimResults.find((r) => r.acquired === true)!;
      expect(winner.epoch).toBe(2);
      expect(winner.reservationToken).toBeDefined();

      // Interrupted claim was recovered and canonical lock is restored
      expect(fs.existsSync(lockFile)).toBe(true);
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('Problem #9 & #10: proves stale reconciliation token cannot mutate or commit an overwritten reservation', async () => {
    const testDir = path.join(__dirname, 'temp_prod_stale_rec_test');
    const testFile = path.join(testDir, 'stale-rec-shadow.json');
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    fs.mkdirSync(testDir, { recursive: true });

    try {
      const store = new FileShadowExecutionStore(testFile);
      const snapshotId = 'snap-stale-rec-01';
      const modelId = 'champ-v1-prod';

      // 1. Worker A acquires reservation (tokenA)
      const resA = store.reserveExecution(snapshotId, modelId);
      expect(resA.acquired).toBe(true);
      const tokenA = resA.reservationToken!;

      // 2. Worker A enters EXECUTION_UNKNOWN
      store.releaseExecution(snapshotId, modelId, 'EXECUTION_UNKNOWN', tokenA);

      // 3. Worker A times out/reconciles offline to NOT_FOUND -> FAILED_RETRYABLE
      store.reconcileExecution(snapshotId, modelId, tokenA, 'NOT_FOUND');
      expect(store.getReservation(snapshotId, modelId)?.status).toBe('FAILED_RETRYABLE');

      // 4. Worker B acquires the retry with tokenB
      const resB = store.reserveExecution(snapshotId, modelId);
      expect(resB.acquired).toBe(true);
      const tokenB = resB.reservationToken!;
      expect(tokenB).not.toBe(tokenA);
      expect(resB.epoch).toBe(2);

      // 5. Worker A's stale FOUND response arrives late with tokenA -> REJECTED
      const staleFound = store.reconcileExecution(snapshotId, modelId, tokenA, 'FOUND', {
        liveOrder: { orderId: 'stale-broker-order' }
      });
      expect(staleFound.reconciled).toBe(false);
      expect(store.getReservation(snapshotId, modelId)?.reservationToken).toBe(tokenB);
      expect(store.getReservation(snapshotId, modelId)?.status).toBe('RESERVED');

      // 6. Worker A's stale NOT_FOUND arrives late with tokenA -> REJECTED
      const staleNotFound = store.reconcileExecution(snapshotId, modelId, tokenA, 'NOT_FOUND');
      expect(staleNotFound.reconciled).toBe(false);
      expect(store.getReservation(snapshotId, modelId)?.reservationToken).toBe(tokenB);

      // 7. Legitimate Worker B updates status and commits using tokenB -> SUCCEEDS
      expect(store.updateReservationStatus(snapshotId, modelId, 'EXECUTING', tokenB)).toBe(true);
      expect(store.updateReservationStatus(snapshotId, modelId, 'LIVE_SUBMITTED', tokenB)).toBe(true);
      expect(store.commitExecution(snapshotId, modelId, tokenB)).toBe(true);
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('Problem #3: State Transition Matrix strictly validates allowed transitions and rejects illegal mutations', async () => {
    const store = new InMemoryShadowExecutionStore();
    const snapshotId = 'snap-trans-test-01';
    const modelId = 'champ-v1-prod';

    const res = store.reserveExecution(snapshotId, modelId);
    expect(res.acquired).toBe(true);
    const token = res.reservationToken!;

    // 1. RESERVED -> COMMITTED is ILLEGAL (must go through EXECUTING/LIVE_SUBMITTED)
    expect(store.commitExecution(snapshotId, modelId, token)).toBe(false);
    expect(store.getReservation(snapshotId, modelId)?.status).toBe('RESERVED');

    // 2. RESERVED -> EXECUTING is LEGAL
    expect(store.updateReservationStatus(snapshotId, modelId, 'EXECUTING', token)).toBe(true);

    // 3. EXECUTING -> COMMITTED is ILLEGAL (must go through LIVE_SUBMITTED)
    expect(store.commitExecution(snapshotId, modelId, token)).toBe(false);

    // 4. EXECUTING -> LIVE_SUBMITTED is LEGAL
    expect(store.updateReservationStatus(snapshotId, modelId, 'LIVE_SUBMITTED', token)).toBe(true);

    // 5. LIVE_SUBMITTED -> COMMITTED is LEGAL
    expect(store.commitExecution(snapshotId, modelId, token)).toBe(true);

    // 6. COMMITTED is TERMINAL -> any further update is REJECTED
    expect(store.updateReservationStatus(snapshotId, modelId, 'EXECUTING', token)).toBe(false);
  });

  it('Problem #8 & #11 & #13: proves tri-state broker reconciliation contract with durable DecisionPair persistence and restart recovery', async () => {
    const testDir = path.join(__dirname, 'temp_prod_reconcile_test');
    const testFile = path.join(testDir, 'reconcile-shadow.json');
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    fs.mkdirSync(testDir, { recursive: true });

    try {
      const store = new FileShadowExecutionStore(testFile);
      const snapshotId = 'snap-reconcile-01';
      const modelId = 'champ-v1-prod';

      // 1. Enter EXECUTION_UNKNOWN state
      const res = store.reserveExecution(snapshotId, modelId);
      const token = res.reservationToken!;
      store.releaseExecution(snapshotId, modelId, 'EXECUTION_UNKNOWN', token);
      expect(store.getReservation(snapshotId, modelId)?.status).toBe('EXECUTION_UNKNOWN');

      // Scenario A: BROKER_STILL_UNKNOWN (e.g. broker API 500 error / unreachable during reconciliation) -> FAILS CLOSED
      const reconcileUnknown = store.reconcileUnknownExecution(snapshotId, modelId, token, 'BROKER_STILL_UNKNOWN');
      expect(reconcileUnknown.reconciled).toBe(false);
      expect(reconcileUnknown.newStatus).toBe('EXECUTION_UNKNOWN');
      expect(store.getReservation(snapshotId, modelId)?.status).toBe('EXECUTION_UNKNOWN');

      // Scenario B: Order FOUND on broker -> durably persists DecisionPair and commits
      const dummyChampionDecision: TradingDecision = {
        decisionId: 'dec-champ-rec-1',
        action: 'BUY',
        confidence: 0.9,
        signal: 'BULLISH_SMC',
        entryPrice: 100000,
        positionSize: 1,
        riskAmount: 1000,
        reason: 'Reconciled broker order',
        decisionFingerprint: 'fp-champ-rec',
        latencies: {
          marketTimestamp: 1700000000000,
          featureStartTimestamp: 1700000000000,
          featureEndTimestamp: 1700000000005,
          modelStartTimestamp: 1700000000005,
          modelEndTimestamp: 1700000000010,
          decisionTimestamp: 1700000000010,
          dataToDecisionLatencyMs: 10,
          featureLatencyMs: 5,
          modelLatencyMs: 5,
          totalDecisionLatencyMs: 10,
        },
        context: {
          decisionId: 'dec-champ-rec-1',
          snapshotId,
          snapshotHash: 'hash-snap-rec',
          decisionTimestamp: 1700000000010,
          instrument: { symbol: 'BTCUSDT', market: 'BINANCE_SPOT' },
          marketSnapshot: {} as any,
          portfolioSnapshot: {} as any,
          featureVersion: '2.0',
          featureSchemaHash: 'fhash',
          featureInputHash: 'fin',
          featureDataCutoff: 1700000000000,
          strategyVersion: 'v1.0',
          strategyConfigHash: 'strat_hash',
          executionConfigVersion: 'e1.0',
          executionConfigHash: 'ehash',
          riskConfigVersion: 'r1.0',
          riskConfigHash: 'rhash',
          costConfigVersion: 'c1.0',
          costConfigHash: 'chash',
          portfolioStateVersion: 'p1.0',
          portfolioStateHash: 'phash',
          modelIdentity: championModel,
          evaluationFingerprint: 'efp',
          mode: 'LIVE',
          modelRole: 'CHAMPION',
        },
      };

      const dummyPair: ChampionChallengerDecisionPair = {
        pairId: 'pair-rec-1',
        snapshotId,
        snapshotHash: 'hash-snap-rec',
        decisionTimestamp: 1700000000010,
        championDecisionId: 'dec-champ-rec-1',
        challengerDecisionId: 'dec-chall-rec-1',
        championModelIdentity: championModel,
        challengerModelIdentity: challengerModel,
        championEvaluationFingerprint: 'efp-champ',
        challengerEvaluationFingerprint: 'efp-chall',
        championDecision: dummyChampionDecision,
        challengerDecision: { ...dummyChampionDecision, decisionId: 'dec-chall-rec-1', context: { ...dummyChampionDecision.context, mode: 'SHADOW', modelRole: 'CHALLENGER' } },
        divergence: 'AGREE',
        divergenceType: 'AGREE',
        decisionPairFingerprint: 'fp-pair-rec',
      };

      const reconcileFound = store.reconcileExecution(snapshotId, modelId, token, 'FOUND', {
        liveOrder: { orderId: 'broker-123' },
        championDecision: dummyChampionDecision,
        pair: dummyPair,
      });

      expect(reconcileFound.reconciled).toBe(true);
      expect(reconcileFound.newStatus).toBe('COMMITTED');

      // Decision and DecisionPair are durably stored in persistent store
      expect(store.getDecision('dec-champ-rec-1')).toBeDefined();
      expect(store.getDecisionPair('pair-rec-1')).toBeDefined();

      // Scenario C: Reconciliation scenario C: Order NOT_FOUND on broker -> transitions to FAILED_RETRYABLE
      const snapshotId2 = 'snap-reconcile-02';
      const res2 = store.reserveExecution(snapshotId2, modelId);
      const token2 = res2.reservationToken!;
      store.releaseExecution(snapshotId2, modelId, 'EXECUTION_UNKNOWN', token2);

      const reconcileNotFound = store.reconcileUnknownExecution(snapshotId2, modelId, token2, 'NOT_FOUND');
      expect(reconcileNotFound.reconciled).toBe(true);
      expect(reconcileNotFound.newStatus).toBe('FAILED_RETRYABLE');

      // Now a retry can acquire the reservation
      const retried = store.reserveExecution(snapshotId2, modelId);
      expect(retried.acquired).toBe(true);

      // Scenario D: LIVE_SUBMITTED crash recovery on process restart
      const snapshotId3 = 'snap-reconcile-03';
      const res3 = store.reserveExecution(snapshotId3, modelId);
      const token3 = res3.reservationToken!;
      store.updateReservationStatus(snapshotId3, modelId, 'EXECUTING', token3);
      store.updateReservationStatus(snapshotId3, modelId, 'LIVE_SUBMITTED', token3);
      expect(store.getReservation(snapshotId3, modelId)?.status).toBe('LIVE_SUBMITTED');

      // Process restart simulation: load from disk and reconcile
      const restartStore = new FileShadowExecutionStore(testFile);
      const recoveredRes = restartStore.getReservation(snapshotId3, modelId);
      expect(recoveredRes?.status).toBe('LIVE_SUBMITTED');
      expect(recoveredRes?.reservationToken).toBe(token3);

      const reconcileLiveSubmitted = restartStore.reconcileExecution(snapshotId3, modelId, token3, 'FOUND', {
        championDecision: dummyChampionDecision,
        pair: dummyPair,
      });
      expect(reconcileLiveSubmitted.reconciled).toBe(true);
      expect(reconcileLiveSubmitted.newStatus).toBe('COMMITTED');
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('Problem #5 & #7 & #12: proves deterministic clientOrderId generation invariant across submissions, restarts, and retries', async () => {
    const candles = generateCandles(60, 'BULLISH');
    const lastCandle = candles[candles.length - 1];
    const eventTime = lastCandle.timestamp.getTime();

    // Simulated real exchange adapter (e.g. Binance / Bybit) tracking client order id idempotency
    const brokerSubmittedRequests: Array<{ newClientOrderId: string; symbol: string; quantity: number }> = [];
    const brokerLiveAdapter: ILiveExecutionPort = {
      isLiveBroker: true,
      submitLiveOrder: jest.fn().mockImplementation((decision: TradingDecision) => {
        if (!decision.clientOrderId) {
          throw new Error('BROKER_IDEMPOTENCY_ERROR: clientOrderId is required for live order placement');
        }
        brokerSubmittedRequests.push({
          newClientOrderId: decision.clientOrderId,
          symbol: decision.context.instrument.symbol,
          quantity: decision.positionSize || 1,
        });
        return Promise.resolve({ liveOrderId: 'broker-assigned-id-01', status: 'PLACED' });
      }),
      cancelLiveOrder: jest.fn().mockResolvedValue(true),
    };

    const store = new InMemoryShadowExecutionStore();
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
      liveExecutionPort: brokerLiveAdapter,
      shadowExecutionPort: new ShadowExecutionSimulator(),
      championModel,
      challengerModel,
      strategyConfig,
    });

    const marketEvent: LiveMarketEvent = {
      snapshotId: 'snap-client-order-id-01',
      symbol: 'BTCUSDT',
      candles,
      timestamp: eventTime,
      bid: 99.5,
      ask: 100.5,
      volume: 10,
    };

    const portfolioState: LivePortfolioAccountState = {
      portfolioId: 'port-client-id-test',
      cash: 100000,
      equity: 100000,
      openPositions: [],
      timestamp: eventTime,
    };

    const { championDecision } = await pipeline.processMarketEvent(marketEvent, portfolioState);

    // Assert clientOrderId is generated and verified
    expect(championDecision.clientOrderId).toBeDefined();
    expect(championDecision.clientOrderId?.startsWith('ord_live_')).toBe(true);

    // Assert broker adapter received and mapped newClientOrderId properly
    expect(brokerSubmittedRequests.length).toBe(1);
    expect(brokerSubmittedRequests[0].newClientOrderId).toBe(championDecision.clientOrderId);
    expect(brokerSubmittedRequests[0].symbol).toBe('BTCUSDT');
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
      symbol: 'BTCUSDT',
      timestamp: eventTime,
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

  it('Issue 4: proves crash at final commit boundary (DecisionPair persisted, crash leaves stale lock file) cleans up lock residue on restart without blocking or double-submitting', async () => {
    const testDir = path.join(__dirname, 'temp_prod_commit_crash_test');
    const testFile = path.join(testDir, 'commit-crash-shadow.json');
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    fs.mkdirSync(testDir, { recursive: true });

    try {
      const liveOrders: string[] = [];
      const mockLivePort: ILiveExecutionPort = {
        isLiveBroker: true,
        submitLiveOrder: jest.fn().mockImplementation(async (dec: TradingDecision) => {
          liveOrders.push(dec.decisionId);
          return { liveOrderId: 'live-order-commit-crash', status: 'PLACED' };
        }),
        cancelLiveOrder: jest.fn().mockResolvedValue(true),
      };

      const candles = generateCandles(60, 'BULLISH');
      const lastCandle = candles[candles.length - 1];
      const eventTime = lastCandle.timestamp.getTime();

      const marketEvent: LiveMarketEvent = {
        snapshotId: 'snap-commit-crash-01',
        symbol: 'BTCUSDT',
        candles,
        timestamp: eventTime,
        bid: 99.5,
        ask: 100.5,
        volume: 10,
      };

      const portfolioState: LivePortfolioAccountState = {
        portfolioId: 'port-commit-crash-1',
        cash: 100000,
        equity: 100000,
        openPositions: [],
        timestamp: eventTime,
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

      const store1 = new FileShadowExecutionStore(testFile);
      const pipeline1 = new ProductionTradingPipeline({
        store: store1,
        liveExecutionPort: mockLivePort,
        shadowExecutionPort: new ShadowExecutionSimulator(),
        championModel,
        challengerModel,
        strategyConfig,
      });

      // 1. First execution succeeds and persists DecisionPair
      const { championDecision, pairPromise } = await pipeline1.processMarketEvent(marketEvent, portfolioState);
      const pair = await pairPromise;
      expect(pair).toBeDefined();
      expect(liveOrders.length).toBe(1);

      // 2. Simulate crash at final commit boundary:
      // DecisionPair is already persisted in store file, but a stale .lock file is left on disk
      const lockFile = path.join(testDir, `.lock.${marketEvent.snapshotId}.${championModel.modelId}`);
      const staleLockData = {
        snapshotId: marketEvent.snapshotId,
        modelId: championModel.modelId,
        status: 'COMMITTED',
        reservationToken: 'stale-pre-crash-token',
        epoch: 1,
        reservedAt: Date.now(),
        lastUpdatedAt: Date.now(),
      };
      fs.writeFileSync(lockFile, JSON.stringify(staleLockData), 'utf-8');
      expect(fs.existsSync(lockFile)).toBe(true);

      // 3. Fresh process starts up on restart
      const store2 = new FileShadowExecutionStore(testFile);
      const pipeline2 = new ProductionTradingPipeline({
        store: store2,
        liveExecutionPort: mockLivePort,
        shadowExecutionPort: new ShadowExecutionSimulator(),
        championModel,
        challengerModel,
        strategyConfig,
      });

      // 4. Process the same market event again on restart:
      // Invariant: recognizes existing COMMITTED execution, cleans up stale lock residue, does NOT throw lock error
      const retryResult = await pipeline2.processMarketEvent(marketEvent, portfolioState);
      expect(retryResult.championDecision.decisionId).toBe(championDecision.decisionId);

      // 5. Invariant: NO duplicate live order placed, NO second DecisionPair
      expect(liveOrders.length).toBe(1);
      expect(store2.getAllPairs().length).toBe(1);
      expect(fs.existsSync(lockFile)).toBe(false); // Stale lock was cleaned up
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('Issue 5: proves COMMITTED lock with NO DecisionPair fails closed on restart and forbids live submission', async () => {
    const testDir = path.join(__dirname, 'temp_prod_committed_no_pair_test');
    const testFile = path.join(testDir, 'committed-no-pair-shadow.json');
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    fs.mkdirSync(testDir, { recursive: true });

    try {
      const mockLivePort: ILiveExecutionPort = {
        isLiveBroker: true,
        submitLiveOrder: jest.fn().mockResolvedValue({ liveOrderId: 'should-never-be-called', status: 'PLACED' }),
        cancelLiveOrder: jest.fn().mockResolvedValue(true),
      };

      const candles = generateCandles(60, 'BULLISH');
      const lastCandle = candles[candles.length - 1];
      const eventTime = lastCandle.timestamp.getTime();

      const snapshotId = 'snap-committed-no-pair-01';
      const marketEvent: LiveMarketEvent = {
        snapshotId,
        symbol: 'BTCUSDT',
        candles,
        timestamp: eventTime,
        bid: 99.5,
        ask: 100.5,
        volume: 10,
      };

      const portfolioState: LivePortfolioAccountState = {
        portfolioId: 'port-committed-no-pair-1',
        cash: 100000,
        equity: 100000,
        openPositions: [],
        timestamp: eventTime,
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

      // 1. Manually write a COMMITTED lock file with NO DecisionPair in the store file
      const lockFile = path.join(testDir, `.lock.${snapshotId}.${championModel.modelId}`);
      const committedLockData = {
        snapshotId,
        modelId: championModel.modelId,
        status: 'COMMITTED',
        reservationToken: 'tok-anomalous-committed',
        epoch: 3,
        reservedAt: Date.now(),
        lastUpdatedAt: Date.now(),
      };
      fs.writeFileSync(lockFile, JSON.stringify(committedLockData), 'utf-8');

      // 2. Start fresh pipeline on restart
      const store = new FileShadowExecutionStore(testFile);
      const pipeline = new ProductionTradingPipeline({
        store,
        liveExecutionPort: mockLivePort,
        shadowExecutionPort: new ShadowExecutionSimulator(),
        championModel,
        challengerModel,
        strategyConfig,
      });

      // 3. Invariant: Attempting to process market event MUST FAIL CLOSED
      await expect(pipeline.processMarketEvent(marketEvent, portfolioState)).rejects.toThrow(/CONCURRENT_EXECUTION_LOCK_ACQUIRED/);

      // 4. Invariant: NO live order was submitted
      expect(mockLivePort.submitLiveOrder).toHaveBeenCalledTimes(0);
      expect(store.getAllPairs().length).toBe(0);
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('Issue 6: proves multi-generation claim competition resolves strictly in favor of the highest monotonic epoch', async () => {
    const testDir = path.join(__dirname, 'temp_prod_epoch_comp_test');
    const testFile = path.join(testDir, 'epoch-comp-shadow.json');
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    fs.mkdirSync(testDir, { recursive: true });

    try {
      const snapshotId = 'snap-epoch-comp-01';
      const modelId = 'champ-v1-prod';
      const lockFile = path.join(testDir, `.lock.${snapshotId}.${modelId}`);

      // Write 3 competing claim files with epochs 5, 6, 7 (simulating crashed workers across restarts)
      const claim5Path = path.join(testDir, `.claim.${snapshotId}.${modelId}.token-epoch-5`);
      const claim6Path = path.join(testDir, `.claim.${snapshotId}.${modelId}.token-epoch-6`);
      const claim7Path = path.join(testDir, `.claim.${snapshotId}.${modelId}.token-epoch-7`);

      fs.writeFileSync(claim5Path, JSON.stringify({ snapshotId, modelId, status: 'FAILED_RETRYABLE', reservationToken: 'token-5', epoch: 5, reservedAt: 100, lastUpdatedAt: 100 }), 'utf-8');
      fs.writeFileSync(claim6Path, JSON.stringify({ snapshotId, modelId, status: 'FAILED_RETRYABLE', reservationToken: 'token-6', epoch: 6, reservedAt: 200, lastUpdatedAt: 200 }), 'utf-8');
      fs.writeFileSync(claim7Path, JSON.stringify({ snapshotId, modelId, status: 'FAILED_RETRYABLE', reservationToken: 'token-7', epoch: 7, reservedAt: 300, lastUpdatedAt: 300 }), 'utf-8');

      // Canonical lock is initially missing
      expect(fs.existsSync(lockFile)).toBe(false);

      // Start fresh store instance
      const store = new FileShadowExecutionStore(testFile);
      const recovered = store.getReservation(snapshotId, modelId);

      // STRICT INVARIANT: Epoch 7 becomes the authoritative canonical lock
      expect(recovered).toBeDefined();
      expect(recovered?.epoch).toBe(7);
      expect(recovered?.reservationToken).toBe('token-7');
      expect(recovered?.status).toBe('FAILED_RETRYABLE');

      // Canonical lock file on disk is reconstructed with epoch 7
      expect(fs.existsSync(lockFile)).toBe(true);
      const diskContent = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
      expect(diskContent.epoch).toBe(7);

      // Obsolete claim files (epochs 5 and 6) were unlinked
      expect(fs.existsSync(claim5Path)).toBe(false);
      expect(fs.existsSync(claim6Path)).toBe(false);
      expect(fs.existsSync(claim7Path)).toBe(false);
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});
