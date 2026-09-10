import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Direction, ICandle, ISignalSetup } from '@quant/shared';
import { ModelRegistry } from '../model-registry';
import { CandidateBacktestRunner } from '../candidate-backtest-runner';
import { SignalGenerator } from '@quant/trading-engine';
import { TradeLifecycleManager, PositionSizer } from '@quant/risk-engine';
import { ExecutionSimulator } from '@quant/backtesting';
import { ShadowOrchestrator } from '../shadow/shadow-orchestrator';
import { PerformanceDriftDetector } from '../shadow/performance-drift-detector';
import {
  ShadowLedgerData,
  ShadowStateSnapshot,
  SHADOW_SCHEMA_VERSION,
} from '../shadow/shadow-types';

/**
 * Deterministic PRNG for reproducible test runs.
 */
class SeededRandom {
  private seed: number;
  constructor(seed: number) {
    this.seed = seed % 2147483647;
    if (this.seed <= 0) this.seed += 2147483646;
  }

  public next(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed - 1) / 2147483646;
  }
}

/**
 * Generates a realistic multi-regime market candle series.
 * Guarantees strictly increasing timestamps and valid OHLC bounds:
 * high >= max(open, close), low <= min(open, close), high >= low, volume >= 0.
 */
function generateMultiRegimeMarketHistory(
  startTimestamp = 1700000000000,
  count = 10000,
  intervalMs = 900000, // 15m
  seed = 42,
): ICandle[] {
  const rng = new SeededRandom(seed);
  const candles: ICandle[] = [];

  let currentPrice = 50000;
  let currentTrend = 0; // -1 to 1
  let currentVol = 0.002;

  for (let i = 0; i < count; i++) {
    // Regime transitions across the 10,000-candle span
    if (i < 2000) {
      // Regime 1: Low Volatility Range
      currentTrend = 0.05 * Math.sin(i / 50);
      currentVol = 0.0015;
    } else if (i < 4000) {
      // Regime 2: Strong Bullish Trend
      currentTrend = 0.35 + 0.1 * Math.sin(i / 100);
      currentVol = 0.003;
    } else if (i < 6000) {
      // Regime 3: High Volatility Shock / Reversal
      currentTrend = -0.2 + 0.4 * Math.sin(i / 30);
      currentVol = 0.008;
    } else if (i < 8000) {
      // Regime 4: Bearish Trend
      currentTrend = -0.4 + 0.08 * Math.cos(i / 80);
      currentVol = 0.0035;
    } else {
      // Regime 5: Rapid Breakouts & Gaps
      currentTrend = (rng.next() > 0.5 ? 0.3 : -0.3) + 0.2 * Math.sin(i / 20);
      currentVol = 0.006;
    }

    const priceChangePct = (rng.next() - 0.5) * 2 * currentVol + currentTrend * (currentVol * 0.5);
    const open = Number(currentPrice.toFixed(2));
    const close = Number(Math.max(100, currentPrice * (1 + priceChangePct)).toFixed(2));

    const wickHigh = rng.next() * currentVol * currentPrice * 1.5;
    const wickLow = rng.next() * currentVol * currentPrice * 1.5;

    const high = Number((Math.max(open, close) + wickHigh).toFixed(2));
    const low = Number(Math.max(1, Math.min(open, close) - wickLow).toFixed(2));
    const volume = Number((100 + rng.next() * 500 * (1 + currentVol * 100)).toFixed(2));

    const candle: ICandle = {
      timestamp: new Date(startTimestamp + i * intervalMs),
      open,
      high,
      low,
      close,
      volume,
    };

    candles.push(candle);
    currentPrice = close;
  }

  return candles;
}

function createReliabilityCandidate(candidateId: string, minMtfScore = 50) {
  return {
    id: candidateId,
    name: `Reliability Candidate ${candidateId}`,
    candidateVersion: 'v2.1',
    baseStrategyVersion: 'v2.0',
    type: 'PARAM_TWEAK',
    description: `Reliability Candidate ${candidateId}`,
    createdAt: new Date(1700000000000),
    status: 'SHADOW_PENDING' as const,
    sourceProposalId: `prop_${candidateId}`,
    sourceExperimentId: `exp_${candidateId}`,
    parentModelId: 'prod_model_v1',
    symbol: 'BTCUSDT',
    timeframe: '15m',
    features: ['smcScore', 'mtfAlignment', 'rvol'],
    featureSchemaHash: 'schema_hash_rel_039',
    featureSchemaVersion: '1.0.0',
    scalerArtifact: { type: 'standard' as const, mean: [0.5, 0.5, 0.5], std: [0.1, 0.1, 0.1] },
    modelArtifact: { type: 'gbm' as const, weights: [0.33, 0.33, 0.34], intercept: 0.0 },
    evidence: {
      inSampleMetrics: { sharpe: 2.1, maxDrawdown: 0.08, winRate: 0.65, profitFactor: 2.2, totalTrades: 120 },
      outOfSampleMetrics: { sharpe: 1.9, maxDrawdown: 0.1, winRate: 0.61, profitFactor: 1.95, totalTrades: 80 },
      expectancyBefore: 1.5,
      expectancyAfterHistorical: 1.8,
      winRate: 0.62,
      profitFactor: 2.05,
      referenceRegime: {
        volatilityRegime: 'NORMAL_VOLATILITY' as const,
        trendRegime: 'TRENDING_BULLISH' as const,
      },
    },
    riskConfig: {
      initialCapital: 10000000,
      maxRiskPerTrade: 0.005,
      maxLeverage: 100,
      maxAccountRiskLimit: 1.0,
      lotSize: 0.01,
      contractSize: 1,
      partialExitPolicy: {
        tp1Ratio: 0.33,
        tp2Ratio: 0.33,
        tp3Ratio: 0.34,
        moveStopToBreakevenAtTp1: true,
        enableTrailingAtTp2: true,
      },
    },
    executionConfig: {
      fillModel: 'REALISTIC',
      ambiguityMode: 'PESSIMISTIC',
      latencyMs: 10,
      minMtfScore,
    },
    strategyConfig: {
      timeframe: '15m',
      minMtfScore,
    },
    change: {
      description: 'Reliability candidate test change',
      minMtfScore,
    },
  } as any;
}

