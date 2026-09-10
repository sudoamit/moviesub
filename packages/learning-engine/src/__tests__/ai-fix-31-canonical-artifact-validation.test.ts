import * as fs from 'fs';
import * as path from 'path';
import { Direction, ICandle, SignalGrade } from '@quant/shared';
import { ExecutionSimulator } from '@quant/backtesting';
import { SignalGenerator } from '@quant/trading-engine';
import { StrategyCandidate, ValidatedCandidateArtifact } from '../types';
import { CandidateBacktestRunner } from '../candidate-backtest-runner';
import { CandidateArtifactValidator } from '../candidate-artifact-validator';
import { CandidateArtifactBuilder } from '../candidate-artifact-builder';
import { DeterministicTestStrategyAdapter } from '../deterministic-test-adapter';
import { ShadowOrchestrator } from '../shadow/shadow-orchestrator';
import { ModelRegistry } from '../model-registry';
import { PromotionGate } from '../promotion-gate';

function generateCandles(count: number): ICandle[] {
  const candles: ICandle[] = [];
  const baseTs = 1700000000000;
  for (let i = 0; i < count; i++) {
    const t = baseTs + i * 900000;
    const base = 100 + i * 0.5;
    candles.push({
      timestamp: new Date(t),
      open: base,
      high: base + 2,
      low: base - 1,
      close: base + 1,
      volume: 1000,
    });
  }
  return candles;
}

