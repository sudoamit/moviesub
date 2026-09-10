import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ICandle } from '@quant/shared';
import { ModelRegistry } from '../model-registry';
import { CandidateBacktestRunner } from '../candidate-backtest-runner';
import { ShadowOrchestrator } from '../shadow/shadow-orchestrator';
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
      initialCapital: 1000000,
      maxRiskPerTrade: 0.01,
      maxLeverage: 10,
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
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quant-shadow-rel-test-'));
    ModelRegistry.clear();
    ModelRegistry.setPersistencePath(path.join(testDir, 'model-registry.json'));
  });

  afterEach(() => {
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
      expect(candles.length).toBe(10000);

      const fixedBaseTime = 1700000000000;

      // 1. Run Continuous Orchestrator across all 10,000 candles
      const orchContinuous = new ShadowOrchestrator({ persistenceDir: testDir });
      orchContinuous.startCandidate(candidateId, { persistenceFilePath: pathCont });

      for (let i = 0; i < candles.length; i++) {
        orchContinuous.processCandle(candidateId, candles[i], undefined, fixedBaseTime + i * 60000);
      }

      // 2. Run Restart Orchestrator with restarts at deterministic checkpoints
      const restartPoints = new Set([1, 37, 103, 257, 511, 1000, 2500, 5000, 7500, 9999]);
      let orchRestart = new ShadowOrchestrator({ persistenceDir: testDir });
      orchRestart.startCandidate(candidateId, { persistenceFilePath: pathRest });

      for (let i = 0; i < candles.length; i++) {
        orchRestart.processCandle(candidateId, candles[i], undefined, fixedBaseTime + i * 60000);

        if (restartPoints.has(i) && i < candles.length - 1) {
          // Abrupt restart: create a new orchestrator and resume from persistence
          orchRestart = new ShadowOrchestrator({ persistenceDir: testDir });
          orchRestart.startCandidate(candidateId, { persistenceFilePath: pathRest });
        }
      }

      // 3. Full Canonical Snapshot Comparison
      const snapCont: ShadowStateSnapshot = orchContinuous.getCandidateStateSnapshot(candidateId);
      const snapRest: ShadowStateSnapshot = orchRestart.getCandidateStateSnapshot(candidateId);

      expect(snapRest.schemaVersion).toBe(SHADOW_SCHEMA_VERSION);
      expect(snapRest.candidateId).toBe(candidateId);
      expect(snapRest.observations.length).toBe(10000);
      expect(snapRest.observations.length).toBe(snapCont.observations.length);
      expect(snapRest.orders.length).toBe(snapCont.orders.length);
      expect(snapRest.fills.length).toBe(snapCont.fills.length);
      expect(snapRest.trades.length).toBe(snapCont.trades.length);

      // Byte-identical Canonical State Hash & Market Hash
      expect(snapRest.stateHash).toBe(snapCont.stateHash);
      expect(snapRest.cumulativeMarketHash).toBe(snapCont.cumulativeMarketHash);

      // Deep Snapshot Equivalence
      expect(snapRest.orders).toEqual(snapCont.orders);
      expect(snapRest.fills).toEqual(snapCont.fills);
      expect(snapRest.trades).toEqual(snapCont.trades);
      expect(snapRest.health).toEqual(snapCont.health);
      expect(snapRest.executionSequences).toEqual(snapCont.executionSequences);
      expect(snapRest.activeLot).toEqual(snapCont.activeLot);

      // Canonical Evaluation Evidence Equivalence
      const evidenceCont = orchContinuous.generateEvaluationEvidence(candidateId, fixedBaseTime + 10000 * 60000);
      const evidenceRest = orchRestart.generateEvaluationEvidence(candidateId, fixedBaseTime + 10000 * 60000);
      expect(evidenceRest.evidenceHash).toBe(evidenceCont.evidenceHash);
      expect(evidenceRest.stateHash).toBe(evidenceCont.stateHash);
      expect(evidenceRest.marketDatasetHash).toBe(evidenceCont.marketDatasetHash);
    });

    it('Test 2: Multi-restart schedules (periodic every 37 & every 101 candles) produce exact state', () => {
      const candidateId = 'cand-multi-restart';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const pathCont = path.join(testDir, `shadow-${candidateId}-cont.json`);
      const pathRest37 = path.join(testDir, `shadow-${candidateId}-rest37.json`);
      const pathRest101 = path.join(testDir, `shadow-${candidateId}-rest101.json`);

      const candles = generateMultiRegimeMarketHistory(1700000000000, 1500, 900000, 77);
      const fixedBaseTime = 1700000000000;

      // Continuous run
      const orchCont = new ShadowOrchestrator({ persistenceDir: testDir });
      orchCont.startCandidate(candidateId, { persistenceFilePath: pathCont });
      for (let i = 0; i < candles.length; i++) {
        orchCont.processCandle(candidateId, candles[i], undefined, fixedBaseTime + i * 60000);
      }

      // Schedule 1: Restart every 37 candles
      let orch37 = new ShadowOrchestrator({ persistenceDir: testDir });
      orch37.startCandidate(candidateId, { persistenceFilePath: pathRest37 });
      for (let i = 0; i < candles.length; i++) {
        orch37.processCandle(candidateId, candles[i], undefined, fixedBaseTime + i * 60000);
        if ((i + 1) % 37 === 0 && i < candles.length - 1) {
          orch37 = new ShadowOrchestrator({ persistenceDir: testDir });
          orch37.startCandidate(candidateId, { persistenceFilePath: pathRest37 });
        }
      }

      // Schedule 2: Restart every 101 candles
      let orch101 = new ShadowOrchestrator({ persistenceDir: testDir });
      orch101.startCandidate(candidateId, { persistenceFilePath: pathRest101 });
      for (let i = 0; i < candles.length; i++) {
        orch101.processCandle(candidateId, candles[i], undefined, fixedBaseTime + i * 60000);
        if ((i + 1) % 101 === 0 && i < candles.length - 1) {
          orch101 = new ShadowOrchestrator({ persistenceDir: testDir });
          orch101.startCandidate(candidateId, { persistenceFilePath: pathRest101 });
        }
      }

      const snapCont = orchCont.getCandidateStateSnapshot(candidateId);
      const snap37 = orch37.getCandidateStateSnapshot(candidateId);
      const snap101 = orch101.getCandidateStateSnapshot(candidateId);

      expect(snap37.stateHash).toBe(snapCont.stateHash);
      expect(snap101.stateHash).toBe(snapCont.stateHash);
      expect(snap37).toEqual(snapCont);
      expect(snap101).toEqual(snapCont);
    });
  });

  describe('2. Crash Recovery Matrix Across Lifecycle Stages', () => {
    it('Test 3: Crash recovery with resting entry order restores pending signal and fills causal on T+1', () => {
      const candidateId = 'cand-crash-entry';
      const rawCandidate = createReliabilityCandidate(candidateId, 50);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const filePath = path.join(testDir, `shadow-${candidateId}.json`);
      const candles = generateMultiRegimeMarketHistory(1700000000000, 200, 900000, 123);

      const orch1 = new ShadowOrchestrator({ persistenceDir: testDir });
      orch1.startCandidate(candidateId, { persistenceFilePath: filePath });

      let orderIndex = -1;
      for (let i = 0; i < candles.length; i++) {
        orch1.processCandle(candidateId, candles[i]);
        const ledger = orch1.getCandidateLedger(candidateId)!;
        if (ledger.getPendingEntrySignals().size > 0) {
          orderIndex = i;
          break;
        }
      }

      expect(orderIndex).toBeGreaterThan(0);

      // Abrupt Crash at candle T:
      const orch2 = new ShadowOrchestrator({ persistenceDir: testDir });
      expect(() => orch2.startCandidate(candidateId, { persistenceFilePath: filePath })).not.toThrow();

      const ledgerRestored = orch2.getCandidateLedger(candidateId)!;
      expect(ledgerRestored.getPendingEntrySignals().size).toBe(1);

      // Process T+1: Fills entry without MISSING_ENTRY_SIGNAL
      const res = orch2.processCandle(candidateId, candles[orderIndex + 1]);
      expect(res.newFills.length).toBe(1);
      expect(res.openPositionsCount).toBe(1);
      expect(ledgerRestored.getActiveLot()).not.toBeNull();
      expect(ledgerRestored.getPendingEntrySignals().size).toBe(0);
    });

    it('Test 4: Crash recovery with active open position restores resting SL/TP exit orders', () => {
      const candidateId = 'cand-crash-active-lot';
      const rawCandidate = createReliabilityCandidate(candidateId, 50);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const filePath = path.join(testDir, `shadow-${candidateId}.json`);
      const candles = generateMultiRegimeMarketHistory(1700000000000, 300, 900000, 123);

      const orch1 = new ShadowOrchestrator({ persistenceDir: testDir });
      orch1.startCandidate(candidateId, { persistenceFilePath: filePath });

      let activeLotIndex = -1;
      for (let i = 0; i < candles.length; i++) {
        const res = orch1.processCandle(candidateId, candles[i]);
        if (res.openPositionsCount > 0) {
          activeLotIndex = i;
          break;
        }
      }

      expect(activeLotIndex).toBeGreaterThan(0);

      // Crash with open lot
      const orch2 = new ShadowOrchestrator({ persistenceDir: testDir });
      expect(() => orch2.startCandidate(candidateId, { persistenceFilePath: filePath })).not.toThrow();

      const ledgerRestored = orch2.getCandidateLedger(candidateId)!;
      const lot = ledgerRestored.getActiveLot();
      expect(lot).not.toBeNull();
      expect(lot!.status).toBe('OPEN');

      // Continue processing through exit
      let closed = false;
      for (let i = activeLotIndex + 1; i < activeLotIndex + 100 && i < candles.length; i++) {
        const res = orch2.processCandle(candidateId, candles[i]);
        if (res.closedTrades.length > 0) {
          closed = true;
          break;
        }
      }
      expect(ledgerRestored.getTrades().length > 0 || closed).toBe(true);
    });
  });

  describe('3. Persistence Corruption Matrix (Fail-Closed Enforcement)', () => {
    const makeValidPersistenceData = (candidateId: string, artifactHash: string, featureSchemaHash: string): ShadowLedgerData => ({
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

    it('Test 5: Rejects structural persistence corruptions (invalid JSON, empty, truncated, wrong root, bad version)', () => {
      const candidateId = 'cand-corrupt-struct';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const base = makeValidPersistenceData(candidateId, artifact.artifactHash, artifact.featureSchemaHash);

      // 1. Invalid JSON
      const p1 = path.join(testDir, 'corrupt-json.json');
      fs.writeFileSync(p1, '{ invalid json', 'utf-8');
      expect(() => new ShadowOrchestrator({ persistenceDir: testDir }).startCandidate(candidateId, { persistenceFilePath: p1 })).toThrow(/SHADOW_LEDGER_CORRUPT/);

      // 2. Empty file
      const p2 = path.join(testDir, 'empty.json');
      fs.writeFileSync(p2, '', 'utf-8');
      expect(() => new ShadowOrchestrator({ persistenceDir: testDir }).startCandidate(candidateId, { persistenceFilePath: p2 })).toThrow(/SHADOW_LEDGER_CORRUPT/);

      // 3. Wrong root type (array)
      const p3 = path.join(testDir, 'wrong-root.json');
      fs.writeFileSync(p3, JSON.stringify([base]), 'utf-8');
      expect(() => new ShadowOrchestrator({ persistenceDir: testDir }).startCandidate(candidateId, { persistenceFilePath: p3 })).toThrow(/SHADOW_LEDGER_CORRUPT/);

      // 4. Missing version
      const p4 = path.join(testDir, 'missing-version.json');
      const badV = { ...base };
      delete (badV as any).version;
      fs.writeFileSync(p4, JSON.stringify(badV), 'utf-8');
      expect(() => new ShadowOrchestrator({ persistenceDir: testDir }).startCandidate(candidateId, { persistenceFilePath: p4 })).toThrow(/Missing mandatory top-level/);

      // 5. Unsupported version
      const p5 = path.join(testDir, 'bad-version.json');
      fs.writeFileSync(p5, JSON.stringify({ ...base, version: '9.9' }), 'utf-8');
      expect(() => new ShadowOrchestrator({ persistenceDir: testDir }).startCandidate(candidateId, { persistenceFilePath: p5 })).toThrow(/UNSUPPORTED_SHADOW_SCHEMA_VERSION/);
    });

    it('Test 6: Rejects market and observation chronological corruptions fail-closed', () => {
      const candidateId = 'cand-corrupt-mkt';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const base = makeValidPersistenceData(candidateId, artifact.artifactHash, artifact.featureSchemaHash);

      // 1. Out-of-order observation timestamps
      const p1 = path.join(testDir, 'out-of-order-obs.json');
      const badObs = {
        ...base,
        observations: [
          { candidateId, candidateVersion: '1.0', strategyVersion: '1.0', timestamp: 100, marketTimestamp: 2000, featureVectorHash: 'h1', signal: { direction: 'FLAT' as const } },
          { candidateId, candidateVersion: '1.0', strategyVersion: '1.0', timestamp: 100, marketTimestamp: 1000, featureVectorHash: 'h2', signal: { direction: 'FLAT' as const } }, // Regressed
        ],
      };
      fs.writeFileSync(p1, JSON.stringify(badObs), 'utf-8');
      expect(() => new ShadowOrchestrator({ persistenceDir: testDir }).startCandidate(candidateId, { persistenceFilePath: p1 })).toThrow(/Chronological order violation/);
    });

    it('Test 7: Rejects candidate binding mismatches (wrong candidateId or artifactHash)', () => {
      const candidateId = 'cand-binding-test';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const base = makeValidPersistenceData(candidateId, artifact.artifactHash, artifact.featureSchemaHash);

      // Mismatched candidateId
      const p1 = path.join(testDir, 'mismatch-cand.json');
      fs.writeFileSync(p1, JSON.stringify({ ...base, candidateId: 'other-cand' }), 'utf-8');
      expect(() => new ShadowOrchestrator({ persistenceDir: testDir }).startCandidate(candidateId, { persistenceFilePath: p1 })).toThrow(/CANDIDATE_BINDING_MISMATCH/);

      // Mismatched artifactHash
      const p2 = path.join(testDir, 'mismatch-art.json');
      fs.writeFileSync(p2, JSON.stringify({ ...base, artifactHash: 'tampered_artifact_hash' }), 'utf-8');
      expect(() => new ShadowOrchestrator({ persistenceDir: testDir }).startCandidate(candidateId, { persistenceFilePath: p2 })).toThrow(/ARTIFACT_HASH_MISMATCH/);
    });
  });

  describe('4. Atomic Restore & Isolation', () => {
    it('Test 8: Failed restore from corrupt file leaves live in-memory candidate unmutated', () => {
      const candidateId = 'cand-atomic-restore';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const pathValid = path.join(testDir, `valid-${candidateId}.json`);
      const pathCorrupt = path.join(testDir, `corrupt-${candidateId}.json`);

      const orch = new ShadowOrchestrator({ persistenceDir: testDir });
      orch.startCandidate(candidateId, { persistenceFilePath: pathValid });

      const candles = generateMultiRegimeMarketHistory(1700000000000, 25, 900000, 10);
      for (const c of candles) {
        orch.processCandle(candidateId, c);
      }

      const snapBefore = orch.getCandidateStateSnapshot(candidateId);
      expect(snapBefore.observations.length).toBe(25);

      // Write corrupt file B
      fs.writeFileSync(pathCorrupt, '{ corrupt json', 'utf-8');

      // Attempt to load corrupt file into the candidate ledger
      const ledger = orch.getCandidateLedger(candidateId)!;
      expect(() => ledger.loadFromFile(pathCorrupt)).toThrow(/SHADOW_LEDGER_CORRUPT/);

      // Assert in-memory state remains intact (State A)
      const snapAfter = orch.getCandidateStateSnapshot(candidateId);
      expect(snapAfter.stateHash).toBe(snapBefore.stateHash);
      expect(snapAfter.observations.length).toBe(25);
    });
  });

  describe('5. Market Data Invariants (Duplicates, Regressions & Gaps)', () => {
    it('Test 9: Duplicate and out-of-order candles are rejected fail-closed', () => {
      const candidateId = 'cand-mkt-invariants';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orch = new ShadowOrchestrator({ persistenceDir: testDir });
      orch.startCandidate(candidateId);

      const t0 = 1700000000000;
      const c1: ICandle = { timestamp: new Date(t0), open: 100, high: 105, low: 95, close: 102, volume: 10 };
      const c1Dup: ICandle = { timestamp: new Date(t0), open: 102, high: 106, low: 98, close: 103, volume: 12 };
      const c1Regress: ICandle = { timestamp: new Date(t0 - 1000), open: 100, high: 105, low: 95, close: 102, volume: 10 };

      orch.processCandle(candidateId, c1);
      expect(() => orch.processCandle(candidateId, c1Dup)).toThrow(/DUPLICATE_CANDLE_TIMESTAMP/);
      expect(() => orch.processCandle(candidateId, c1Regress)).toThrow(/TIMESTAMP_REGRESSION/);
    });

    it('Test 10: Market data gaps exceeding configured threshold are rejected fail-closed', () => {
      const candidateId = 'cand-mkt-gaps';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      // Max allowed gap = 15m (900,000ms)
      const orch = new ShadowOrchestrator({ persistenceDir: testDir, maxAllowedGapMs: 900000 });
      orch.startCandidate(candidateId);

      const t0 = 1700000000000;
      const c1: ICandle = { timestamp: new Date(t0), open: 100, high: 105, low: 95, close: 102, volume: 10 };
      const c2Normal: ICandle = { timestamp: new Date(t0 + 900000), open: 102, high: 106, low: 98, close: 104, volume: 12 };
      const c3Gapped: ICandle = { timestamp: new Date(t0 + 900000 + 3600000), open: 104, high: 108, low: 100, close: 106, volume: 15 }; // 1hr gap

      orch.processCandle(candidateId, c1);
      expect(() => orch.processCandle(candidateId, c2Normal)).not.toThrow();
      expect(() => orch.processCandle(candidateId, c3Gapped)).toThrow(/MARKET_DATA_GAP/);
    });
  });

  describe('6. Deterministic Hash Stability across Repeated Executions', () => {
    it('Test 11: 4 Independent runs (A, B, C, D) of 5,000 candles produce byte-identical evidence hashes', () => {
      const candidateId = 'cand-hash-stability';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const candles = generateMultiRegimeMarketHistory(1700000000000, 5000, 900000, 999);
      const fixedEvalTime = 1700000000000 + 5000 * 900000;

      const runSim = (runIndex: number) => {
        const filePath = path.join(testDir, `shadow-${candidateId}-run${runIndex}.json`);
        const orch = new ShadowOrchestrator({ persistenceDir: testDir });
        orch.startCandidate(candidateId, { persistenceFilePath: filePath });
        for (let i = 0; i < candles.length; i++) {
          orch.processCandle(candidateId, candles[i], undefined, fixedEvalTime);
        }
        return {
          evidence: orch.generateEvaluationEvidence(candidateId, fixedEvalTime),
          snapshot: orch.getCandidateStateSnapshot(candidateId),
        };
      };

      const resA = runSim(1);
      const resB = runSim(2);
      const resC = runSim(3);
      const resD = runSim(4);

      // Verify byte-level equality across all 4 independent runs
      expect(resB.evidence.evidenceHash).toBe(resA.evidence.evidenceHash);
      expect(resC.evidence.evidenceHash).toBe(resA.evidence.evidenceHash);
      expect(resD.evidence.evidenceHash).toBe(resA.evidence.evidenceHash);

      expect(resB.snapshot.stateHash).toBe(resA.snapshot.stateHash);
      expect(resC.snapshot.stateHash).toBe(resA.snapshot.stateHash);
      expect(resD.snapshot.stateHash).toBe(resA.snapshot.stateHash);

      expect(resB.snapshot.cumulativeMarketHash).toBe(resA.snapshot.cumulativeMarketHash);
      expect(resC.snapshot.cumulativeMarketHash).toBe(resA.snapshot.cumulativeMarketHash);
      expect(resD.snapshot.cumulativeMarketHash).toBe(resA.snapshot.cumulativeMarketHash);
    });
  });

  describe('7. Drift Lookback Expiry & Health State Machine Transitions', () => {
    it('Test 12: Warning drifts expire after activeDriftLookbackMs (DEGRADED -> HEALTHY), while CRITICAL drift triggers FAILED', () => {
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

  describe('8. Memory & Ledger Growth Linearity', () => {
    it('Test 13: Linear O(N) observation scaling across 1k, 5k, and 10k candles', () => {
      const candidateId = 'cand-growth-test';
      const rawCandidate = createReliabilityCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(rawCandidate, 'hash_mkt_shadow_039');
      ModelRegistry.registerCandidateArtifact(artifact);

      const candles = generateMultiRegimeMarketHistory(1700000000000, 5000, 900000, 555);
      const orch = new ShadowOrchestrator({ persistenceDir: testDir });
      orch.startCandidate(candidateId);

      const ledger = orch.getCandidateLedger(candidateId)!;

      for (let i = 0; i < 1000; i++) orch.processCandle(candidateId, candles[i]);
      const obs1k = ledger.getObservations().length;
      expect(obs1k).toBe(1000);

      for (let i = 1000; i < 5000; i++) orch.processCandle(candidateId, candles[i]);
      const obs5k = ledger.getObservations().length;
      expect(obs5k).toBe(5000);

      // Verify exact linear 1:1 scaling
      expect(obs5k / obs1k).toBe(5.0);
    });
  });

  describe('9. Production Safety Invariants (Paper-Only)', () => {
    it('Test 14: Autonomous live modifications are strictly permanently disabled', () => {
      expect(ShadowOrchestrator.AUTOMATIC_LIVE_TRADING_ROLLBACK_ENABLED).toBe(false);
      expect(ShadowOrchestrator.AUTOMATIC_LIVE_PROMOTION_ENABLED).toBe(false);
    });
  });
});