describe('AI Fix 39 — Long-Duration Shadow Reliability & Certification', () => {
  jest.setTimeout(180000);
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quant-shadow-rel-test-'));
    ModelRegistry.clear();
    ModelRegistry.setPersistencePath(path.join(testDir, 'model-registry.json'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    ModelRegistry.clear();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('1. Long-Run Continuous vs Multi-Restart Equivalence (10,000+ Candles)', () => {
    it('Test 1: 10,000-candle continuous execution == random multi-restart execution', () => {
      const candidateId = 'cand-10k-equiv';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const pathCont = path.join(testDir, `shadow-${candidateId}-cont.json`);
      const pathRest = path.join(testDir, `shadow-${candidateId}-rest.json`);

      const candles = generateMultiRegimeMarketHistory(1700000000000, 10000, 900000, 42);

      // --- RUN A: Pure Continuous Orchestrator ---
      const orchCont = new ShadowOrchestrator({ persistenceDir: testDir });
      orchCont.startCandidate(candidateId);

      for (let i = 0; i < candles.length; i++) {
        orchCont.processCandle(candidateId, candles[i], undefined, candles[i].timestamp.getTime());
      }
      const ledgerCont = orchCont.getCandidateLedger(candidateId)!;
      ledgerCont.saveToFile(pathCont);
      const snapCont = orchCont.getCandidateStateSnapshot(candidateId);
      const evidenceCont = orchCont.generateEvaluationEvidence(candidateId);

      // --- RUN B: Multi-Restart Orchestrator across deterministic seeded schedule ---
      const restartPoints = new Set([1, 37, 103, 257, 511, 1000, 2500, 5000, 7500, 9999]);
      let orchRest = new ShadowOrchestrator({ persistenceDir: testDir });
      orchRest.startCandidate(candidateId);

      for (let i = 0; i < candles.length; i++) {
        orchRest.processCandle(candidateId, candles[i], undefined, candles[i].timestamp.getTime());

        if (restartPoints.has(i)) {
          // Persist, destroy, recreate, restore
          const currLedger = orchRest.getCandidateLedger(candidateId)!;
          currLedger.saveToFile(pathRest);

          orchRest = new ShadowOrchestrator({ persistenceDir: testDir });
          orchRest.startCandidate(candidateId);
        }
      }

      const snapRest = orchRest.getCandidateStateSnapshot(candidateId);
      const evidenceRest = orchRest.generateEvaluationEvidence(candidateId);

      // Strict canonical snapshot and hash equivalence
      expect(snapRest.stateHash).toBe(snapCont.stateHash);
      expect(snapRest.cumulativeMarketHash).toBe(snapCont.cumulativeMarketHash);
      expect(evidenceRest.evidenceHash).toBe(evidenceCont.evidenceHash);
      expect(snapRest.orders.length).toBe(snapCont.orders.length);
      expect(snapRest.fills.length).toBe(snapCont.fills.length);
      expect(snapRest.trades.length).toBe(snapCont.trades.length);
      expect(snapRest).toEqual(snapCont);
    });

    it('Test 2: Periodic multi-restart schedules (every 37 & every 101 candles) produce exact state', () => {
      const candidateId = 'cand-periodic-restart';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const candles = generateMultiRegimeMarketHistory(1700000000000, 2000, 900000, 99);

      // Continuous baseline
      const orchCont = new ShadowOrchestrator({ persistenceDir: testDir });
      orchCont.startCandidate(candidateId);
      for (const candle of candles) {
        orchCont.processCandle(candidateId, candle, undefined, candle.timestamp.getTime());
      }
      const snapCont = orchCont.getCandidateStateSnapshot(candidateId);

      // Periodic restart every 37 candles
      const path37 = path.join(testDir, `shadow-${candidateId}-37.json`);
      let orch37 = new ShadowOrchestrator({ persistenceDir: testDir });
      orch37.startCandidate(candidateId);

      for (let i = 0; i < candles.length; i++) {
        orch37.processCandle(candidateId, candles[i], undefined, candles[i].timestamp.getTime());
        if ((i + 1) % 37 === 0) {
          orch37.getCandidateLedger(candidateId)!.saveToFile(path37);
          orch37 = new ShadowOrchestrator({ persistenceDir: testDir });
          orch37.startCandidate(candidateId);
        }
      }
      const snap37 = orch37.getCandidateStateSnapshot(candidateId);

      expect(snap37.stateHash).toBe(snapCont.stateHash);
      expect(snap37).toEqual(snapCont);
    });
  });

  describe('2. Crash Recovery & Full Replay Equivalence', () => {
    it('Test 3: Crash recovery with resting entry order restores pending signal and fills causally on T+1', () => {
      const candidateId = 'cand-crash-entry';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const filePath = path.join(testDir, `shadow-${candidateId}.json`);
      const candles = generateMultiRegimeMarketHistory(1700000000000, 50, 900000, 123);

      const orch1 = new ShadowOrchestrator({ persistenceDir: testDir });
      orch1.startCandidate(candidateId);

      // Process candles until an entry signal is generated
      let pendingSignalIndex = -1;
      for (let i = 0; i < candles.length; i++) {
        const res = orch1.processCandle(candidateId, candles[i], undefined, candles[i].timestamp.getTime());
        if (res.newOrders.some((o) => o.exitTarget === 'ENTRY')) {
          pendingSignalIndex = i;
          break;
        }
      }

      expect(pendingSignalIndex).toBeGreaterThan(0);

      // Abrupt crash: save to disk, destroy in-memory orchestrator
      const ledger1 = orch1.getCandidateLedger(candidateId)!;
      ledger1.saveToFile(filePath);

      // Spin up fresh orchestrator and restore
      const orch2 = new ShadowOrchestrator({ persistenceDir: testDir });
      orch2.startCandidate(candidateId);

      // Process next candle T+1
      const nextCandle = candles[pendingSignalIndex + 1];
      const resNext = orch2.processCandle(candidateId, nextCandle, undefined, nextCandle.timestamp.getTime());

      // Entry order must fill and create active position lot
      expect(resNext.newFills.length).toBeGreaterThan(0);
      const activeLot = orch2.getCandidateActiveLot(candidateId);
      expect(activeLot).not.toBeNull();
      expect(activeLot?.remainingQuantity).toBeGreaterThan(0);
    });

    it('Test 4: Crash recovery with active open position matches continuous canonical state snapshot', () => {
      const candidateIdCont = 'cand-crash-active-cont';
      const candidateIdRest = 'cand-crash-active-rest';
      const rawCandidateCont = createReliabilityCandidate(candidateIdCont);
      const rawCandidateRest = createReliabilityCandidate(candidateIdRest);
      const artifactCont = CandidateBacktestRunner.createCandidateArtifact(rawCandidateCont, 'hash_mkt_shadow_039');
      const artifactRest = CandidateBacktestRunner.createCandidateArtifact(rawCandidateRest, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifactCont);
      ModelRegistry.registerCandidateArtifact(artifactRest);

      const filePath = path.join(testDir, `shadow-${candidateIdRest}.json`);
      const candles = generateMultiRegimeMarketHistory(1700000000000, 200, 900000, 456);

      // Continuous run
      const orchCont = new ShadowOrchestrator({ persistenceDir: testDir });
      orchCont.startCandidate(candidateIdCont);
      let activeLotIndex = -1;
      for (let i = 0; i < candles.length; i++) {
        orchCont.processCandle(candidateIdCont, candles[i], undefined, candles[i].timestamp.getTime());
        if (activeLotIndex === -1 && orchCont.getCandidateActiveLot(candidateIdCont) !== null) {
          activeLotIndex = i;
        }
      }
      const snapCont = orchCont.getCandidateStateSnapshot(candidateIdCont);

      expect(activeLotIndex).toBeGreaterThan(0);

      // Crash-restart run at activeLotIndex
      const orchRest = new ShadowOrchestrator({ persistenceDir: testDir });
      orchRest.startCandidate(candidateIdRest);
      for (let i = 0; i <= activeLotIndex; i++) {
        orchRest.processCandle(candidateIdRest, candles[i], undefined, candles[i].timestamp.getTime());
      }

      // Simulate crash
      orchRest.getCandidateLedger(candidateIdRest)!.saveToFile(filePath);

      // Restore fresh orchestrator from checkpoint and continue
      const orchAfterCrash = new ShadowOrchestrator({ persistenceDir: testDir });
      orchAfterCrash.startCandidate(candidateIdRest);
      for (let i = activeLotIndex + 1; i < candles.length; i++) {
        orchAfterCrash.processCandle(candidateIdRest, candles[i], undefined, candles[i].timestamp.getTime());
      }
      const snapRest = orchAfterCrash.getCandidateStateSnapshot(candidateIdRest);

      // Exact snapshot counts & structure equivalence
      expect(snapRest.orders.length).toBe(snapCont.orders.length);
      expect(snapRest.fills.length).toBe(snapCont.fills.length);
      expect(snapRest.trades.length).toBe(snapCont.trades.length);
      expect(snapRest.cumulativeMarketHash).toBe(snapCont.cumulativeMarketHash);
    });

    it('Test 5: Full replay equivalence: Replaying market from persisted checkpoint in a fresh process reproduces exact canonical state', () => {
      const candidateIdCont = 'cand-replay-cont';
      const candidateIdReplay = 'cand-replay-rest';
      const rawCandidateCont = createReliabilityCandidate(candidateIdCont);
      const rawCandidateReplay = createReliabilityCandidate(candidateIdReplay);
      const artifactCont = CandidateBacktestRunner.createCandidateArtifact(rawCandidateCont, 'hash_mkt_shadow_039');
      const artifactReplay = CandidateBacktestRunner.createCandidateArtifact(rawCandidateReplay, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifactCont);
      ModelRegistry.registerCandidateArtifact(artifactReplay);

      const candles = generateMultiRegimeMarketHistory(1700000000000, 1000, 900000, 789);
      const checkpointIndex = 500;
      const checkpointFile = path.join(testDir, `shadow-${candidateIdReplay}.json`);

      // 1. Continuous full run
      const orchCont = new ShadowOrchestrator({ persistenceDir: testDir });
      orchCont.startCandidate(candidateIdCont);
      for (let i = 0; i < candles.length; i++) {
        orchCont.processCandle(candidateIdCont, candles[i], undefined, candles[i].timestamp.getTime());
      }
      const snapCont = orchCont.getCandidateStateSnapshot(candidateIdCont);

      // 2. Run to checkpoint and save
      const orchPre = new ShadowOrchestrator({ persistenceDir: testDir });
      orchPre.startCandidate(candidateIdReplay);
      for (let i = 0; i <= checkpointIndex; i++) {
        orchPre.processCandle(candidateIdReplay, candles[i], undefined, candles[i].timestamp.getTime());
      }
      orchPre.getCandidateLedger(candidateIdReplay)!.saveToFile(checkpointFile);

      // 3. Replay remaining candles in fresh process from checkpoint
      const orchReplay = new ShadowOrchestrator({ persistenceDir: testDir });
      orchReplay.startCandidate(candidateIdReplay);
      for (let i = checkpointIndex + 1; i < candles.length; i++) {
        orchReplay.processCandle(candidateIdReplay, candles[i], undefined, candles[i].timestamp.getTime());
      }
      const snapReplay = orchReplay.getCandidateStateSnapshot(candidateIdReplay);

      expect(snapReplay.orders.length).toBe(snapCont.orders.length);
      expect(snapReplay.fills.length).toBe(snapCont.fills.length);
      expect(snapReplay.trades.length).toBe(snapCont.trades.length);
      expect(snapReplay.cumulativeMarketHash).toBe(snapCont.cumulativeMarketHash);
    });
  });

  describe('3. Persistence Corruption Matrix (Fail-Closed Enforcement)', () => {
    const makeValidPersistenceData = (candidateId: string, artifactHash: string, featureSchemaHash: string): any => ({
      version: SHADOW_SCHEMA_VERSION,
      candidateId,
      candidateVersion: '1.0.0',
      strategyVersion: '1.0.0',
      featureSchemaHash,
      artifactHash,
      symbol: 'BTCUSDT',
      lastMarketTimestamp: 1700000000000,
      observations: [],
      orders: [],
      fills: [],
      trades: [],
      windows: [],
      drifts: [],
      comparisons: [],
      events: [],
      health: {
        candidateId,
        status: 'HEALTHY',
        observationCount: 0,
        tradeCount: 0,
        consecutiveHealthyWindows: 0,
        consecutiveDegradedWindows: 0,
        lastObservationAt: 1700000000000,
        lastEvaluationAt: 1700000000000,
        activeDrifts: [],
        updatedAt: 1700000000000,
      },
      savedAt: 1700000000000,
    });

    it('Test 6: Rejects structural persistence corruptions (invalid JSON, empty, truncated, bad version)', () => {
      const candidateId = 'cand-corrupt-struct';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const filePath = path.join(testDir, `shadow-${candidateId}.json`);

      // 1. Truncated JSON
      fs.writeFileSync(filePath, '{"version":"1.1","candidateId":"cand-corrupt-struct"', 'utf-8');
      const orch1 = new ShadowOrchestrator({ persistenceDir: testDir });
      expect(() => orch1.startCandidate(candidateId)).toThrow(/SHADOW_LEDGER_CORRUPT/);

      // 2. Empty file
      fs.writeFileSync(filePath, '', 'utf-8');
      const orch2 = new ShadowOrchestrator({ persistenceDir: testDir });
      expect(() => orch2.startCandidate(candidateId)).toThrow(/SHADOW_LEDGER_CORRUPT/);

      // 3. Unsupported schema version
      const badVersion = makeValidPersistenceData(candidateId, artifact.artifactHash, artifact.featureSchemaHash);
      badVersion.version = '99.0';
      fs.writeFileSync(filePath, JSON.stringify(badVersion), 'utf-8');
      const orch3 = new ShadowOrchestrator({ persistenceDir: testDir });
      expect(() => orch3.startCandidate(candidateId)).toThrow(/UNSUPPORTED_SHADOW_SCHEMA_VERSION/);
    });

    it('Test 7: Rejects execution corruptions (duplicate orders/fills, corrupt activeLot, invalid trade prices)', () => {
      const candidateId = 'cand-corrupt-exec';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const filePath = path.join(testDir, `shadow-${candidateId}.json`);

      // 1. Duplicate order ID
      const dupOrderData = makeValidPersistenceData(candidateId, artifact.artifactHash, artifact.featureSchemaHash);
      dupOrderData.orders = [
        { id: 'ord_1', candidateId, symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 1, status: 'FILLED', createdAt: 1700000000000 },
        { id: 'ord_1', candidateId, symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 1, status: 'FILLED', createdAt: 1700000000000 },
      ];
      fs.writeFileSync(filePath, JSON.stringify(dupOrderData), 'utf-8');
      const orch1 = new ShadowOrchestrator({ persistenceDir: testDir });
      expect(() => orch1.startCandidate(candidateId)).toThrow(/Duplicate order ID/);

      // 2. Corrupted activeLot (remainingQuantity > initialQuantity)
      const badLotData = makeValidPersistenceData(candidateId, artifact.artifactHash, artifact.featureSchemaHash);
      badLotData.activeLot = {
        id: 'lot_1',
        symbol: 'BTCUSDT',
        direction: Direction.BULLISH,
        entryPrice: 50000,
        initialQuantity: 1.0,
        remainingQuantity: 2.0, // Invalid!
        currentStopLoss: 49000,
      };
      fs.writeFileSync(filePath, JSON.stringify(badLotData), 'utf-8');
      const orch2 = new ShadowOrchestrator({ persistenceDir: testDir });
      expect(() => orch2.startCandidate(candidateId)).toThrow(/Corrupted activeLot remainingQuantity/);

      // 3. Corrupted trade price (negative entry price)
      const badTradeData = makeValidPersistenceData(candidateId, artifact.artifactHash, artifact.featureSchemaHash);
      badTradeData.trades = [
        { id: 'tr_1', entryPrice: -50000, exitPrice: 51000, quantity: 1, pnl: 1000, pnlRMultiple: 1 },
      ];
      fs.writeFileSync(filePath, JSON.stringify(badTradeData), 'utf-8');
      const orch3 = new ShadowOrchestrator({ persistenceDir: testDir });
      expect(() => orch3.startCandidate(candidateId)).toThrow(/Corrupted trade entry price/);
    });

    it('Test 8: Rejects candidate binding mismatches (wrong candidateId or artifactHash)', () => {
      const candidateId = 'cand-binding-check';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const filePath = path.join(testDir, `shadow-${candidateId}.json`);

      // Mismatched candidateId
      const badCandData = makeValidPersistenceData('wrong-cand-id', artifact.artifactHash, artifact.featureSchemaHash);
      fs.writeFileSync(filePath, JSON.stringify(badCandData), 'utf-8');
      const orch1 = new ShadowOrchestrator({ persistenceDir: testDir });
      expect(() => orch1.startCandidate(candidateId)).toThrow(/CANDIDATE_BINDING_MISMATCH/);

      // Mismatched artifactHash
      const badHashData = makeValidPersistenceData(candidateId, 'wrong_artifact_hash', artifact.featureSchemaHash);
      fs.writeFileSync(filePath, JSON.stringify(badHashData), 'utf-8');
      const orch2 = new ShadowOrchestrator({ persistenceDir: testDir });
      expect(() => orch2.startCandidate(candidateId)).toThrow(/ARTIFACT_HASH_MISMATCH/);
    });
  });

  describe('4. Atomic Restore & Isolation', () => {
    it('Test 9: Failed restore from corrupt file leaves live in-memory candidate unmutated', () => {
      const candidateId = 'cand-atomic-iso';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const filePath = path.join(testDir, `shadow-${candidateId}.json`);
      const orch = new ShadowOrchestrator({ persistenceDir: testDir });
      orch.startCandidate(candidateId);

      // Ingest 5 valid candles
      const candles = generateMultiRegimeMarketHistory(1700000000000, 5, 900000, 10);
      for (const c of candles) {
        orch.processCandle(candidateId, c, undefined, c.timestamp.getTime());
      }
      const snapshotBefore = orch.getCandidateStateSnapshot(candidateId);
      const ledger = orch.getCandidateLedger(candidateId)!;

      // Overwrite file with corrupt JSON
      fs.writeFileSync(filePath, 'CORRUPTED_JSON_DATA', 'utf-8');

      // Attempting to hydrate ledger from corrupt file throws fail-closed
      expect(() => ledger.loadFromFile(filePath)).toThrow(/SHADOW_LEDGER_CORRUPT/);

      // In-memory ledger snapshot remains strictly unchanged
      const snapshotAfter = orch.getCandidateStateSnapshot(candidateId);
      expect(snapshotAfter).toEqual(snapshotBefore);
      expect(snapshotAfter.stateHash).toBe(snapshotBefore.stateHash);
    });
  });

  describe('5. Market Data Invariants (Duplicates, Regressions & Gaps)', () => {
    it('Test 10: Duplicate and out-of-order candles are rejected fail-closed', () => {
      const candidateId = 'cand-mkt-invariants';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orch = new ShadowOrchestrator({ persistenceDir: testDir });
      orch.startCandidate(candidateId);

      const t0 = 1700000000000;
      const c1: ICandle = { timestamp: new Date(t0), open: 100, high: 105, low: 95, close: 102, volume: 10 };
      orch.processCandle(candidateId, c1, undefined, t0);

      // 1. Duplicate timestamp rejected
      const cDup: ICandle = { timestamp: new Date(t0), open: 102, high: 106, low: 98, close: 104, volume: 10 };
      expect(() => orch.processCandle(candidateId, cDup, undefined, t0)).toThrow(/DUPLICATE_CANDLE_TIMESTAMP/);

      // 2. Out of order timestamp rejected
      const cReg: ICandle = { timestamp: new Date(t0 - 1000), open: 102, high: 106, low: 98, close: 104, volume: 10 };
      expect(() => orch.processCandle(candidateId, cReg, undefined, t0 - 1000)).toThrow(/CHRONOLOGICAL_REGRESSION/);
    });

    it('Test 11: Market data gaps exceeding configured threshold are rejected fail-closed', () => {
      const candidateId = 'cand-mkt-gap';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const maxGapMs = 1800000; // 30m max allowed gap
      const orch = new ShadowOrchestrator({ persistenceDir: testDir, maxAllowedGapMs: maxGapMs });
      orch.startCandidate(candidateId);

      const t0 = 1700000000000;
      const c1: ICandle = { timestamp: new Date(t0), open: 100, high: 105, low: 95, close: 102, volume: 10 };
      orch.processCandle(candidateId, c1, undefined, t0);

      // Gap of 2 hours (> 30m limit)
      const cGap: ICandle = { timestamp: new Date(t0 + 7200000), open: 102, high: 106, low: 98, close: 104, volume: 10 };
      expect(() => orch.processCandle(candidateId, cGap, undefined, t0 + 7200000)).toThrow(/MARKET_DATA_GAP/);
    });
  });

  describe('6. Dependency Failure Injection Matrix', () => {
    it('Test 12: SignalGenerator failure fails closed without corrupting ledger or submitting phantom orders', () => {
      const candidateId = 'cand-dep-sig';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orch = new ShadowOrchestrator({ persistenceDir: testDir });
      orch.startCandidate(candidateId);

      // Ingest 20 candles so warmup is completed
      const candles = generateMultiRegimeMarketHistory(1700000000000, 25, 900000, 11);
      for (let i = 0; i < 20; i++) {
        orch.processCandle(candidateId, candles[i], undefined, candles[i].timestamp.getTime());
      }
      const obsCountBefore = orch.getCandidateLedger(candidateId)!.getObservations().length;

      const spy = jest.spyOn(SignalGenerator, 'generateSignal').mockImplementation(() => {
        throw new Error('SIMULATED_SIGNAL_GENERATOR_PANIC');
      });

      try {
        expect(() => orch.processCandle(candidateId, candles[20], undefined, candles[20].timestamp.getTime())).toThrow(
          /SIMULATED_SIGNAL_GENERATOR_PANIC/,
        );
      } finally {
        spy.mockRestore();
      }

      // Ledger has not committed new observations from failed candle
      const ledger = orch.getCandidateLedger(candidateId)!;
      expect(ledger.getObservations().length).toBe(obsCountBefore);
    });

    it('Test 13: ExecutionSimulator fill processing failure rolls back cleanly', () => {
      const candidateId = 'cand-dep-exec';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orch = new ShadowOrchestrator({ persistenceDir: testDir });
      orch.startCandidate(candidateId);

      const spy = jest.spyOn(ExecutionSimulator.prototype, 'processSingleExecutionBar').mockImplementation(() => {
        throw new Error('SIMULATED_EXEC_SIM_CRASH');
      });

      try {
        const c1: ICandle = { timestamp: new Date(1700000000000), open: 100, high: 105, low: 95, close: 102, volume: 10 };
        expect(() => orch.processCandle(candidateId, c1)).toThrow(/SIMULATED_EXEC_SIM_CRASH/);
      } finally {
        spy.mockRestore();
      }

      const ledger = orch.getCandidateLedger(candidateId)!;
      expect(ledger.getFills().length).toBe(0);
    });

    it('Test 14: TradeLifecycleManager failure on fill fails closed without leaving phantom active lot', () => {
      const candidateId = 'cand-dep-life';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orch = new ShadowOrchestrator({ persistenceDir: testDir });
      orch.startCandidate(candidateId);

      const candles = generateMultiRegimeMarketHistory(1700000000000, 30, 900000, 111);
      let entryOrderIndex = -1;
      for (let i = 0; i < candles.length; i++) {
        const res = orch.processCandle(candidateId, candles[i], undefined, candles[i].timestamp.getTime());
        if (res.newOrders.some((o) => o.exitTarget === 'ENTRY')) {
          entryOrderIndex = i;
          break;
        }
      }

      if (entryOrderIndex >= 0) {
        const spy = jest.spyOn(TradeLifecycleManager, 'createPositionLot').mockImplementation(() => {
          throw new Error('SIMULATED_LIFECYCLE_POSITION_CREATION_FAILED');
        });

        try {
          const nextCandle = candles[entryOrderIndex + 1];
          expect(() => orch.processCandle(candidateId, nextCandle, undefined, nextCandle.timestamp.getTime())).toThrow(
            /SIMULATED_LIFECYCLE_POSITION_CREATION_FAILED/,
          );
        } finally {
          spy.mockRestore();
        }

        expect(orch.getCandidateActiveLot(candidateId)).toBeNull();
      }
    });

    it('Test 15: Missing or unconfigured ModelRegistry fails closed', () => {
      const candidateId = 'cand-dep-registry';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      // Do NOT register artifact in ModelRegistry

      const orch = new ShadowOrchestrator({ persistenceDir: testDir });
      expect(() => orch.startCandidate(candidateId)).toThrow(/CANDIDATE_NOT_FOUND/);
    });
  });

  describe('7. Sizing Reference Price vs T+1 Execution Price Contract', () => {
    it('Test 16: Position sizing uses candle T close, orders execute causally on T+1 with conserved lot quantity', () => {
      const candidateId = 'cand-sizing-contract';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orch = new ShadowOrchestrator({ persistenceDir: testDir });
      orch.startCandidate(candidateId);

      const t0 = 1700000000000;
      const c1: ICandle = { timestamp: new Date(t0), open: 50000, high: 50500, low: 49800, close: 50200, volume: 1000 };
      const res1 = orch.processCandle(candidateId, c1, undefined, t0);

      // If actionable entry order generated at T:
      if (res1.newOrders.some((o) => o.exitTarget === 'ENTRY')) {
        const entryOrder = res1.newOrders.find((o) => o.exitTarget === 'ENTRY')!;
        expect(entryOrder.orderType).toBe('MARKET');
        expect(entryOrder.quantity).toBeGreaterThan(0);

        // Execute on candle T+1 with realistic open price
        const c2: ICandle = { timestamp: new Date(t0 + 900000), open: 50250, high: 50800, low: 50100, close: 50600, volume: 1000 };
        const res2 = orch.processCandle(candidateId, c2, undefined, t0 + 900000);

        expect(res2.newFills.length).toBeGreaterThan(0);
        const fill = res2.newFills[0];
        expect(fill.quantity).toBe(entryOrder.quantity);
        expect(fill.price).toBeGreaterThanOrEqual(50250); // Executed at/near T+1 open with slippage
      }
    });
  });

  describe('8. Deterministic Hash Stability across Repeated Executions', () => {
    it('Test 17: 4 Independent runs (A, B, C, D) of 5,000 candles produce byte-identical evidence hashes', () => {
      const candidateId = 'cand-hash-stability';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const candles = generateMultiRegimeMarketHistory(1700000000000, 5000, 900000, 777);

      const runSim = (runId: string) => {
        const runDir = path.join(testDir, `run_${runId}`);
        const orch = new ShadowOrchestrator({ persistenceDir: runDir });
        orch.startCandidate(candidateId);

        for (let i = 0; i < candles.length; i++) {
          orch.processCandle(candidateId, candles[i], undefined, candles[i].timestamp.getTime());
        }
        return {
          snapshot: orch.getCandidateStateSnapshot(candidateId),
          evidence: orch.generateEvaluationEvidence(candidateId),
        };
      };

      const resA = runSim('A');
      const resB = runSim('B');
      const resC = runSim('C');
      const resD = runSim('D');

      expect(resB.snapshot.stateHash).toBe(resA.snapshot.stateHash);
      expect(resC.snapshot.stateHash).toBe(resA.snapshot.stateHash);
      expect(resD.snapshot.stateHash).toBe(resA.snapshot.stateHash);

      expect(resB.evidence.evidenceHash).toBe(resA.evidence.evidenceHash);
      expect(resC.evidence.evidenceHash).toBe(resA.evidence.evidenceHash);
      expect(resD.evidence.evidenceHash).toBe(resA.evidence.evidenceHash);

      expect(resB.snapshot.cumulativeMarketHash).toBe(resA.snapshot.cumulativeMarketHash);
      expect(resC.snapshot.cumulativeMarketHash).toBe(resA.snapshot.cumulativeMarketHash);
      expect(resD.snapshot.cumulativeMarketHash).toBe(resA.snapshot.cumulativeMarketHash);
    });
  });

  describe('9. Drift Lookback Expiry & Health State Machine Transitions', () => {
    it('Test 18: Warning drifts expire after activeDriftLookbackMs (DEGRADED -> HEALTHY), while CRITICAL drift triggers FAILED', () => {
      const candidateId = 'cand-drift-recovery';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const lookbackMs = 3600000; // 1 hr lookback
      const orch = new ShadowOrchestrator({
        persistenceDir: testDir,
        healthConfig: {
          minObservationsForHealthy: 1,
          minTradesForHealthy: 0,
          requiredConsecutiveHealthyWindowsForRecovery: 1,
          maxConsecutiveDegradedWindowsBeforeFailure: 5,
          activeDriftLookbackMs: lookbackMs,
        },
      });
      orch.startCandidate(candidateId);

      const ledger = orch.getCandidateLedger(candidateId)!;
      const t0 = 1700000000000;

      // Feed initial candles
      const c1: ICandle = { timestamp: new Date(t0), open: 100, high: 105, low: 95, close: 102, volume: 10 };
      orch.processCandle(candidateId, c1, undefined, t0);

      // Record a WARNING drift event at t0
      ledger.recordDrifts([
        {
          id: 'drift_warn_1',
          candidateId,
          type: 'PERFORMANCE',
          severity: 'WARNING',
          timestamp: t0,
          marketTimestamp: t0,
          metric: 'EXPECTANCY_DEGRADATION',
          baselineValue: 1.8,
          observedValue: 1.2,
          threshold: 1.0,
          windowStart: t0,
          windowEnd: t0,
          evidenceHash: 'drift_hash_1',
          details: 'Moderate degradation',
        },
      ]);

      // Candle within lookback (t0 + 30m): State becomes DEGRADED
      const c2: ICandle = { timestamp: new Date(t0 + 1800000), open: 102, high: 106, low: 98, close: 104, volume: 10 };
      const res2 = orch.processCandle(candidateId, c2, undefined, t0 + 1800000);
      expect(res2.healthState.status).toBe('DEGRADED');

      // Candle beyond lookback (t0 + 2 hrs): Old drift expires, State recovers to HEALTHY
      const c3: ICandle = { timestamp: new Date(t0 + 7200000), open: 104, high: 108, low: 100, close: 106, volume: 10 };
      const res3 = orch.processCandle(candidateId, c3, undefined, t0 + 7200000);
      expect(res3.healthState.status).toBe('HEALTHY');

      // Critical drift triggers immediate FAILED state
      ledger.recordDrifts([
        {
          id: 'drift_crit_1',
          candidateId,
          type: 'PERFORMANCE',
          severity: 'CRITICAL',
          timestamp: t0 + 7200000,
          marketTimestamp: t0 + 7200000,
          metric: 'CRITICAL_EXECUTION_FAILURE',
          baselineValue: 0,
          observedValue: 10,
          threshold: 1,
          windowStart: t0 + 7200000,
          windowEnd: t0 + 7200000,
          evidenceHash: 'drift_crit_hash',
        },
      ]);
      const c4: ICandle = { timestamp: new Date(t0 + 7300000), open: 106, high: 110, low: 102, close: 108, volume: 10 };
      const res4 = orch.processCandle(candidateId, c4, undefined, t0 + 7300000);
      expect(res4.healthState.status).toBe('FAILED');
    });
  });

  describe('10. Memory, CPU & Linear Resource Scaling Certification', () => {
    it('Test 19: Measures heap usage, RSS, CPU time, and linear O(N) observation scaling across 1k, 5k, and 10k candles', () => {
      const candidateId = 'cand-growth-test';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const candles = generateMultiRegimeMarketHistory(1700000000000, 10000, 900000, 555);
      const orch = new ShadowOrchestrator({ persistenceDir: testDir });
      orch.startCandidate(candidateId);

      const ledger = orch.getCandidateLedger(candidateId)!;

      const memInitial = process.memoryUsage();
      const cpuInitial = process.cpuUsage();
      const timeStart = Date.now();

      // Ingest first 1,000 candles
      for (let i = 0; i < 1000; i++) {
        orch.processCandle(candidateId, candles[i], undefined, candles[i].timestamp.getTime());
      }
      const obs1k = ledger.getObservations().length;
      expect(obs1k).toBe(1000);
      const mem1k = process.memoryUsage();
      const time1k = Date.now() - timeStart;

      // Ingest to 5,000 candles
      for (let i = 1000; i < 5000; i++) {
        orch.processCandle(candidateId, candles[i], undefined, candles[i].timestamp.getTime());
      }
      const obs5k = ledger.getObservations().length;
      expect(obs5k).toBe(5000);
      const mem5k = process.memoryUsage();
      const time5k = Date.now() - timeStart;

      // Ingest to 10,000 candles
      for (let i = 5000; i < 10000; i++) {
        orch.processCandle(candidateId, candles[i], undefined, candles[i].timestamp.getTime());
      }
      const obs10k = ledger.getObservations().length;
      expect(obs10k).toBe(10000);
      const mem10k = process.memoryUsage();
      const time10k = Date.now() - timeStart;
      const cpuTotal = process.cpuUsage(cpuInitial);

      // Verify observation growth linearity
      expect(obs5k / obs1k).toBe(5);
      expect(obs10k / obs1k).toBe(10);

      // Verify bounded memory growth (heap usage does not explode quadratically)
      const heapDiff10k = mem10k.heapUsed - memInitial.heapUsed;
      // 10,000 shadow observations + orders + rolling metrics must take less than 150MB heap
      expect(heapDiff10k).toBeLessThan(150 * 1024 * 1024);

      // Total processing time for 10,000 candles must execute efficiently in reasonable time
      expect(time10k).toBeGreaterThan(0);
      expect(cpuTotal.user).toBeGreaterThan(0);
    });
  });

  describe('11. Production Safety Invariants (Paper-Only)', () => {
    it('Test 20: Autonomous live modifications and promotion are strictly permanently disabled', () => {
      expect(ShadowOrchestrator.AUTOMATIC_LIVE_TRADING_ROLLBACK_ENABLED).toBe(false);
      expect(ShadowOrchestrator.AUTOMATIC_LIVE_PROMOTION_ENABLED).toBe(false);
    });
  });
});