describe('AI Fix 31 — Canonical CandidateArtifactValidator, Builder & ValidatedCandidateArtifact Boundary', () => {
  const testDir = path.join(__dirname, 'test_artifacts_fix31');

  beforeAll(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    ModelRegistry.reset();
    ModelRegistry.setPersistencePath(path.join(testDir, 'registry.json'));
  });

  afterAll(() => {
    ModelRegistry.setPersistencePath(null);
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  const baseValidRiskConfig = {
    initialCapital: 100000,
    maxRiskPerTrade: 0.01,
    partialExitPolicy: {
      tp1Ratio: 0.33,
      tp2Ratio: 0.33,
      tp3Ratio: 0.34,
      moveStopToBreakevenOnTp1: true,
      trailStopOnTp2: true,
      trailStopOffsetR: 1.0,
    },
  };

  const createValidCandidate = (overrides?: Partial<StrategyCandidate>): StrategyCandidate => ({
    id: 'cand_valid_31_001',
    baseStrategyVersion: '1.0.0',
    candidateVersion: 'cand_valid_31_001',
    type: 'THRESHOLD',
    description: 'Valid test candidate for AI Fix 31',
    symbol: 'BTCUSDT',
    riskConfig: baseValidRiskConfig,
    change: {
      minMtfScore: 75,
      datasetHash: 'dataset_hash_valid_31_001',
    },
    evidence: {
      sampleSize: 100,
      expectancyBefore: 0.2,
      expectancyAfterHistorical: 0.4,
    },
    status: 'TRAINED',
    createdAt: new Date(),
    ...overrides,
  });

  describe('P0-1: Canonical CandidateArtifactValidator & ValidatedCandidateArtifact Boundary', () => {
    test('CandidateArtifactBuilder builds an immutable ValidatedCandidateArtifact passing all contract checks', () => {
      const candidate = createValidCandidate();
      const artifact = CandidateArtifactBuilder.build(candidate, {
        datasetHash: 'dataset_hash_valid_31_001',
      });

      expect(artifact._brand).toBe('ValidatedCandidateArtifact');
      expect(artifact.candidateId).toBe('cand_valid_31_001');
      expect(artifact.symbol).toBe('BTCUSDT');
      expect(artifact.executionConfig.minMtfScore).toBe(75);
      expect(artifact.executionConfig.configHash).toBeDefined();
      expect(artifact.riskConfig.initialCapital).toBe(100000);
      expect(artifact.riskConfig.maxRiskPerTrade).toBe(0.01);
      expect(artifact.riskConfig.partialExitPolicy.moveStopToBreakevenOnTp1).toBe(true);
      expect(artifact.artifactHash).toBeDefined();
      expect(Object.isFrozen(artifact)).toBe(true);
      expect(Object.isFrozen(artifact.riskConfig)).toBe(true);
      expect(Object.isFrozen(artifact.executionConfig)).toBe(true);

      // Re-validating succeeds canonically
      const revalidated = CandidateArtifactValidator.validate(artifact);
      expect(revalidated.artifactId).toBe(artifact.artifactId);
    });

    test('Fails closed if candidate identity or version is missing', () => {
      const candidateNoId = createValidCandidate({ id: '' });
      expect(() => CandidateArtifactBuilder.build(candidateNoId)).toThrow(/CANDIDATE_ID_MISSING/);

      const candidateNoVersion = createValidCandidate({ candidateVersion: '' });
      expect(() => CandidateArtifactBuilder.build(candidateNoVersion)).toThrow(/CANDIDATE_VERSION_MISSING/);
    });

    test('Fails closed if authoritative symbol is missing', () => {
      const candidateNoSym = createValidCandidate({ symbol: undefined, change: { minMtfScore: 75, datasetHash: 'd_hash' } });
      delete (candidateNoSym as any).symbol;
      expect(() => CandidateArtifactBuilder.build(candidateNoSym)).toThrow(/CANDIDATE_SYMBOL_MISSING/);
    });

    test('Fails closed if riskConfig is missing, non-positive, or invalid', () => {
      const candidateNoRisk = createValidCandidate({ riskConfig: undefined });
      expect(() => CandidateArtifactBuilder.build(candidateNoRisk)).toThrow(/CANDIDATE_RISK_CONFIG_MISSING/);

      const candidateInvalidCapital = createValidCandidate({
        riskConfig: { ...baseValidRiskConfig, initialCapital: -100 },
      });
      expect(() => CandidateArtifactBuilder.build(candidateInvalidCapital)).toThrow(/initialCapital must be a positive finite number/);

      const candidateInvalidRiskPerTrade = createValidCandidate({
        riskConfig: { ...baseValidRiskConfig, maxRiskPerTrade: 1.5 },
      });
      expect(() => CandidateArtifactBuilder.build(candidateInvalidRiskPerTrade)).toThrow(/maxRiskPerTrade must be a positive number <= 1.0/);

      const candidateInvalidPartialPolicy = createValidCandidate({
        riskConfig: {
          ...baseValidRiskConfig,
          partialExitPolicy: {
            tp1Ratio: 0.8,
            tp2Ratio: 0.8, // sum > 1.0
            tp3Ratio: 0.4,
            moveStopToBreakevenOnTp1: true,
            trailStopOnTp2: true,
            trailStopOffsetR: 1.0,
          },
        },
      });
      expect(() => CandidateArtifactBuilder.build(candidateInvalidPartialPolicy)).toThrow(/partialExitPolicy is invalid/);
    });

    test('Fails closed if artifact has been tampered with (artifactHash mismatch)', () => {
      const candidate = createValidCandidate();
      const validArtifact = CandidateArtifactBuilder.build(candidate, { datasetHash: 'hash_31_tamper' });

      const tampered = {
        ...validArtifact,
        strategyVersion: '9.9.9', // Tampered strategy version
      };

      expect(() => CandidateArtifactValidator.validate(tampered)).toThrow(/ARTIFACT_HASH_MISMATCH/);
    });
  });

  describe('P1-1: Strict minMtfScore Contract', () => {
    test('Fails closed if minMtfScore is missing or undefined', () => {
      const candidateMissingScore = createValidCandidate({
        change: { datasetHash: 'd_hash_001' }, // minMtfScore omitted
      });

      expect(() => CandidateArtifactBuilder.build(candidateMissingScore)).toThrow(/MISSING_MIN_MTF_SCORE/);
      expect(() => CandidateBacktestRunner.createExecutionConfig(candidateMissingScore)).toThrow(/MISSING_MIN_MTF_SCORE/);
    });

    test('Fails closed if minMtfScore is out of range [0, 100] or non-finite', () => {
      const candidateOutOfRangeHigh = createValidCandidate({
        change: { minMtfScore: 120, datasetHash: 'd_hash_001' },
      });
      expect(() => CandidateArtifactBuilder.build(candidateOutOfRangeHigh)).toThrow(/INVALID_MIN_MTF_SCORE/);

      const candidateOutOfRangeLow = createValidCandidate({
        change: { minMtfScore: -5, datasetHash: 'd_hash_001' },
      });
      expect(() => CandidateArtifactBuilder.build(candidateOutOfRangeLow)).toThrow(/INVALID_MIN_MTF_SCORE/);

      const candidateNaN = createValidCandidate({
        change: { minMtfScore: NaN, datasetHash: 'd_hash_001' },
      });
      expect(() => CandidateArtifactBuilder.build(candidateNaN)).toThrow(/MISSING_MIN_MTF_SCORE/);
    });
  });

  describe('P1-2: Deterministic Test Hook Prohibition in Production Artifacts', () => {
    test('CandidateArtifactValidator rejects artifacts containing deterministicSignal or test strategy injection', () => {
      const candidate = createValidCandidate();
      const artifact = CandidateArtifactBuilder.build(candidate, { datasetHash: 'd_hash_hook' });

      const dirtyArtifact = {
        ...artifact,
        strategyConfig: {
          ...artifact.strategyConfig,
          deterministicSignal: { direction: 'BULLISH', score: 85 },
        },
      };

      expect(() => CandidateArtifactValidator.validate(dirtyArtifact)).toThrow(
        /TEST_HOOKS_PROHIBITED_IN_PRODUCTION_ARTIFACT/,
      );
    });

    test('CandidateArtifactBuilder strips any inadvertent test hooks during production artifact construction', () => {
      const candidateWithHooks = createValidCandidate();
      (candidateWithHooks as any).strategyConfig = {
        deterministicSignal: { direction: 'BULLISH', score: 85 },
        deterministicSignals: [{ direction: 'BEARISH', score: 90 }],
        strategy: () => {},
      };

      const cleanArtifact = CandidateArtifactBuilder.build(candidateWithHooks, { datasetHash: 'd_hash_clean' });
      expect((cleanArtifact.strategyConfig as any).deterministicSignal).toBeUndefined();
      expect((cleanArtifact.strategyConfig as any).deterministicSignals).toBeUndefined();
      expect((cleanArtifact.strategyConfig as any).strategy).toBeUndefined();
      expect(CandidateArtifactValidator.validate(cleanArtifact)).toBeDefined();
    });

    test('Deterministic tests execute cleanly through DeterministicTestStrategyAdapter without polluting production artifact contracts', () => {
      const candidate = createValidCandidate();
      const candles = generateCandles(60);

      const result = DeterministicTestStrategyAdapter.runTestFixture(candidate, {
        candles,
        signals: [
          {
            id: 'sig_001',
            direction: 'BULLISH',
            score: 85,
            entryPrice: 105,
            stopLoss: 100,
            tp1: 110,
            tp2: 115,
            tp3: 120,
            timestamp: new Date(1700000000000 + 10 * 900000),
          },
        ],
      });

      expect(result.candidateId).toBe('cand_valid_31_001');
      expect(typeof result.totalTrades).toBe('number');
    });
  });

  describe('P1-3: Elimination of Synthetic Fallback Provenance & Strict Integrity', () => {
    test('CandidateArtifactBuilder fails closed when dataset provenance hash is completely missing', () => {
      const candidateNoDataset = createValidCandidate({
        change: {
          minMtfScore: 75,
        },
      });
      delete (candidateNoDataset.change as any).datasetHash;
      delete (candidateNoDataset.change as any).marketDatasetHash;
      delete (candidateNoDataset.change as any).trainingDatasetHash;
      delete (candidateNoDataset as any).datasetHash;

      expect(() => CandidateArtifactBuilder.build(candidateNoDataset)).toThrow(/DATASET_HASH_MISSING/);
    });

    test('CandidateArtifactValidator strictly rejects placeholder feature hashes (no hash_* bypass)', () => {
      const candidate = createValidCandidate();
      const artifact = CandidateArtifactBuilder.build(candidate, { datasetHash: 'dataset_hash_unified_001' });

      const tampered = {
        ...artifact,
        selectedFeatureHash: 'hash_placeholder_123',
      };

      expect(() => CandidateArtifactValidator.validate(tampered as any)).toThrow(/SELECTED_FEATURE_HASH_MISMATCH/);
    });

    test('CandidateArtifactValidator strictly requires artifactHash and rejects missing or mismatched artifactHash', () => {
      const candidate = createValidCandidate();
      const artifact = CandidateArtifactBuilder.build(candidate, { datasetHash: 'dataset_hash_unified_001' });

      const missingHash = {
        ...artifact,
        artifactHash: undefined,
      };
      expect(() => CandidateArtifactValidator.validate(missingHash as any)).toThrow(/ARTIFACT_HASH_MISSING/);

      const mismatchedHash = {
        ...artifact,
        artifactHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      };
      expect(() => CandidateArtifactValidator.validate(mismatchedHash as any)).toThrow(/ARTIFACT_HASH_MISMATCH/);
    });

    test('CandidateArtifactValidator strictly enforces single canonical symbol authority', () => {
      const candidate = createValidCandidate();
      const artifact = CandidateArtifactBuilder.build(candidate, { datasetHash: 'dataset_hash_unified_001' });

      const mismatchedExecSymbol = {
        ...artifact,
        executionConfig: {
          ...artifact.executionConfig,
          symbol: 'ETHUSDT',
        },
      };
      expect(() => CandidateArtifactValidator.validate(mismatchedExecSymbol as any)).toThrow(/SYMBOL_MISMATCH/);

      const mismatchedStratSymbol = {
        ...artifact,
        strategyConfig: {
          ...artifact.strategyConfig,
          symbol: 'ETHUSDT',
        },
      };
      expect(() => CandidateArtifactValidator.validate(mismatchedStratSymbol as any)).toThrow(/SYMBOL_MISMATCH/);
    });

    test('CandidateArtifactValidator rejects candidates with model/scaler hashes when artifacts are absent', () => {
      const candidate = createValidCandidate();
      const artifact = CandidateArtifactBuilder.build(candidate, { datasetHash: 'dataset_hash_unified_001' });

      const scalerHashWithoutArtifact = {
        ...artifact,
        scalerHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        scalerArtifact: undefined,
      };
      expect(() => CandidateArtifactValidator.validate(scalerHashWithoutArtifact as any)).toThrow(/SCALER_ARTIFACT_MISSING/);

      const modelHashWithoutArtifact = {
        ...artifact,
        modelHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        modelArtifact: undefined,
      };
      expect(() => CandidateArtifactValidator.validate(modelHashWithoutArtifact as any)).toThrow(/MODEL_ARTIFACT_MISSING/);
    });

    test('Production CandidateArtifactValidator unconditionally rejects test hooks in root or strategyConfig', () => {
      const candidate = createValidCandidate();
      const artifact = CandidateArtifactBuilder.build(candidate, { datasetHash: 'dataset_hash_unified_001' });

      const rootHookArtifact = {
        ...artifact,
        deterministicSignal: { direction: 'BUY', score: 90 },
      };
      expect(() => CandidateArtifactValidator.validate(rootHookArtifact as any)).toThrow(/TEST_HOOKS_PROHIBITED_IN_PRODUCTION_ARTIFACT/);

      const stratHookArtifact = {
        ...artifact,
        strategyConfig: {
          ...artifact.strategyConfig,
          deterministicSignal: { direction: 'BUY', score: 90 },
        },
      };
      expect(() => CandidateArtifactValidator.validate(stratHookArtifact as any)).toThrow(/TEST_HOOKS_PROHIBITED_IN_PRODUCTION_ARTIFACT/);
    });
  });

  describe('Integration Across Consumers: Backtest, Shadow, Registry & Promotion', () => {
    test('CandidateBacktestRunner, ShadowOrchestrator, ModelRegistry, and PromotionGate all respect the canonical ValidatedCandidateArtifact', () => {
      const candidate = createValidCandidate({ status: 'SHADOW_ACTIVE' });
      const candles = generateCandles(60);

      // 1. CandidateBacktestRunner builds and runs validated artifact
      const backtestResult = CandidateBacktestRunner.runCandidateBacktest(candidate, {
        candles,
        marketDataset: {
          symbol: 'BTCUSDT',
          timeframe: '15m',
          executionCandles: candles,
          startTimestamp: candles[0].timestamp.getTime(),
          endTimestamp: candles[candles.length - 1].timestamp.getTime(),
          datasetHash: 'dataset_hash_unified_001',
        },
      });
      expect(backtestResult.candidateId).toBe(candidate.id);

      // 2. ModelRegistry registers and retrieves canonical artifact
      const artifact = CandidateArtifactBuilder.build(candidate, { datasetHash: 'dataset_hash_unified_001' });
      ModelRegistry.registerCandidateArtifact(artifact);
      const retrieved = ModelRegistry.getCandidateArtifact(candidate.id);
      expect(retrieved).toBeDefined();
      expect(CandidateArtifactValidator.validate(retrieved)).toBeDefined();

      // 3. PromotionGate evaluates promotion using canonical validated artifact
      const promoDecision = PromotionGate.evaluatePromotion({
        candidateArtifact: retrieved!,
        shadowResult: {
          candidateId: candidate.id,
          passed: true,
          evaluatedAt: Date.now(),
          reasons: ['Passed all metrics'],
          window: {
            candidateId: candidate.id,
            marketDatasetHash: 'dataset_hash_unified_001',
            startTimestamp: Date.now() - 86400000,
            endTimestamp: Date.now(),
            minimumObservations: 50,
            minimumTrades: 30,
          },
          shadowDatasetHash: 'dataset_hash_unified_001',
          shadowStartTimestamp: Date.now() - 86400000,
          shadowEndTimestamp: Date.now(),
          metrics: {
            totalTrades: 35,
            wins: 22,
            losses: 13,
            winRate: 62.8,
            grossPnL: 1200,
            netPnL: 1100,
            pnlR: 12.5,
            profitFactor: 1.85,
            maxDrawdown: 150,
            maxDrawdownR: 1.2,
            expectancy: 0.35,
            averageR: 0.35,
            medianR: 0.3,
            largestLoss: -50,
            largestWin: 120,
            fees: 20,
            slippage: 10,
            observationsCount: 50,
          },
        },
        policy: {
          policyVersion: 'v2.0',
          minimumShadowTrades: 30,
          minimumShadowObservations: 50,
          minimumExpectancyR: 0.2,
          minimumWinRate: 50,
          maximumDrawdownR: 3.0,
          minimumProfitFactor: 1.2,
          requirePositiveNetPnl: true,
          requireIndependentShadowWindow: false,
          allowAutoPromotion: true,
        },
      });
      expect(promoDecision.decision).toBe('PROMOTE');
    });
  });
});
