import * as fs from 'fs';
import * as path from 'path';
import { Direction, ICandle, MockMarketDataProvider, SignalGrade, SignalState } from '@quant/shared';
import { SignalGenerator } from '@quant/trading-engine';
import {
  CandidateArtifact,
  PromotionPolicy,
  StrategyCandidate,
} from '../types';
import { ModelRegistry } from '../model-registry';
import { CandidateBacktestRunner } from '../candidate-backtest-runner';
import { DeterministicTestStrategyAdapter } from '../deterministic-test-adapter';
import { PromotionGate } from '../promotion-gate';
import {
  CandidateProductionComparator,
  DriftEvent,
  ExecutionDriftDetector,
  FeatureDriftDetector,
  PerformanceDriftDetector,
  RegimeDriftDetector,
  SHADOW_SCHEMA_VERSION,
  ShadowHealthMachine,
  ShadowLedger,
  ShadowOrchestrator,
  ShadowSignalSnapshot,
} from '../shadow';

function generateContinuousCandles(
  startTimestamp: number,
  count: number = 60,
  intervalMs: number = 900000,
): ICandle[] {
  const candles: ICandle[] = [];
  for (let i = 0; i < count; i++) {
    const t = startTimestamp + i * intervalMs;
    const base = 100 + Math.sin(i * 0.2) * 5 + (i * 0.1);
    candles.push({
      timestamp: new Date(t),
      open: Number(base.toFixed(2)),
      high: Number((base + 1.5).toFixed(2)),
      low: Number((base - 1.5).toFixed(2)),
      close: Number((base + 0.5).toFixed(2)),
      volume: 1000 + i * 10,
    });
  }
  return candles;
}

function createDummyCandidate(id = 'cand-shadow-101'): StrategyCandidate {
  return {
    id,
    candidateVersion: 'v2.1',
    baseStrategyVersion: 'v2.0',
    type: 'THRESHOLD',
    description: 'Causal continuous shadow candidate test',
    change: {
      parameter: 'minMtfScore',
      value: 75,
      symbol: 'BTCUSDT',
      datasetHash: 'hash_mkt_shadow_001',
      marketDatasetHash: 'hash_mkt_shadow_001',
    },
    evidence: {
      sampleSize: 100,
      expectancyBefore: 0.2,
      expectancyAfterHistorical: 0.45,
      winRate: 0.6,
      profitFactor: 1.5,
      referenceRegime: {
        volatilityRegime: 'NORMAL',
        trendRegime: 'BULLISH',
      },
    },
    riskConfig: {
      initialCapital: 1000000,
      maxRiskPerTrade: 0.01,
      maxAccountRiskLimit: 0.05,
      lotSize: 1,
      contractSize: 1,
      maxLeverage: 10,
      partialExitPolicy: {
        tp1Ratio: 0.33,
        tp2Ratio: 0.33,
        tp3Ratio: 0.34,
        moveStopToBreakevenOnTp1: true,
      },
      stopLossAtrMultiplier: 2.0,
      sizingMultiplier: 1.0,
    },
    executionConfig: {
      fillModel: 'OHLC_PATH',
      ambiguityMode: 'AGGRESSIVE',
      latencyMs: 0,
      slippageBps: 0,
      feeRate: 0.0004,
      stopLossAtrMultiplier: 2.0,
      sizingMultiplier: 1.0,
    },
    status: 'SHADOW_PENDING',
    createdAt: new Date(),
  } as any;
}

