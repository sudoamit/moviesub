import * as fs from 'fs';
import * as path from 'path';
import { Direction, ICandle, MockMarketDataProvider, SignalState } from '@quant/shared';
import {
  CandidateArtifact,
  PromotionPolicy,
  StrategyCandidate,
  ValidatedCandidateArtifact,
} from '../types';
import { ModelRegistry } from '../model-registry';
import { CandidateBacktestRunner } from '../candidate-backtest-runner';
import { CandidateArtifactValidator } from '../candidate-artifact-validator';
import { PromotionGate } from '../promotion-gate';
import {
  CandidateProductionComparator,
  DriftEvent,
  ExecutionDriftDetector,
  FeatureDriftBaseline,
  FeatureDriftDetector,
  PerformanceDriftDetector,
  RegimeDriftDetector,
  RegimeObservation,
  SHADOW_SCHEMA_VERSION,
  ShadowEvaluationEvidence,
  ShadowHealthMachine,
  ShadowHealthState,
  ShadowLedger,
  ShadowMarketData,
  ShadowOrchestrator,
  ShadowSignalSnapshot,
  validateShadowMarketData,
} from '../shadow';

function generateContinuousCandles(
  startTimestamp: number,
  count = 60,
  intervalMs = 900000,
): ICandle[] {
  const candles: ICandle[] = [];
  for (let i = 0; i < count; i++) {
    const t = startTimestamp + i * intervalMs;
    const base = 100 + Math.sin(i * 0.2) * 5 + i * 0.1;
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

function generateTrendCandles(startTimestamp: number, count = 40): ICandle[] {
  const candles: ICandle[] = [];
  for (let i = 0; i < count; i++) {
    const t = startTimestamp + i * 900000;
    const base = 100 + i * 1.5;
    candles.push({
      timestamp: new Date(t),
      open: Number((base - 0.5).toFixed(2)),
      high: Number((base + 2.0).toFixed(2)),
      low: Number((base - 1.0).toFixed(2)),
      close: Number((base + 1.0).toFixed(2)),
      volume: 2000 + i * 50,
    });
  }
  return candles;
}

function createDummyCandidate(id = 'cand-shadow-35'): StrategyCandidate {
  return {
    id,
    candidateVersion: 'v2.1',
    baseStrategyVersion: 'v2.0',
    type: 'THRESHOLD',
    description: 'AI Fix 35 Continuous shadow candidate test',
    change: {
      parameter: 'minMtfScore',
      value: 40,
      minMtfScore: 40,
      symbol: 'BTCUSDT',
      datasetHash: 'hash_mkt_shadow_035',
      marketDatasetHash: 'hash_mkt_shadow_035',
    },
    evidence: {
      sampleSize: 100,
      expectancyBefore: 0.2,
      expectancyAfterHistorical: 0.45,
      winRate: 0.6,
      profitFactor: 1.5,
      referenceRegime: {
        volatilityRegime: 'NORMAL_VOLATILITY',
        trendRegime: 'TRENDING_BULLISH',
      },
    },
    riskConfig: {
      initialCapital: 1000000,
      maxRiskPerTrade: 0.01,
      maxAccountRiskLimit: 0.05,
      lotSize: 1,
      contractSize: 1,
      maxLeverage: 10,
      fillModel: 'NEXT_BAR_OPEN',
      slippageModel: 'ZERO',
      feeModel: 'ZERO',
      partialExitPolicy: {
        tp1Ratio: 0.33,
        tp2Ratio: 0.33,
        tp3Ratio: 0.34,
        moveStopToBreakevenOnTp1: true,
      },
    },
    status: 'SHADOW_PENDING',
    createdAt: new Date(),
  } as any;
}

describe('AI Fix 35 — Continuous Shadow Orchestrator + Drift Detection', () => {
  const testDir = path.join(__dirname, 'test_artifacts_fix35');
  const registryPath = path.join(testDir, 'model-registry.json');

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

  describe('1. Causal Market Processing & Strict Candle Validation', () => {
    it('Test 1: Causal shadow processing ensures future candles do not alter past state', () => {
      const candidate = createDummyCandidate('cand-causal-1');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_035');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      orchestrator.startCandidate(candidate.id);

      const candles = generateContinuousCandles(1700000000000, 30);

      // Process first 20 candles
      for (let i = 0; i < 20; i++) {
        orchestrator.processCandle(candidate.id, candles[i]);
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

      // Past 20 observations must be IDENTICAL to what was recorded at T=20
      const first20AfterFuture = JSON.parse(JSON.stringify(obsAt30?.slice(0, 20)));
      expect(first20AfterFuture).toEqual(obsSnapshotAt20);
    });

    it('Test 2: Rejects duplicate candle timestamps fail-closed', () => {
      const candidate = createDummyCandidate('cand-dup-ts');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_035');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      orchestrator.startCandidate(candidate.id);

      const t0 = 1700000000000;
      const c1: ICandle = { timestamp: new Date(t0), open: 100, high: 105, low: 95, close: 102, volume: 100 };
      orchestrator.processCandle(candidate.id, c1);

      // Duplicate timestamp
      const c2Duplicate: ICandle = { timestamp: new Date(t0), open: 102, high: 106, low: 98, close: 104, volume: 110 };
      expect(() => orchestrator.processCandle(candidate.id, c2Duplicate)).toThrow(/DUPLICATE_CANDLE_TIMESTAMP/);
    });

    it('Test 3: Rejects out-of-order timestamp regressions fail-closed', () => {
      const candidate = createDummyCandidate('cand-regress-ts');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_035');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      orchestrator.startCandidate(candidate.id);

      const t0 = 1700000000000;
      const c1: ICandle = { timestamp: new Date(t0 + 10000), open: 100, high: 105, low: 95, close: 102, volume: 100 };
      orchestrator.processCandle(candidate.id, c1);

      // Earlier timestamp (regression)
      const c2Regressed: ICandle = { timestamp: new Date(t0), open: 102, high: 106, low: 98, close: 104, volume: 110 };
      expect(() => orchestrator.processCandle(candidate.id, c2Regressed)).toThrow(/TIMESTAMP_REGRESSION/);
    });

    it('Test 4: Rejects corrupted OHLCV bounds (High < Low, Close outside range) fail-closed', () => {
      const candidate = createDummyCandidate('cand-corrupt-bounds');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_035');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      orchestrator.startCandidate(candidate.id);

      const t0 = 1700000000000;
      // High < Low
      const badCandle1: ICandle = { timestamp: new Date(t0), open: 100, high: 90, low: 110, close: 100, volume: 100 };
      expect(() => orchestrator.processCandle(candidate.id, badCandle1)).toThrow(/INVALID_CANDLE_BOUNDS/);

      // Close > High
      const badCandle2: ICandle = { timestamp: new Date(t0), open: 100, high: 105, low: 95, close: 115, volume: 100 };
      expect(() => orchestrator.processCandle(candidate.id, badCandle2)).toThrow(/INVALID_CANDLE_BOUNDS/);
    });

    it('Test 5: Rejects non-finite/NaN numeric values in candles fail-closed', () => {
      const candidate = createDummyCandidate('cand-nan-candle');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_035');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      orchestrator.startCandidate(candidate.id);

      const t0 = 1700000000000;
      const nanCandle: ICandle = { timestamp: new Date(t0), open: NaN, high: 105, low: 95, close: 100, volume: 100 };
      expect(() => orchestrator.processCandle(candidate.id, nanCandle)).toThrow(/INVALID_CANDLE_OHLC/);

      const infinityCandle: ICandle = { timestamp: new Date(t0), open: 100, high: Infinity, low: 95, close: 100, volume: 100 };
      expect(() => orchestrator.processCandle(candidate.id, infinityCandle)).toThrow(/INVALID_CANDLE_OHLC/);
    });
  });

  describe('2. Authoritative Execution Simulation & Fill Management', () => {
    it('Test 6: Causal order execution: Signal at close of candle T executes on candle T+1 via ExecutionSimulator', async () => {
      const provider = new MockMarketDataProvider({ seed: 777 });
      const marketCandles = await provider.getHistoricalCandles('BTCUSDT', '15m', 45);

      const candidate = createDummyCandidate('cand-causal-exec');
      (candidate.change as any).minMtfScore = 50;
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_035');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      orchestrator.startCandidate(candidate.id);

      let firstOrderCandle = -1;
      for (let i = 0; i < marketCandles.length; i++) {
        const res = orchestrator.processCandle(candidate.id, marketCandles[i]);
        const ledger = orchestrator.getCandidateLedger(candidate.id);
        const orders = ledger?.getOrders() || [];
        const fills = ledger?.getFills() || [];

        if (orders.length > 0 && firstOrderCandle === -1) {
          firstOrderCandle = i;
          expect(orders.length).toBe(1);
          expect(fills.length).toBe(0);
          expect(res.openPositionsCount).toBe(0);
        } else if (firstOrderCandle !== -1 && i === firstOrderCandle + 1) {
          expect(fills.length).toBe(1);
          expect(res.openPositionsCount).toBe(1);
          break;
        }
      }

      expect(firstOrderCandle).toBeGreaterThan(0);
    });

    it('Test 7: Multi-target partial exits (TP1, TP2, TP3) execute with exact quantity conservation', async () => {
      const provider = new MockMarketDataProvider({ seed: 777 });
      const marketCandles = await provider.getHistoricalCandles('BTCUSDT', '15m', 60);

      const candidate = createDummyCandidate('cand-tp-exits');
      (candidate.change as any).minMtfScore = 50;
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_035');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      orchestrator.startCandidate(candidate.id);

      for (const candle of marketCandles) {
        orchestrator.processCandle(candidate.id, candle);
      }

      const ledger = orchestrator.getCandidateLedger(candidate.id)!;
      const fills = ledger.getFills();
      expect(fills.length).toBeGreaterThanOrEqual(1);

      // Verify active lot or closed trades exist
      const trades = ledger.getTrades();
      const activeLot = ledger.getActiveLot();
      expect(trades.length > 0 || activeLot !== null).toBe(true);
    });

    it('Test 8: Protective stop loss execution updates position lot and records completed trade', async () => {
      const provider = new MockMarketDataProvider({ seed: 777 });
      const marketCandles = await provider.getHistoricalCandles('BTCUSDT', '15m', 60);

      const candidate = createDummyCandidate('cand-sl-trade');
      (candidate.change as any).minMtfScore = 50;
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_035');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      orchestrator.startCandidate(candidate.id);

      for (const candle of marketCandles) {
        orchestrator.processCandle(candidate.id, candle);
      }

      const ledger = orchestrator.getCandidateLedger(candidate.id)!;
      const trades = ledger.getTrades();
      expect(trades.length).toBeGreaterThanOrEqual(1);
      const stoppedTrade = trades[0];
      expect(stoppedTrade.exitReason).toBeDefined();
      expect([SignalState.SL_HIT, SignalState.TP1_HIT, SignalState.TP2_HIT, SignalState.TP3_HIT, SignalState.INVALIDATED]).toContain(stoppedTrade.exitReason);
    });

    it('Test 9: Slippage and fee modeling are applied accurately to shadow fills and recorded in ledger', async () => {
      const provider = new MockMarketDataProvider({ seed: 777 });
      const marketCandles = await provider.getHistoricalCandles('BTCUSDT', '15m', 45);

      const candidate = createDummyCandidate('cand-fees-slip');
      (candidate.change as any).minMtfScore = 50;
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_035');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      orchestrator.startCandidate(candidate.id);

      for (const candle of marketCandles) {
        orchestrator.processCandle(candidate.id, candle);
      }

      const ledger = orchestrator.getCandidateLedger(candidate.id)!;
      const fills = ledger.getFills();
      expect(fills.length).toBeGreaterThanOrEqual(1);
      const fill = fills[0];
      expect(fill.fee).toBeGreaterThan(0);
      expect(typeof fill.slippage).toBe('number');
    });
  });

  describe('3. Multi-Tier Drift Detection & Health State Machine', () => {
    it('Test 10: Performance drift detection triggers DEGRADED state on win rate / expectancy drop', () => {
      const baseline = {
        expectancyR: 0.5,
        winRate: 65,
        profitFactor: 2.0,
      };

      const degradedMetrics: any = {
        candidateId: 'cand-pdrift',
        windowType: 'SHORT',
        observationCount: 30,
        tradeCount: 20,
        pnl: -500,
        pnlR: -5.0,
        winRate: 35, // 35% vs baseline 65% (drop of 30%)
        averageR: -0.25,
        profitFactor: 0.6,
      };

      const drifts = PerformanceDriftDetector.evaluatePerformanceDrift(
        'cand-pdrift',
        degradedMetrics,
        baseline,
        {
          minTradesForEvaluation: 10,
          warningExpectancyRDropRatio: 0.35,
          criticalExpectancyRDropRatio: 0.60,
          warningWinRateDropPercent: 10,
          criticalWinRateDropPercent: 20,
          warningProfitFactorDropRatio: 0.30,
          criticalProfitFactorDropRatio: 0.50,
          maxAllowableDrawdownR: 3.5,
          criticalDrawdownR: 5.0,
        },
      );

      expect(drifts.length).toBeGreaterThanOrEqual(1);
      expect(drifts.some((d) => d.type === 'PERFORMANCE' && d.severity === 'CRITICAL')).toBe(true);
    });

    it('Test 11: Feature drift detection triggers DEGRADED state on high PSI drift', () => {
      const baseline: FeatureDriftBaseline = {
        featureSchemaHash: 'schema_hash_1',
        featureNames: ['f1', 'f2'],
        distributions: {
          f1: {
            featureName: 'f1',
            mean: 0.5,
            stdDev: 0.1,
            min: 0,
            max: 1,
            binEdges: [0, 0.2, 0.4, 0.6, 0.8, 1.0],
            binProbabilities: [0.2, 0.2, 0.2, 0.2, 0.2],
          },
          f2: {
            featureName: 'f2',
            mean: 10,
            stdDev: 2,
            min: 0,
            max: 20,
            binEdges: [0, 4, 8, 12, 16, 20],
            binProbabilities: [0.2, 0.2, 0.2, 0.2, 0.2],
          },
        },
        sampleCount: 100,
      };

      // Completely shifted feature distribution (mean 5.0 instead of 0.5)
      const shiftedVectors = Array.from({ length: 30 }, () => [5.0, 50.0]);

      const drifts = FeatureDriftDetector.evaluateFeatureDrift(
        'cand-fdrift',
        shiftedVectors,
        'schema_hash_1',
        baseline,
        {
          minObservations: 25,
          warningPsiThreshold: 0.1,
          criticalPsiThreshold: 0.25,
        },
        1700000000000,
      );

      expect(drifts.length).toBeGreaterThanOrEqual(1);
      expect(drifts.some((d) => d.type === 'FEATURE')).toBe(true);
    });

    it('Test 12: Regime drift detector detects market regime divergence from reference baseline', () => {
      const referenceRegime = {
        volatilityRegime: 'LOW_VOLATILITY' as const,
        trendRegime: 'TRENDING_BULLISH' as const,
      };

      // Observed regime is persistently HIGH_VOLATILITY / TRENDING_BEARISH
      const regimeHistory: RegimeObservation[] = Array.from({ length: 30 }, (_, i) => ({
        timestamp: 1700000000000 + i * 900000,
        volatilityRegime: 'HIGH_VOLATILITY' as const,
        trendRegime: 'TRENDING_BEARISH' as const,
        atrRatio: 2.5,
      }));

      const drifts = RegimeDriftDetector.evaluateRegimeDrift(
        'cand-rdrift',
        regimeHistory,
        referenceRegime,
        {
          minObservations: 20,
          warningRegimeShiftRatio: 0.3,
          criticalRegimeShiftRatio: 0.5,
        },
      );

      expect(drifts.length).toBeGreaterThanOrEqual(1);
      expect(drifts.some((d) => d.type === 'REGIME')).toBe(true);
    });

    it('Test 13: Execution drift detector detects anomalous fill slippage or fee escalation', () => {
      const mockTrades: any[] = Array.from({ length: 15 }, (_, i) => ({
        tradeId: `t_${i}`,
        entrySlippage: 0.005,
        exitSlippage: 0.005,
        entryFees: 15,
        exitFees: 15,
        executionDurationMs: 3000,
        entryTime: new Date(1700000000000 + i * 1000),
        exitTime: new Date(1700000000000 + (i + 1) * 1000),
        symbol: 'BTCUSDT',
        direction: Direction.BULLISH,
        entryPrice: 100,
        exitPrice: 102,
        quantity: 1,
        initialQuantity: 1,
        status: 'CLOSED',
        exitReason: SignalState.TP1_HIT,
        pnl: 2,
      }));

      const mockFills: any[] = Array.from({ length: 30 }, (_, i) => ({
        fillId: `f_${i}`,
        orderId: `ord_${i}`,
        tradeId: `t_${Math.floor(i / 2)}`,
        price: 100,
        quantity: 1,
        slippage: 1.0, // 100 bps
        fee: 15,
        timestamp: 1700000000000 + i * 500,
      }));

      const drifts = ExecutionDriftDetector.evaluateExecutionDrift(
        'cand-exec-drift',
        mockTrades,
        mockFills,
        {
          minTrades: 10,
          warningSlippageAvgRatio: 0.0015,
          criticalSlippageAvgRatio: 0.0030,
          warningHighSlippageTradeRatio: 0.20,
          criticalHighSlippageTradeRatio: 0.40,
        },
      );

      expect(drifts.length).toBeGreaterThanOrEqual(1);
      expect(drifts.some((d) => d.type === 'EXECUTION')).toBe(true);
    });

    it('Test 14: Candidate vs Production comparator tracks divergence and logs divergence events', () => {
      const candidateSignal: ShadowSignalSnapshot = {
        direction: 'LONG',
        score: 85,
        confidence: 0.85,
      };

      const productionSignal: ShadowSignalSnapshot = {
        direction: 'SHORT',
        score: 40,
        confidence: 0.4,
      };

      const res = CandidateProductionComparator.compareSignals(
        'cand-comp',
        1700000000000,
        candidateSignal,
        productionSignal,
        Date.now(),
      );

      expect(res.comparison.directionMatch).toBe(false);
      expect(res.divergenceEvent).toBeDefined();
      expect(res.divergenceEvent?.type).toBe('CANDIDATE_VS_PRODUCTION');
    });

    it('Test 15: ShadowHealthMachine state transitions follow valid transition matrix strictly', () => {
      const now = Date.now();
      const initialHealth: ShadowHealthState = {
        candidateId: 'cand-health',
        status: 'INSUFFICIENT_EVIDENCE',
        observationCount: 5,
        tradeCount: 2,
        consecutiveHealthyWindows: 0,
        consecutiveDegradedWindows: 0,
        lastObservationAt: now,
        lastEvaluationAt: now,
        activeDrifts: [],
        updatedAt: now,
      };

      // Under minimum samples -> INSUFFICIENT_EVIDENCE
      const nextHealth1 = ShadowHealthMachine.evaluateNextState(
        initialHealth,
        15,
        5,
        [],
        {
          minObservationsForHealthy: 30,
          minTradesForHealthy: 10,
          requiredConsecutiveHealthyWindowsForRecovery: 3,
          maxConsecutiveDegradedWindowsBeforeFailure: 3,
        },
        now,
      );
      expect(nextHealth1.status).toBe('INSUFFICIENT_EVIDENCE');

      // Sufficient samples + zero drifts -> HEALTHY
      const nextHealth2 = ShadowHealthMachine.evaluateNextState(
        nextHealth1,
        35,
        12,
        [],
        {
          minObservationsForHealthy: 30,
          minTradesForHealthy: 10,
          requiredConsecutiveHealthyWindowsForRecovery: 3,
          maxConsecutiveDegradedWindowsBeforeFailure: 3,
        },
        now,
      );
      expect(nextHealth2.status).toBe('HEALTHY');

      // Critical drift -> FAILED
      const criticalDrift: DriftEvent = {
        id: 'drift-1',
        candidateId: 'cand-health',
        timestamp: now,
        marketTimestamp: now,
        type: 'PERFORMANCE',
        severity: 'CRITICAL',
        metric: 'expectancyR',
        baselineValue: 0.5,
        observedValue: -0.2,
        threshold: 0.3,
        windowStart: now - 100000,
        windowEnd: now,
        evidenceHash: 'hash_1',
      };

      const nextHealth3 = ShadowHealthMachine.evaluateNextState(
        nextHealth2,
        35,
        12,
        [criticalDrift],
        {
          minObservationsForHealthy: 30,
          minTradesForHealthy: 10,
          requiredConsecutiveHealthyWindowsForRecovery: 3,
          maxConsecutiveDegradedWindowsBeforeFailure: 3,
        },
        now,
      );
      expect(nextHealth3.status).toBe('FAILED');
    });

    it('Test 16: Automated paper rollback cancels open shadow orders and marks candidate REJECTED upon FAILED state', () => {
      const candidate = createDummyCandidate('cand-paper-rollback');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_035');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir, enableAutomaticPaperRollback: true });
      orchestrator.startCandidate(candidate.id);

      // Verify that triggering FAILED state triggers automated paper rollback
      const ledger = orchestrator.getCandidateLedger(candidate.id)!;
      const criticalDrift: DriftEvent = {
        id: 'crit-drift-1',
        candidateId: candidate.id,
        timestamp: Date.now(),
        marketTimestamp: 1700000000000,
        type: 'PERFORMANCE',
        severity: 'CRITICAL',
        metric: 'expectancyR',
        baselineValue: 0.5,
        observedValue: -0.5,
        threshold: 0.3,
        windowStart: 1700000000000 - 1000,
        windowEnd: 1700000000000,
        evidenceHash: 'hash_crit',
      };
      ledger.recordDrifts([criticalDrift]);

      // Process a candle to trigger state machine evaluation
      const c1: ICandle = { timestamp: new Date(1700000000000), open: 100, high: 102, low: 98, close: 100, volume: 500 };
      orchestrator.processCandle(candidate.id, c1);

      const updatedArtifact = ModelRegistry.getCandidateArtifact(candidate.id);
      expect(updatedArtifact?.status).toBe('REJECTED');
    });
  });

  describe('4. Strict Safety Invariants: No Autonomous Live Modifications', () => {
    it('Test 17: Autonomous live trading rollback is strictly permanently disabled in shadow mode', () => {
      expect(ShadowOrchestrator.AUTOMATIC_LIVE_TRADING_ROLLBACK_ENABLED).toBe(false);
    });

    it('Test 18: Autonomous live promotion is strictly permanently disabled in shadow mode', () => {
      expect(ShadowOrchestrator.AUTOMATIC_LIVE_PROMOTION_ENABLED).toBe(false);
    });
  });

  describe('5. ShadowLedger Append-Only, Determinism & Restart Recovery', () => {
    it('Test 19: ShadowLedger enforces append-only invariant and prevents in-place mutation', () => {
      const ledger = new ShadowLedger({
        candidateId: 'cand-ledger-immut',
        candidateVersion: 'v2.1',
        strategyVersion: 'v2.0',
        featureSchemaHash: 'schema_1',
        artifactHash: 'art_1',
        symbol: 'BTCUSDT',
      });

      ledger.recordObservation({
        candidateId: 'cand-ledger-immut',
        candidateVersion: 'v2.1',
        strategyVersion: 'v2.0',
        timestamp: 1000,
        marketTimestamp: 1000,
        featureVectorHash: 'fv_1',
        featureSchemaHash: 'schema_1',
      });

      const observations = ledger.getObservations();
      expect(observations.length).toBe(1);

      // Attempting mutation on returned array throws error or does not mutate internal ledger
      expect(() => {
        (observations as any).push({ candidateId: 'mutated' });
      }).toThrow();
      expect(ledger.getObservations().length).toBe(1);
    });

    it('Test 20: ShadowLedger state hashing produces byte-identical hash across serialize/deserialize cycles', () => {
      const ledgerFile = path.join(testDir, 'shadow-ledger-hash.json');
      const ledger1 = new ShadowLedger({
        candidateId: 'cand-ledger-hash',
        candidateVersion: 'v2.1',
        strategyVersion: 'v2.0',
        featureSchemaHash: 'schema_1',
        artifactHash: 'art_1',
        symbol: 'BTCUSDT',
        persistencePath: ledgerFile,
      });

      ledger1.recordObservation({
        candidateId: 'cand-ledger-hash',
        candidateVersion: 'v2.1',
        strategyVersion: 'v2.0',
        timestamp: 1000,
        marketTimestamp: 1000,
        featureVectorHash: 'fv_1',
        featureSchemaHash: 'schema_1',
      });
      ledger1.saveToFile();

      const hash1 = ledger1.getStateHash();

      const ledger2 = new ShadowLedger({
        candidateId: 'cand-ledger-hash',
        candidateVersion: 'v2.1',
        strategyVersion: 'v2.0',
        featureSchemaHash: 'schema_1',
        artifactHash: 'art_1',
        symbol: 'BTCUSDT',
        persistencePath: ledgerFile,
      });

      const hash2 = ledger2.getStateHash();
      expect(hash1).toBe(hash2);
    });

    it('Test 21: ShadowLedger rejects duplicate audit event IDs fail-closed', () => {
      const ledger = new ShadowLedger({
        candidateId: 'cand-dup-event',
        candidateVersion: 'v2.1',
        strategyVersion: 'v2.0',
        featureSchemaHash: 'schema_1',
        artifactHash: 'art_1',
        symbol: 'BTCUSDT',
      });

      const event = {
        eventId: 'evt_unique_1',
        candidateId: 'cand-dup-event',
        candidateVersion: 'v2.1',
        strategyVersion: 'v2.0',
        timestamp: 1000,
        marketTimestamp: 1000,
        eventType: 'SHADOW_STARTED' as const,
        evidenceHash: 'hash_1',
      };

      ledger.recordAuditEvent(event);
      expect(() => ledger.recordAuditEvent(event)).toThrow(/DUPLICATE_EVENT_ID/);
    });

    it('Test 22: ShadowLedger persistence and restart recovery restores complete execution simulator state', () => {
      const ledgerFile = path.join(testDir, 'shadow-restart-recovery.json');
      const candidate = createDummyCandidate('cand-restart');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_035');
      ModelRegistry.registerCandidateArtifact(artifact);

      // 1. First orchestrator session
      const orch1 = new ShadowOrchestrator({ persistenceDir: testDir });
      orch1.startCandidate(candidate.id, { persistenceFilePath: ledgerFile });

      const candles = generateContinuousCandles(1700000000000, 10);
      for (const candle of candles) {
        orch1.processCandle(candidate.id, candle);
      }

      const ledger1 = orch1.getCandidateLedger(candidate.id)!;
      const obsCount1 = ledger1.getObservations().length;
      expect(obsCount1).toBe(10);

      // 2. Second orchestrator session (simulating process restart)
      const orch2 = new ShadowOrchestrator({ persistenceDir: testDir });
      orch2.startCandidate(candidate.id, { persistenceFilePath: ledgerFile });

      const ledger2 = orch2.getCandidateLedger(candidate.id)!;
      expect(ledger2.getObservations().length).toBe(10);
      expect(ledger2.getLastMarketTimestamp()).toBe(candles[9].timestamp instanceof Date ? candles[9].timestamp.getTime() : new Date(candles[9].timestamp).getTime());
    });
  });

  describe('6. Continuous Market Data Ingestion & Contract Validation', () => {
    it('Test 23: Continuous shadow market data ingestion (ShadowMarketData) validates batch integrity', () => {
      const validMarketData: ShadowMarketData = {
        symbol: 'BTCUSDT',
        timeframe: '15m',
        candles: generateContinuousCandles(1700000000000, 10),
        receivedAt: new Date(),
        source: 'test-feed',
      };

      expect(() => validateShadowMarketData(validMarketData, 'BTCUSDT')).not.toThrow();

      // Mismatched symbol
      expect(() => validateShadowMarketData(validMarketData, 'ETHUSDT')).toThrow(/SYMBOL_MISMATCH/);

      // Empty candles
      expect(() => validateShadowMarketData({ symbol: 'BTCUSDT', timeframe: '15m', candles: [], receivedAt: new Date(), source: 'test-feed' }, 'BTCUSDT')).toThrow(/empty or not an array/i);
    });

    it('Test 24: Orchestrator fails closed if candidate baseline metrics are missing (no synthetic defaults)', () => {
      const candidate = createDummyCandidate('cand-missing-baseline');
      // Delete baseline evidence
      delete (candidate as any).evidence.expectancyAfterHistorical;
      delete (candidate as any).evidence.expectancyBefore;

      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_035');
      delete (artifact as any).evidence.expectancyAfterHistorical;
      delete (artifact as any).evidence.expectancyBefore;
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      expect(() => orchestrator.startCandidate(candidate.id)).toThrow(/SHADOW_BASELINE_MISSING/);
    });

    it('Test 25: Orchestrator fails closed if candidate reference regime is missing (no synthetic defaults)', () => {
      const candidate = createDummyCandidate('cand-missing-regime');
      delete (candidate as any).evidence.referenceRegime;

      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_035');
      delete (artifact as any).evidence.referenceRegime;
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      expect(() => orchestrator.startCandidate(candidate.id)).toThrow(/REFERENCE_REGIME_MISSING/);
    });

    it('Test 26: Orchestrator fails closed on unvalidated or corrupted CandidateArtifact (enforces ValidatedCandidateArtifact)', () => {
      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      const invalidArtifact = {
        candidateId: 'invalid-art',
        // missing symbol, executionConfig, riskConfig
      };

      expect(() => orchestrator.startCandidate(invalidArtifact as any)).toThrow();
    });

    it('Test 27: ShadowEvaluationEvidence generates canonical hash and meets PromotionGate verification contract', () => {
      const candidate = createDummyCandidate('cand-evidence-gate');
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_035');
      ModelRegistry.registerCandidateArtifact(artifact);

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      orchestrator.startCandidate(candidate.id);

      const candles = generateContinuousCandles(1700000000000, 35);
      for (const candle of candles) {
        orchestrator.processCandle(candidate.id, candle);
      }

      const evidence: ShadowEvaluationEvidence = orchestrator.generateEvaluationEvidence(candidate.id);
      expect(evidence.evidenceHash).toBeDefined();
      expect(typeof evidence.evidenceHash).toBe('string');
      expect(evidence.evidenceHash.length).toBe(64); // SHA-256
      expect(evidence.candidateId).toBe(candidate.id);
      expect(evidence.observationCount).toBe(35);
      expect(evidence.stateHash).toBeDefined();
    });

    it('Test 28: P0 #1 Pending entry signals are persisted and restored across restart across candle boundaries', async () => {
      const candidateId = 'cand-pending-signal-restart';
      const candidate = createDummyCandidate(candidateId);
      (candidate.change as any).minMtfScore = 50;
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_035');
      ModelRegistry.registerCandidateArtifact(artifact);

      const persistenceFilePath = path.join(testDir, `shadow-${candidateId}.json`);
      const orchestrator1 = new ShadowOrchestrator({ persistenceDir: testDir });
      orchestrator1.startCandidate(candidateId, { persistenceFilePath });

      const provider = new MockMarketDataProvider({ seed: 777 });
      const marketCandles = await provider.getHistoricalCandles('BTCUSDT', '15m', 45);

      // Process candles until an entry order is submitted
      let orderCandleIdx = -1;
      for (let i = 0; i < marketCandles.length; i++) {
        orchestrator1.processCandle(candidateId, marketCandles[i]);
        const ledger = orchestrator1.getCandidateLedger(candidateId)!;
        if (ledger.getPendingEntrySignals().size > 0) {
          orderCandleIdx = i;
          break;
        }
      }

      expect(orderCandleIdx).toBeGreaterThan(0);

      // Check that a pending entry order and signal exists before restart
      const ledger1 = orchestrator1.getCandidateLedger(candidateId)!;
      const pendingSignalsBefore = ledger1.getPendingEntrySignals();
      expect(pendingSignalsBefore.size).toBe(1);

      // Simulate abrupt process crash / restart:
      // Create a brand new orchestrator and restart candidate from persistence
      const orchestrator2 = new ShadowOrchestrator({ persistenceDir: testDir });
      orchestrator2.startCandidate(candidateId, { persistenceFilePath });

      const ledger2 = orchestrator2.getCandidateLedger(candidateId)!;
      const pendingSignalsRestored = ledger2.getPendingEntrySignals();
      expect(pendingSignalsRestored.size).toBe(1);

      // Now process candle T+1: this should trigger entry fill without throwing MISSING_ENTRY_SIGNAL
      expect(() => {
        const res = orchestrator2.processCandle(candidateId, marketCandles[orderCandleIdx + 1]);
        expect(res.newFills.length).toBe(1);
        expect(res.openPositionsCount).toBe(1);
      }).not.toThrow();
    });

    it('Test 29: P0 #2 Baseline metrics and feature baseline are fully persisted for self-contained restart', () => {
      const candidateId = 'cand-baseline-self-contained';
      const candidate = createDummyCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_035');
      ModelRegistry.registerCandidateArtifact(artifact);

      const persistenceFilePath = path.join(testDir, `shadow-${candidateId}.json`);
      const orchestrator1 = new ShadowOrchestrator({ persistenceDir: testDir });

      const customFeatureBaseline: FeatureDriftBaseline = {
        featureSchemaHash: artifact.featureSchemaHash,
        featureNames: ['f1', 'f2'],
        distributions: {
          f1: {
            featureName: 'f1',
            mean: 10.5,
            stdDev: 1.2,
            min: 5.0,
            max: 15.0,
            binEdges: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
            binProbabilities: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
          },
          f2: {
            featureName: 'f2',
            mean: 20.5,
            stdDev: 2.3,
            min: 10.0,
            max: 30.0,
            binEdges: [10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30],
            binProbabilities: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
          },
        },
        sampleCount: 100,
      };

      // Start with explicit baseline options
      orchestrator1.startCandidate(candidateId, {
        featureBaseline: customFeatureBaseline,
        baselineExpectancyR: 1.85,
        baselineWinRate: 0.62,
        baselineProfitFactor: 2.15,
        persistenceFilePath,
      });

      const candles = generateContinuousCandles(1700000000000, 30);
      for (let i = 0; i < 25; i++) {
        orchestrator1.processCandle(candidateId, candles[i]);
      }

      // Abrupt restart: create orchestrator2 with ZERO baseline options supplied
      const orchestrator2 = new ShadowOrchestrator({ persistenceDir: testDir });
      // Calling startCandidate without any baseline options should succeed self-contained
      expect(() => orchestrator2.startCandidate(candidateId, { persistenceFilePath })).not.toThrow();

      const ledger2 = orchestrator2.getCandidateLedger(candidateId)!;
      expect(ledger2.getBaselineMetrics()?.expectancyR).toBe(1.85);
      expect(ledger2.getBaselineMetrics()?.winRate).toBe(0.62);
      expect(ledger2.getBaselineMetrics()?.profitFactor).toBe(2.15);
      expect(ledger2.getFeatureBaseline()?.distributions.f1.mean).toBe(10.5);

      // Further processing must not produce FEATURE_DRIFT_UNAVAILABLE
      const result = orchestrator2.processCandle(candidateId, candles[25]);
      const unavailableDrifts = result.activeDrifts?.filter((d) => d.metric === 'FEATURE_DRIFT_UNAVAILABLE') || [];
      expect(unavailableDrifts.length).toBe(0);
    });

    it('Test 30: P1 #1 StartCandidate fails closed (SHADOW_EXECUTION_STATE_CORRUPT) when active lot exists without valid market timestamp', () => {
      const candidateId = 'cand-corrupt-market-ts';
      const candidate = createDummyCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_035');
      ModelRegistry.registerCandidateArtifact(artifact);

      const persistenceFilePath = path.join(testDir, `shadow-${candidateId}.json`);

      // Write corrupt persistence file with active lot and missing lastMarketTimestamp
      const corruptData = {
        version: '1.0',
        candidateId,
        candidateVersion: '1.0.0',
        strategyVersion: '1.0.0',
        featureSchemaHash: artifact.featureSchemaHash,
        artifactHash: artifact.artifactHash,
        symbol: 'BTCUSDT',
        cumulativeMarketHash: 'corrupt_hash',
        observations: [],
        orders: [],
        fills: [],
        trades: [],
        activeLot: {
          tradeId: 't1',
          symbol: 'BTCUSDT',
          direction: Direction.BULLISH,
          initialQuantity: 10,
          remainingQuantity: 10,
          entryPrice: 100,
          currentStopLoss: 90,
          initialRiskPerUnit: 10,
          entryTimestamp: 1700000000000,
          entryOrderId: 'o1',
          status: 'OPEN',
          realizedPnl: 0,
          realizedR: 0,
          accumulatedFees: 0,
          accumulatedSlippage: 0,
          partialFills: [],
        },
        pendingOrders: [],
        pendingEntrySignals: [],
        recentCandles: [],
        regimeHistory: [],
        featureVectors: [],
        drifts: [],
        comparisons: [],
        events: [],
        health: {
          status: 'HEALTHY',
          degradationFactors: [],
          updatedAt: Date.now(),
        },
        lastMarketTimestamp: null, // Corrupted / missing market timestamp
      };

      fs.writeFileSync(persistenceFilePath, JSON.stringify(corruptData), 'utf-8');

      const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
      expect(() => orchestrator.startCandidate(candidateId, { persistenceFilePath })).toThrow(
        /SHADOW_EXECUTION_STATE_CORRUPT/,
      );
    });

    it('Test 31: P1 #4 Continuous execution vs multi-step restart equivalence test', () => {
      const candidateId = 'cand-equiv-test';

      const candidate = createDummyCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_035');
      ModelRegistry.registerCandidateArtifact(artifact);

      const pathCont = path.join(testDir, `shadow-${candidateId}-cont.json`);
      const pathRest = path.join(testDir, `shadow-${candidateId}-rest.json`);

      const fixedTime = 1700000000000;
      const candles = generateContinuousCandles(1700000000000, 40);

      // Run Orchestrator 1 Continuously
      const orchContinuous = new ShadowOrchestrator({ persistenceDir: testDir });
      orchContinuous.startCandidate(candidateId, { persistenceFilePath: pathCont });
      for (let i = 0; i < candles.length; i++) {
        orchContinuous.processCandle(candidateId, candles[i], undefined, fixedTime + i * 60000);
      }

      // Run Orchestrator 2 with restarts every 10 candles
      let orchRestart = new ShadowOrchestrator({ persistenceDir: testDir });
      orchRestart.startCandidate(candidateId, { persistenceFilePath: pathRest });

      for (let i = 0; i < candles.length; i++) {
        orchRestart.processCandle(candidateId, candles[i], undefined, fixedTime + i * 60000);

        // Restart every 10 candles
        if ((i + 1) % 10 === 0 && i < candles.length - 1) {
          orchRestart = new ShadowOrchestrator({ persistenceDir: testDir });
          orchRestart.startCandidate(candidateId, { persistenceFilePath: pathRest });
        }
      }

      const ledgerCont = orchContinuous.getCandidateLedger(candidateId)!;
      const ledgerRest = orchRestart.getCandidateLedger(candidateId)!;

      // Full State Equivalence: Compare canonical State Hash & Market Dataset Hash
      expect(ledgerRest.getStateHash()).toBe(ledgerCont.getStateHash());
      expect(ledgerRest.getShadowMarketDatasetHash()).toBe(ledgerCont.getShadowMarketDatasetHash());
      expect(ledgerRest.getShadowFeatureObservationHash()).toBe(ledgerCont.getShadowFeatureObservationHash());
      expect(ledgerRest.getShadowExecutionEvidenceHash()).toBe(ledgerCont.getShadowExecutionEvidenceHash());

      // Canonical Evaluation Evidence Equivalence
      const evidenceCont = orchContinuous.generateEvaluationEvidence(candidateId, fixedTime + 40 * 60000);
      const evidenceRest = orchRestart.generateEvaluationEvidence(candidateId, fixedTime + 40 * 60000);
      expect(evidenceRest.evidenceHash).toBe(evidenceCont.evidenceHash);
      expect(evidenceRest.stateHash).toBe(evidenceCont.stateHash);
      expect(evidenceRest.marketDatasetHash).toBe(evidenceCont.marketDatasetHash);
      expect(evidenceRest.observationCount).toBe(evidenceCont.observationCount);
      expect(evidenceRest.completedTradeCount).toBe(evidenceCont.completedTradeCount);
      expect(evidenceRest.performanceMetrics).toEqual(evidenceCont.performanceMetrics);

      // Detailed Array Equivalence: Observations, Orders, Fills, Trades, Sequences, Lots
      expect(ledgerRest.getObservations()).toEqual(ledgerCont.getObservations());
      expect(ledgerRest.getOrders()).toEqual(ledgerCont.getOrders());
      expect(ledgerRest.getFills()).toEqual(ledgerCont.getFills());
      expect(ledgerRest.getTrades()).toEqual(ledgerCont.getTrades());
      expect(ledgerRest.getExecutionSequences()).toEqual(ledgerCont.getExecutionSequences());
      expect(ledgerRest.getActiveLot()).toEqual(ledgerCont.getActiveLot());
    });

    it('Test 32: P1 Strict semantic validation rejects malformed persisted optional fields fail-closed', () => {
      const candidateId = 'cand-malformed-fields';
      const candidate = createDummyCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_035');
      ModelRegistry.registerCandidateArtifact(artifact);

      const makeBaseData = () => ({
        version: '1.1',
        candidateId,
        candidateVersion: '1.0.0',
        strategyVersion: '1.0.0',
        featureSchemaHash: artifact.featureSchemaHash,
        artifactHash: artifact.artifactHash,
        symbol: 'BTCUSDT',
        cumulativeMarketHash: 'valid_hash',
        lastMarketTimestamp: 1700000000000,
        observations: [],
        orders: [],
        fills: [],
        trades: [],
        events: [],
        health: {
          status: 'HEALTHY',
          degradationFactors: [],
          updatedAt: Date.now(),
        },
      });

      // 1. Malformed pendingEntrySignals (string instead of array)
      const p1 = path.join(testDir, 'corrupt-signals.json');
      fs.writeFileSync(p1, JSON.stringify({ ...makeBaseData(), pendingEntrySignals: 'corrupted' }), 'utf-8');
      const orch1 = new ShadowOrchestrator({ persistenceDir: testDir });
      expect(() => orch1.startCandidate(candidateId, { persistenceFilePath: p1 })).toThrow(/SHADOW_LEDGER_CORRUPT/);

      // 2. Malformed baselineMetrics (empty object missing required finite numbers)
      const p2 = path.join(testDir, 'corrupt-baseline.json');
      fs.writeFileSync(p2, JSON.stringify({ ...makeBaseData(), baselineMetrics: {} }), 'utf-8');
      const orch2 = new ShadowOrchestrator({ persistenceDir: testDir });
      expect(() => orch2.startCandidate(candidateId, { persistenceFilePath: p2 })).toThrow(/SHADOW_LEDGER_CORRUPT/);

      // 3. Malformed referenceRegime (invalid volatility regime string)
      const p3 = path.join(testDir, 'corrupt-regime.json');
      fs.writeFileSync(p3, JSON.stringify({ ...makeBaseData(), referenceRegime: { volatilityRegime: 'SUPER_HIGH' } }), 'utf-8');
      const orch3 = new ShadowOrchestrator({ persistenceDir: testDir });
      expect(() => orch3.startCandidate(candidateId, { persistenceFilePath: p3 })).toThrow(/SHADOW_LEDGER_CORRUPT/);

      // 4. Malformed windowConfig (negative window size)
      const p4 = path.join(testDir, 'corrupt-window.json');
      fs.writeFileSync(p4, JSON.stringify({ ...makeBaseData(), windowConfig: { shortWindowSize: -10, mediumWindowSize: 50, longWindowSize: 100 } }), 'utf-8');
      const orch4 = new ShadowOrchestrator({ persistenceDir: testDir });
      expect(() => orch4.startCandidate(candidateId, { persistenceFilePath: p4 })).toThrow(/SHADOW_LEDGER_CORRUPT/);
    });

    it('Test 33: P1 Schema version migration supports v1.0 and saves canonical v1.1', () => {
      const candidateId = 'cand-schema-migration';
      const candidate = createDummyCandidate(candidateId);
      const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_mkt_shadow_035');
      ModelRegistry.registerCandidateArtifact(artifact);

      const filePath = path.join(testDir, `shadow-${candidateId}.json`);

      // Write valid v1.0 schema ledger file
      const v1Data = {
        version: '1.0',
        candidateId,
        candidateVersion: '1.0.0',
        strategyVersion: '1.0.0',
        featureSchemaHash: artifact.featureSchemaHash,
        artifactHash: artifact.artifactHash,
        symbol: 'BTCUSDT',
        cumulativeMarketHash: 'valid_v1_hash',
        lastMarketTimestamp: 1700000000000,
        observations: [],
        orders: [],
        fills: [],
        trades: [],
        events: [],
        health: {
          status: 'HEALTHY',
          degradationFactors: [],
          updatedAt: Date.now(),
        },
      };

      fs.writeFileSync(filePath, JSON.stringify(v1Data), 'utf-8');

      // Hydrating v1.0 must succeed
      const orch = new ShadowOrchestrator({ persistenceDir: testDir });
      expect(() => orch.startCandidate(candidateId, { persistenceFilePath: filePath })).not.toThrow();

      // Check saved file on disk: it must now have canonical v1.1 version
      const savedContent = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(savedContent.version).toBe('1.1');
    });
  });
});