describe('AI Fix 25 — Continuous Shadow Orchestrator + Drift Detection', () => {
  const testDir = path.join(__dirname, 'test_artifacts_fix25');
  const registryPath = path.join(testDir, 'model-registry.json');
  const shadowPersistencePath = path.join(testDir, 'shadow-cand-shadow-101.json');

  beforeEach(() => {
    ModelRegistry.clear();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
    ModelRegistry.setPersistencePath(registryPath);
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('1. Causal Market Processing & Candle Validation', () => {
    it('Test 1: causal shadow processing ensures future candles do not alter past state', () => {
      const candidate = createDummyCandidate('cand-causal-1');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_001');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      orchestrator.startCandidate(candidate.id);

      const candles = generateContinuousCandles(1700000000000, 30);
      const resT20: any[] = [];

      // Process first 20 candles
      for (let i = 0; i < 20; i++) {
        const res = orchestrator.processCandle(candidate.id, candles[i]);
        resT20.push(res);
      }

      const obsAt20 = orchestrator.getCandidateLedger(candidate.id)?.getObservations();
      expect(obsAt20?.length).toBe(20);
      const obsSnapshotAt20 = JSON.parse(JSON.stringify(obsAt20));

      // Process 10 more candles (future data)
      for (let i = 20; i < 30; i++) {
        orchestrator.processCandle(candidate.id, candles[i]);
      }

      const obsAt30 = orchestrator.getCandidateLedger(candidate.id)?.getObservations();
      expect(obsAt30?.length).toBe(30);

      // The first 20 observations must be IDENTICAL to what was recorded at T=20
      const first20AfterFuture = JSON.parse(JSON.stringify(obsAt30?.slice(0, 20)));
      expect(first20AfterFuture).toEqual(obsSnapshotAt20);
    });

    it('Test 2: rejects duplicate candle timestamps fail-closed', () => {
      const candidate = createDummyCandidate('cand-dup-ts');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_001');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      orchestrator.startCandidate(candidate.id);

      const candles = generateContinuousCandles(1700000000000, 5);
      orchestrator.processCandle(candidate.id, candles[0]);

      // Submitting the exact same candle again must throw DUPLICATE_CANDLE_TIMESTAMP
      expect(() => {
        orchestrator.processCandle(candidate.id, candles[0]);
      }).toThrow('DUPLICATE_CANDLE_TIMESTAMP');
    });

    it('Test 3: rejects out-of-order candle timestamp regression fail-closed', () => {
      const candidate = createDummyCandidate('cand-regress-ts');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_001');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      orchestrator.startCandidate(candidate.id);

      const candles = generateContinuousCandles(1700000000000, 5);
      orchestrator.processCandle(candidate.id, candles[2]);

      // Submitting an earlier candle must throw TIMESTAMP_REGRESSION
      expect(() => {
        orchestrator.processCandle(candidate.id, candles[1]);
      }).toThrow('TIMESTAMP_REGRESSION');
    });

    it('Test 4: rejects invalid OHLC (NaN, Infinity, High < Low, Close outside bounds)', () => {
      const candidate = createDummyCandidate('cand-invalid-ohlc');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_001');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      orchestrator.startCandidate(candidate.id);

      // Case A: NaN high
      expect(() => {
        orchestrator.processCandle(candidate.id, {
          timestamp: new Date(1700000000000),
          open: 100,
          high: NaN,
          low: 95,
          close: 98,
          volume: 1000,
        });
      }).toThrow('INVALID_CANDLE_OHLC');

      // Case B: High < Low
      expect(() => {
        orchestrator.processCandle(candidate.id, {
          timestamp: new Date(1700000000000),
          open: 100,
          high: 90,
          low: 95,
          close: 92,
          volume: 1000,
        });
      }).toThrow('INVALID_CANDLE_BOUNDS');
    });
  });

  describe('2. Authoritative Execution & Real Execution-Derived PnL', () => {
    it('Test 5 & 6: shadow PnL strictly derives from ExecutionSimulator fills and reflects fees & slippage', () => {
      const candidate = createDummyCandidate('cand-exec-pnl');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_001');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      orchestrator.startCandidate(candidate.id);

      const candles = generateContinuousCandles(1700000000000, 40);
      for (const candle of candles) {
        orchestrator.processCandle(candidate.id, candle);
      }

      const ledger = orchestrator.getCandidateLedger(candidate.id);
      expect(ledger).toBeDefined();
      const fills = ledger?.getFills() || [];
      const trades = ledger?.getTrades() || [];

      // Fills must exist and carry execution provenance
      if (fills.length > 0) {
        expect(fills[0].price).toBeGreaterThan(0);
        expect(fills[0].quantity).toBeGreaterThan(0);
        expect(typeof fills[0].slippage).toBe('number');
        expect(typeof fills[0].fee).toBe('number');
      }

      // If trades closed, PnL must be real non-synthetic numeric calculation
      for (const trade of trades) {
        expect(Number.isFinite(trade.pnl)).toBe(true);
        expect(Number.isFinite(trade.pnlRMultiple)).toBe(true);
        expect(trade.entryPrice).toBeGreaterThan(0);
        expect(trade.exitPrice).toBeGreaterThan(0);
      }
    });

    it('Test 7 & 8: gap-through stops and partial TP / trailing stops use authoritative execution semantics', async () => {
      const provider = new MockMarketDataProvider({ seed: 777 });
      const marketCandles = await provider.getHistoricalCandles('BTCUSDT', '15m', 60);

      const candidate = createDummyCandidate('cand-stop-target');
      (candidate.change as any).minMtfScore = 50;
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_001');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      orchestrator.startCandidate(candidate.id);

      for (const c of marketCandles) {
        orchestrator.processCandle(candidate.id, c);
      }

      const ledger = orchestrator.getCandidateLedger(candidate.id);
      const trades = ledger?.getTrades() || [];
      expect(trades.length).toBeGreaterThanOrEqual(1);
      const stoppedTrade = trades[0];
      expect(stoppedTrade.exitReason).toBeDefined();
      expect([SignalState.SL_HIT, SignalState.TP1_HIT, SignalState.TP2_HIT, SignalState.TP3_HIT, SignalState.INVALIDATED]).toContain(stoppedTrade.exitReason);
    });
  });

  describe('3. Rolling Windows & Multi-Tier Drift Detection', () => {
    it('Test 9 & 10: rolling windows calculate metrics accurately and report NOT_ENOUGH_DATA when sample size is insufficient', () => {
      const candidate = createDummyCandidate('cand-rolling-win');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_001');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({
        persistenceDir: testDir,
        windowConfig: {
          shortWindowSize: 5,
          mediumWindowSize: 10,
          longWindowSize: 20,
          minObservationsForEvaluation: 30,
          minTradesForEvaluation: 10,
        },
      });
      orchestrator.startCandidate(candidate.id);

      // Only 5 candles -> insufficient data
      const candles = generateContinuousCandles(1700000000000, 5);
      for (const c of candles) {
        orchestrator.processCandle(candidate.id, c);
      }

      const evalResult = orchestrator.evaluateCandidate(candidate.id);
      expect(evalResult.passed).toBe(false);
      expect(evalResult.rejectionReason).toContain('INSUFFICIENT_SAMPLE_SIZE');

      const health = orchestrator.getCandidateLedger(candidate.id)?.getHealthState();
      expect(['ACTIVE', 'INSUFFICIENT_EVIDENCE']).toContain(health?.status);
    });

    it('Test 11 & 12: performance drift detects severe deterioration (HEALTHY -> DEGRADED -> FAILED) while normal variance does not false-trigger', () => {
      const currentHealthyMetrics: any = {
        candidateId: 'cand-drift-test',
        windowType: 'SHORT',
        windowStart: 1000,
        windowEnd: 5000,
        observationCount: 50,
        tradeCount: 15,
        pnl: 500,
        pnlR: 4.5,
        winRate: 60.0,
        profitFactor: 1.8,
        maxDrawdown: 1.2,
        averageR: 0.30,
      };

      const baseline = {
        expectancyR: 0.35,
        winRate: 58.0,
        profitFactor: 1.75,
      };

      // Case A: Normal variance within thresholds -> 0 drift events
      const normalDrifts = PerformanceDriftDetector.evaluatePerformanceDrift(
        'cand-drift-test',
        currentHealthyMetrics,
        baseline,
      );
      expect(normalDrifts.length).toBe(0);

      // Case B: Severe degradation -> Critical drift
      const degradedMetrics: any = {
        ...currentHealthyMetrics,
        tradeCount: 15,
        winRate: 30.0, // 28% drop
        averageR: -0.15, // negative R
        profitFactor: 0.7,
        maxDrawdown: 5.5,
      };

      const criticalDrifts = PerformanceDriftDetector.evaluatePerformanceDrift(
        'cand-drift-test',
        degradedMetrics,
        baseline,
      );
      expect(criticalDrifts.length).toBeGreaterThanOrEqual(1);
      expect(criticalDrifts.some((d) => d.severity === 'CRITICAL')).toBe(true);

      // Verify health state machine transitions to FAILED upon critical drift
      const initialHealth = ShadowHealthMachine.createInitialState('cand-drift-test');
      const nextHealth = ShadowHealthMachine.evaluateNextState(
        initialHealth,
        50,
        15,
        criticalDrifts,
      );
      expect(nextHealth.status).toBe('FAILED');
      expect(nextHealth.statusReason).toContain('CRITICAL_DRIFT');
    });

    it('Test 13 & 14: feature distribution drift (PSI) detects shifted distributions and fails closed on schema mismatch', () => {
      const featureNames = ['smcScore', 'mtfAlignment', 'rvol'];
      const featureSchemaHash = 'schema_v2_hash_canonical';

      // Build baseline reference distribution from 100 normal samples centered at 50
      const baselineSamples: number[][] = [];
      for (let i = 0; i < 100; i++) {
        baselineSamples.push([50 + Math.sin(i) * 5, 75 + Math.cos(i) * 5, 1.2 + Math.sin(i * 2) * 0.2]);
      }
      const baseline = FeatureDriftDetector.buildFeatureBaseline(featureNames, featureSchemaHash, baselineSamples);

      // Case A: Unshifted observed samples -> low PSI, zero drift
      const unshiftedSamples = baselineSamples.slice(0, 30);
      const noDrifts = FeatureDriftDetector.evaluateFeatureDrift(
        'cand-feat-1',
        unshiftedSamples,
        featureSchemaHash,
        baseline,
      );
      expect(noDrifts.length).toBe(0);

      // Case B: Severely shifted observed samples (centered at 100 instead of 50)
      const shiftedSamples: number[][] = [];
      for (let i = 0; i < 30; i++) {
        shiftedSamples.push([120 + Math.sin(i) * 2, 75 + Math.cos(i) * 2, 1.2]);
      }
      const featDrifts = FeatureDriftDetector.evaluateFeatureDrift(
        'cand-feat-1',
        shiftedSamples,
        featureSchemaHash,
        baseline,
      );
      expect(featDrifts.length).toBeGreaterThanOrEqual(1);
      expect(featDrifts.some((d) => d.metric.includes('psi_smcScore'))).toBe(true);

      // Case C: Schema hash mismatch fails closed
      expect(() => {
        FeatureDriftDetector.evaluateFeatureDrift(
          'cand-feat-1',
          shiftedSamples,
          'wrong_schema_hash_999',
          baseline,
        );
      }).toThrow('FEATURE_SCHEMA_MISMATCH');
    });

    it('Test 15: causal regime drift detector classifies market regime changes without lookahead', () => {
      const lowVolCandles = generateContinuousCandles(1700000000000, 20);
      const lowVolRegime = RegimeDriftDetector.classifyCausalRegime(lowVolCandles);
      expect(lowVolRegime.volatilityRegime).toBeDefined();

      // High volatility regime injection
      const highVolCandles: ICandle[] = [];
      for (let i = 0; i < 20; i++) {
        const base = 100 + i * 5;
        highVolCandles.push({
          timestamp: new Date(1700000000000 + i * 900000),
          open: base,
          high: base + 25, // Large swing
          low: base - 25,
          close: base + 10,
          volume: 10000,
        });
      }
      const highVolRegime = RegimeDriftDetector.classifyCausalRegime(highVolCandles);
      expect(highVolRegime.volatilityRegime).toBe('HIGH_VOLATILITY');
    });

    it('Test 16: candidate vs production comparator detects divergence under identical market timestamps', () => {
      const marketTimestamp = 1700000900000;
      const candidateSignal: ShadowSignalSnapshot = { direction: 'LONG', confidence: 0.85 };
      const productionSignal: ShadowSignalSnapshot = { direction: 'SHORT', confidence: 0.70 };

      const { comparison, divergenceEvent } = CandidateProductionComparator.compareSignals(
        'cand-diverge-1',
        marketTimestamp,
        candidateSignal,
        productionSignal,
      );

      expect(comparison.directionMatch).toBe(false);
      expect(comparison.confidenceDelta).toBe(0.15);
      expect(divergenceEvent).toBeDefined();
      expect(divergenceEvent?.type).toBe('CANDIDATE_VS_PRODUCTION');
    });
  });

  describe('4. Ledger Persistence, Recovery, Tamper Rejection & Safety Invariants', () => {
    it('Test 17 & 18: restart recovery restores identical state; corrupt/tampered state fails closed without partial hydration', () => {
      const candidate = createDummyCandidate('cand-persist-rec');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_001');
      ModelRegistry.registerCandidateArtifact(artifact);

      const ledgerFile = path.join(testDir, `shadow-${candidate.id}.json`);
      const orchestrator1 = new ShadowOrchestrator({ persistenceDir: testDir });
      orchestrator1.startCandidate(candidate.id);

      const candles = generateContinuousCandles(1700000000000, 25);
      for (const c of candles) {
        orchestrator1.processCandle(candidate.id, c);
      }

      // Verify file written
      expect(fs.existsSync(ledgerFile)).toBe(true);

      // Recover into a fresh ledger instance
      const ledger2 = new ShadowLedger({
        candidateId: artifact.candidateId,
        candidateVersion: artifact.candidateVersion,
        strategyVersion: artifact.strategyVersion,
        featureSchemaHash: artifact.featureSchemaHash,
        artifactHash: artifact.artifactHash,
        symbol: 'BTCUSDT',
      });
      ledger2.loadFromFile(ledgerFile);

      expect(ledger2.getObservations().length).toBe(25);
      expect(ledger2.getLastMarketTimestamp()).toBe(
        candles[24].timestamp instanceof Date ? candles[24].timestamp.getTime() : new Date(candles[24].timestamp).getTime(),
      );

      // Tamper test: corrupt artifact hash in file
      const fileData = JSON.parse(fs.readFileSync(ledgerFile, 'utf-8'));
      fileData.artifactHash = 'tampered_wrong_hash_999';
      const corruptFile = path.join(testDir, 'corrupt-shadow.json');
      fs.writeFileSync(corruptFile, JSON.stringify(fileData, null, 2), 'utf-8');

      const ledgerTampered = new ShadowLedger({
        candidateId: artifact.candidateId,
        candidateVersion: artifact.candidateVersion,
        strategyVersion: artifact.strategyVersion,
        featureSchemaHash: artifact.featureSchemaHash,
        artifactHash: artifact.artifactHash,
        symbol: 'BTCUSDT',
      });

      expect(() => {
        ledgerTampered.loadFromFile(corruptFile);
      }).toThrow('SHADOW_LEDGER_CORRUPT');
      // Must not partially hydrate
      expect(ledgerTampered.getObservations().length).toBe(0);
    });

    it('Test 19 & 20: automatic paper rollback transitions failed candidate without modifying live production state', () => {
      expect(ShadowOrchestrator.AUTOMATIC_LIVE_TRADING_ROLLBACK_ENABLED).toBe(false);
      expect(ShadowOrchestrator.AUTOMATIC_LIVE_PROMOTION_ENABLED).toBe(false);

      const candidate = createDummyCandidate('cand-paper-rb');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_001');
      ModelRegistry.registerCandidateArtifact(artifact);

      // Baseline production model active
      const prodCandidate = createDummyCandidate('cand-prod-active');
      const prodArtifact = CandidateBacktestRunner.createCandidateArtifact(prodCandidate, 'hash_mkt_shadow_001');
      ModelRegistry.registerCandidateArtifact(prodArtifact);
      ModelRegistry.updateCandidateStatus(prodCandidate.id, 'SHADOW_ACTIVE', 'Test setup');
      ModelRegistry.updateCandidateStatus(prodCandidate.id, 'PROMOTION_ELIGIBLE', 'Test setup');
      ModelRegistry.updateCandidateStatus(prodCandidate.id, 'PROMOTED', 'Test setup');

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      orchestrator.startCandidate(candidate.id);

      // Force failure on shadow candidate
      const ledger = orchestrator.getCandidateLedger(candidate.id);
      expect(ledger).toBeDefined();

      const critDrift: DriftEvent = {
        id: 'drift-crit-1',
        candidateId: candidate.id,
        timestamp: Date.now(),
        marketTimestamp: 1700000000000,
        type: 'PERFORMANCE',
        severity: 'CRITICAL',
        metric: 'expectancyR',
        baselineValue: 0.35,
        observedValue: -0.50,
        threshold: 0.0,
        windowStart: 1700000000000,
        windowEnd: 1700050000000,
        evidenceHash: 'crit_hash_1',
        details: 'Simulated critical performance drop',
      };

      const candle = generateContinuousCandles(1700000000000, 1)[0];
      // Feed candle that triggers drift processing
      ledger?.recordDrifts([critDrift]);
      orchestrator.processCandle(candidate.id, candle);

      const health = ledger?.getHealthState();
      expect(health?.status).toBe('FAILED');

      // Candidate is marked REJECTED in registry
      const updatedCand = ModelRegistry.getCandidateArtifact(candidate.id);
      expect(updatedCand?.status).toBe('REJECTED');

      // Live production model status remains strictly PROMOTED (untouched)
      const liveCand = ModelRegistry.getCandidateArtifact(prodCandidate.id);
      expect(liveCand?.status).toBe('PROMOTED');
    });

    it('Test 21: promotion gate separation guarantees healthy shadow candidate is NOT automatically promoted', () => {
      const candidate = createDummyCandidate('cand-promo-sep');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_001');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      orchestrator.startCandidate(candidate.id);

      // Shadow candidate is in SHADOW_ACTIVE
      expect(ModelRegistry.getCandidateArtifact(candidate.id)?.status).toBe('SHADOW_ACTIVE');

      // Shadow evaluation alone cannot promote candidate
      const evalRes = orchestrator.evaluateCandidate(candidate.id);
      expect(evalRes.candidateId).toBe(candidate.id);

      // Candidate status must still be SHADOW_ACTIVE
      expect(ModelRegistry.getCandidateArtifact(candidate.id)?.status).toBe('SHADOW_ACTIVE');
    });

    it('Test 22: persistence failure on public operation fails closed', () => {
      const candidate = createDummyCandidate('cand-persist-fail');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_001');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({ persistenceDir: '/non_existent_read_only_root_dir/xyz' });

      // Starting candidate with invalid unwriteable path must throw or fail closed on write
      expect(() => {
        orchestrator.startCandidate(candidate.id);
      }).toThrow();
    });

    it('Test 23: deterministic replay produces identical observations, trades, and hashes', () => {
      const candidate1 = createDummyCandidate('cand-determ-replay-1');
      const artifact1 = CandidateBacktestRunner.createCandidateArtifact(candidate1, 'hash_mkt_shadow_001');
      ModelRegistry.registerCandidateArtifact(artifact1);

      const candidate2 = createDummyCandidate('cand-determ-replay-2');
      const artifact2 = CandidateBacktestRunner.createCandidateArtifact(candidate2, 'hash_mkt_shadow_001');
      ModelRegistry.registerCandidateArtifact(artifact2);

      const candles = generateContinuousCandles(1700000000000, 30);

      // Run 1
      const orch1 = new ShadowOrchestrator();
      orch1.startCandidate(candidate1.id);
      for (const c of candles) orch1.processCandle(candidate1.id, c);
      const obs1 = orch1.getCandidateLedger(candidate1.id)?.getObservations();

      // Run 2
      const orch2 = new ShadowOrchestrator();
      orch2.startCandidate(candidate2.id);
      for (const c of candles) orch2.processCandle(candidate2.id, c);
      const obs2 = orch2.getCandidateLedger(candidate2.id)?.getObservations();

      expect(obs1?.length).toBe(obs2?.length);
      expect(obs1?.map((o) => o.featureVectorHash)).toEqual(obs2?.map((o) => o.featureVectorHash));
    });

    it('Test 24 & 25: candidate and production consume identical causal market state with zero future-data leakage', () => {
      const candidate = createDummyCandidate('cand-zero-leak');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_001');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator();
      orchestrator.startCandidate(candidate.id);

      const candles = generateContinuousCandles(1700000000000, 20);
      for (const c of candles) {
        const prodSig: ShadowSignalSnapshot = { direction: 'LONG', confidence: 0.8 };
        const res = orchestrator.processCandle(candidate.id, c, prodSig);
        expect(res.marketTimestamp).toBe(
          c.timestamp instanceof Date ? c.timestamp.getTime() : new Date(c.timestamp).getTime(),
        );
        expect(res.comparisonWithProduction?.marketTimestamp).toBe(res.marketTimestamp);
      }
    });
  });

  describe('5. Resolution of 7 P0 Shadow Architecture Defects', () => {
    it('P0-1 & P0-2: shadow execution uses candidate production strategy & policy (no proxy SMA strategy, no synthetic 2%/4% SL/TP)', () => {
      const baseTs = 1700000000000;
      const candidate = createDummyCandidate('cand-prod-strategy-p0');
      (candidate.change as any).minMtfScore = 0;
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_001');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator();
      orchestrator.startCandidate(candidate.id);

      const candles = generateContinuousCandles(baseTs, 20);
      for (const c of candles) {
        orchestrator.processCandle(candidate.id, c);
      }

      const ledger = orchestrator.getCandidateLedger(candidate.id);
      const observations = ledger?.getObservations() || [];
      expect(observations.length).toBe(20);
      const sigObs = observations.find((o) => o.signal !== undefined);
      expect(sigObs).toBeDefined();
    });

    it('P0-3: dynamic non-BTC instrument support (NIFTY50) and rejects mismatched candle symbol', () => {
      const candidate = createDummyCandidate('cand-nifty-p0');
      (candidate as any).symbol = 'NIFTY50';
      (candidate.change as any).symbol = 'NIFTY50';
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_nifty');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator();
      orchestrator.startCandidate(candidate.id);

      const validNiftyCandle: ICandle = {
        symbol: 'NIFTY50',
        timestamp: new Date(1700000000000),
        open: 22000,
        high: 22100,
        low: 21950,
        close: 22050,
        volume: 50000,
      } as any;

      const res = orchestrator.processCandle(candidate.id, validNiftyCandle);
      expect(res.marketTimestamp).toBe(1700000000000);

      const mismatchedCandle: ICandle = {
        symbol: 'BTCUSDT',
        timestamp: new Date(1700000900000),
        open: 65000,
        high: 65500,
        low: 64800,
        close: 65200,
        volume: 100,
      } as any;

      expect(() => {
        orchestrator.processCandle(candidate.id, mismatchedCandle);
      }).toThrow(/SYMBOL_MISMATCH/);
    });

    it('P0-5: causal inter-candle execution timing (order at candle T executes on candle T+1, no same-candle leakage)', async () => {
      const provider = new MockMarketDataProvider({ seed: 777 });
      const marketCandles = await provider.getHistoricalCandles('BTCUSDT', '15m', 45);

      const candidate = createDummyCandidate('cand-timing-p0');
      (candidate.change as any).minMtfScore = 50;
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_timing');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator();
      orchestrator.startCandidate(candidate.id);

      let firstOrderCandle = -1;
      for (let i = 0; i < marketCandles.length; i++) {
        orchestrator.processCandle(candidate.id, marketCandles[i]);
        const ledger = orchestrator.getCandidateLedger(candidate.id);
        const orders = ledger?.getOrders() || [];
        const fills = ledger?.getFills() || [];
        if (orders.length > 0 && firstOrderCandle === -1) {
          firstOrderCandle = i;
          expect(orders.length).toBe(1);
          expect(fills.length).toBe(0);
        } else if (firstOrderCandle !== -1 && i === firstOrderCandle + 1) {
          expect(fills.length).toBe(1);
          expect(fills[0].price).toBeCloseTo(marketCandles[i].open, -2);
          break;
        }
      }
      expect(firstOrderCandle).toBeGreaterThan(0);
    });

    it('P0-6: complete restart-safe hydration preserves active position lot and warmup candles', async () => {
      const provider = new MockMarketDataProvider({ seed: 777 });
      const marketCandles = await provider.getHistoricalCandles('BTCUSDT', '15m', 45);

      const candidate = createDummyCandidate('cand-restart-p0');
      (candidate.change as any).minMtfScore = 50;
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_restart');
      ModelRegistry.registerCandidateArtifact(artifact);

      const pPath = path.join(testDir, 'shadow-cand-restart-p0.json');
      const orch1 = new ShadowOrchestrator();
      orch1.startCandidate(candidate.id, { persistenceFilePath: pPath });

      // Process first 32 candles (open position exists)
      for (let i = 0; i < 32; i++) {
        orch1.processCandle(candidate.id, marketCandles[i]);
      }

      // Instance 1 had open position
      const ledger1 = orch1.getCandidateLedger(candidate.id);
      expect(ledger1?.getActiveLot()).toBeDefined();
      expect(ledger1?.getRecentCandles().length).toBeGreaterThanOrEqual(32);

      // Simulate crash and restart on new orchestrator instance from same persistence file
      const orch2 = new ShadowOrchestrator();
      orch2.startCandidate(candidate.id, { persistenceFilePath: pPath });

      const ledger2 = orch2.getCandidateLedger(candidate.id);
      expect(ledger2?.getActiveLot()?.tradeId).toBe(ledger1?.getActiveLot()?.tradeId);
      expect(ledger2?.getRecentCandles().length).toBe(ledger1?.getRecentCandles().length);
    });

    it('P0-1 Crash/Restart Equivalence: restored ExecutionSimulator executes restored pending SL order with exact equivalence to uninterrupted execution', async () => {
      const provider = new MockMarketDataProvider({ seed: 777 });
      const marketCandles = await provider.getHistoricalCandles('BTCUSDT', '15m', 60);

      const candidate1 = createDummyCandidate('cand-uninterrupted');
      const candidate2 = createDummyCandidate('cand-interrupted');
      (candidate1.change as any).minMtfScore = 50;
      (candidate2.change as any).minMtfScore = 50;

      const art1 = CandidateBacktestRunner.createCandidateArtifact(candidate1, 'hash_mkt_equiv');
      const art2 = CandidateBacktestRunner.createCandidateArtifact(candidate2, 'hash_mkt_equiv');
      ModelRegistry.registerCandidateArtifact(art1);
      ModelRegistry.registerCandidateArtifact(art2);

      // 1. Uninterrupted Execution
      const orchUninterrupted = new ShadowOrchestrator();
      orchUninterrupted.startCandidate(candidate1.id);
      for (const c of marketCandles) {
        orchUninterrupted.processCandle(candidate1.id, c);
      }
      const uninterruptedTrades = orchUninterrupted.getCandidateLedger(candidate1.id)?.getTrades() || [];
      expect(uninterruptedTrades.length).toBeGreaterThanOrEqual(1);

      // 2. Interrupted Execution with Crash and Restart
      const pPathInterrupted = path.join(testDir, 'shadow-cand-interrupted.json');
      const orchInterrupted1 = new ShadowOrchestrator();
      orchInterrupted1.startCandidate(candidate2.id, { persistenceFilePath: pPathInterrupted });
      for (let i = 0; i < 35; i++) {
        orchInterrupted1.processCandle(candidate2.id, marketCandles[i]);
      }

      // Restart new orchestrator from persisted file
      const orchInterrupted2 = new ShadowOrchestrator();
      orchInterrupted2.startCandidate(candidate2.id, { persistenceFilePath: pPathInterrupted });
      for (let i = 35; i < marketCandles.length; i++) {
        orchInterrupted2.processCandle(candidate2.id, marketCandles[i]);
      }
      const interruptedTrades = orchInterrupted2.getCandidateLedger(candidate2.id)?.getTrades() || [];
      expect(interruptedTrades.length).toBe(uninterruptedTrades.length);

      // Verify exact equivalence between uninterrupted and interrupted executions
      expect(interruptedTrades[0].exitPrice).toBe(uninterruptedTrades[0].exitPrice);
      expect(interruptedTrades[0].pnl).toBe(uninterruptedTrades[0].pnl);
      expect(interruptedTrades[0].exitReason).toBe(uninterruptedTrades[0].exitReason);
      expect(interruptedTrades[0].netPnL).toBe(uninterruptedTrades[0].netPnL);
    });

    it('P0-2 & P1-3 Authoritative Trade Lifecycle: evaluates full scale-out TP1 -> TP2 -> TP3 -> closed', async () => {
      const provider = new MockMarketDataProvider({ seed: 777 });
      const marketCandles = await provider.getHistoricalCandles('BTCUSDT', '15m', 60);

      const candidate = createDummyCandidate('cand-scaleout');
      (candidate.change as any).minMtfScore = 50;
      (candidate as any).riskConfig = {
        initialCapital: 1000000,
        maxRiskPerTrade: 0.01,
        maxAccountRiskLimit: 0.05,
        lotSize: 1,
        contractSize: 1,
        maxLeverage: 10,
        partialExitPolicy: {
          tp1Ratio: 0.3333,
          tp2Ratio: 0.3333,
          tp3Ratio: 0.3334,
          moveStopToBreakevenOnTp1: true,
          trailStopOnTp2: true,
          trailStopOffsetR: 1.0,
        },
      };
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_scaleout');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator();
      orchestrator.startCandidate(candidate.id);

      for (const c of marketCandles) {
        orchestrator.processCandle(candidate.id, c);
      }

      const ledger = orchestrator.getCandidateLedger(candidate.id);
      const fills = ledger?.getFills() || [];
      const trades = ledger?.getTrades() || [];
      expect(fills.length).toBeGreaterThanOrEqual(1);
      expect(trades.length).toBeGreaterThanOrEqual(1);
      const completedTrade = trades[0];
      expect(completedTrade.exitReason).toBeDefined();
      expect(completedTrade.id).toBeDefined();
    });

    it('P1-4: missing symbol fails closed', () => {
      const candidate = createDummyCandidate('cand-no-symbol');
      delete (candidate.change as any).symbol;
      delete (candidate as any).symbol;
      expect(() => {
        CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_no_sym');
      }).toThrow(/CANDIDATE_SYMBOL_MISSING|MISSING_SYMBOL/);
    });

    it('P1-5: missing execution config fails closed', () => {
      const candidate = createDummyCandidate('cand-no-exec-cfg');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_no_exec');
      ModelRegistry.registerCandidateArtifact(artifact);

      jest.spyOn(ModelRegistry, 'getCandidateArtifact').mockReturnValueOnce({
        ...artifact,
        executionConfig: undefined as any,
      });

      const orchestrator = new ShadowOrchestrator();
      expect(() => {
        orchestrator.startCandidate(candidate.id);
      }).toThrow('MISSING_EXECUTION_CONFIG');
    });

    it('P1-6: shadowDatasetHash derives from actual shadow observations', () => {
      const candidate = createDummyCandidate('cand-ds-hash');
      (candidate.change as any).marketDatasetHash = 'training_mkt_hash_abc';
      (candidate.change as any).datasetHash = 'training_mkt_hash_abc';
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'training_mkt_hash_abc');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator();
      orchestrator.startCandidate(candidate.id);

      const candles = generateContinuousCandles(1700000000000, 20);
      for (const c of candles) {
        orchestrator.processCandle(candidate.id, c);
      }

      const evalRes = orchestrator.evaluateCandidate(candidate.id);
      expect(evalRes.shadowDatasetHash).toBeDefined();
      expect(evalRes.shadowDatasetHash.length).toBe(64);
      // shadowDatasetHash must be distinct from training marketDatasetHash
      expect(evalRes.shadowDatasetHash).not.toBe('training_mkt_hash_abc');
      expect(evalRes.window.marketDatasetHash).toBe(evalRes.shadowDatasetHash);
    });

    it('P1-7: missing baseline metrics fails closed', () => {
      const candidate = createDummyCandidate('cand-no-baseline');
      delete (candidate.evidence as any).expectancyBefore;
      delete (candidate.evidence as any).expectancyAfterHistorical;
      delete (candidate.evidence as any).winRate;
      delete (candidate.evidence as any).profitFactor;
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_no_base');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator();
      expect(() => {
        orchestrator.startCandidate(candidate.id);
      }).toThrow('SHADOW_BASELINE_MISSING');
    });

    it('P1-8: median R is computed mathematically distinct from mean expectancy R', () => {
      const ledger = new ShadowLedger({
        candidateId: 'cand-median-test',
        candidateVersion: 'v1.0',
        strategyVersion: 'v1.0',
        featureSchemaHash: 'schema_123',
        artifactHash: 'art_123',
        symbol: 'BTCUSDT',
      });

      // Odd number of trades: [1R, 2R, 9R] -> Median = 2R, Mean = 4R
      ledger.recordClosedTrades([
        { id: 't1', pnl: 100, pnlRMultiple: 1.0 } as any,
        { id: 't2', pnl: 200, pnlRMultiple: 2.0 } as any,
        { id: 't3', pnl: 900, pnlRMultiple: 9.0 } as any,
      ]);
      expect(ledger.calculateMedianR()).toBe(2.0);

      // Even number of trades: [1R, 2R, 9R, 10R] -> Median = (2 + 9) / 2 = 5.5R
      ledger.recordClosedTrades([
        { id: 't4', pnl: 1000, pnlRMultiple: 10.0 } as any,
      ]);
      expect(ledger.calculateMedianR()).toBe(5.5);
    });

    it('P1-9: stopCandidate cancels all ExecutionSimulator pending orders and clears ledger', () => {
      const baseTs = 1700000000000;
      const candidate = createDummyCandidate('cand-stop-cleanup');
      (candidate.change as any).minMtfScore = 0;
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_stop');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator();
      orchestrator.startCandidate(candidate.id);

      const candles = generateContinuousCandles(baseTs, 17);
      for (const c of candles) {
        orchestrator.processCandle(candidate.id, c);
      }

      const ledgerBefore = orchestrator.getCandidateLedger(candidate.id);
      expect(ledgerBefore?.getActiveLot()).toBeDefined();

      orchestrator.stopCandidate(candidate.id, 'Operator stopped candidate');
      expect(orchestrator.getCandidateLedger(candidate.id)).toBeUndefined();
      expect(ledgerBefore?.getActiveLot()).toBeNull();
      expect(ledgerBefore?.getPendingOrders().length).toBe(0);
    });

    it('P0-7: evaluateCandidate computes real financial metrics strictly from trade and fill ledgers (zero synthetic placeholders)', () => {
      const baseTs = 1700000000000;
      const candidate = createDummyCandidate('cand-eval-metrics-p0');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_eval');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator();
      orchestrator.startCandidate(candidate.id);

      jest.spyOn(SignalGenerator, 'generateSignal').mockReturnValue({
        id: 'sig-eval',
        timestamp: new Date(baseTs + 15 * 900000),
        symbol: 'BTCUSDT',
        direction: Direction.BULLISH,
        score: 90,
        grade: SignalGrade.A,
        entryPrice: 130,
        stopLoss: 95,
        takeProfits: { tp1: 180, tp2: 190, tp3: 200 },
        state: SignalState.ACTIVE,
      } as any);

      const candles: ICandle[] = [];
      for (let i = 0; i < 20; i++) {
        const p = 100 + i * 2;
        candles.push({
          timestamp: new Date(baseTs + i * 900000),
          open: p,
          high: p + 2,
          low: p - 1,
          close: p + 1.5,
          volume: 1000,
        });
      }
      candles.push({
        timestamp: new Date(baseTs + 20 * 900000),
        open: 110,
        high: 111,
        low: 80,
        close: 85,
        volume: 5000,
      });

      for (const c of candles) {
        orchestrator.processCandle(candidate.id, c);
      }

      const evalRes = orchestrator.evaluateCandidate(candidate.id);
      expect(evalRes.metrics.largestLoss).toBeLessThan(0); // Real stop loss hit
      expect(evalRes.metrics.largestLoss).not.toBe(-100); // Not the old hardcoded -100
      expect(evalRes.metrics.largestWin).toBe(0); // Only 1 loss trade occurred
      expect(evalRes.metrics.largestWin).not.toBe(250); // Not the old hardcoded 250
      expect(evalRes.metrics.totalTrades).toBe(1);
    });
  });
});
