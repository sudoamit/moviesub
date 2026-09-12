import * as fs from 'fs';
import * as path from 'path';
import { Direction, ICandle, SignalGrade } from '@quant/shared';
import { ExecutionSimulator } from '@quant/backtesting';
import { SignalGenerator } from '@quant/trading-engine';
import { StrategyCandidate } from '../types';
import { CandidateBacktestRunner } from '../candidate-backtest-runner';
import { ShadowOrchestrator } from '../shadow/shadow-orchestrator';
import { ModelRegistry } from '../model-registry';

function generateCandles(count: number = 60): ICandle[] {
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

describe('AI Fix 30 — Risk Configuration Preflight, Authoritative Sequence Validation & minMtfScore Invariant', () => {
  const testDir = path.join(__dirname, 'test_artifacts_fix30');
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

  describe('1. CandidateBacktestRunner Preflight Validation (Strict Fail-Closed)', () => {
    it('rejects candidate with missing riskConfig (CANDIDATE_RISK_CONFIG_MISSING)', () => {
      const candidate: StrategyCandidate = {
        id: 'cand-no-risk',
        candidateVersion: 'v2.1',
        baseStrategyVersion: 'v2.0',
        type: 'THRESHOLD',
        description: 'Candidate without risk config',
        change: { parameter: 'minMtfScore', value: 75, symbol: 'BTCUSDT' },
        executionConfig: {
          fillModel: 'OHLC_PATH',
          ambiguityMode: 'CONSERVATIVE',
          feeModel: 'PERCENTAGE',
          slippageModel: 'FIXED_TICKS',
          latencyMs: 0,
        },
        evidence: { sampleSize: 10, expectancyBefore: 0.2, expectancyAfterHistorical: 0.5 },
        status: 'SHADOW_PENDING',
        createdAt: new Date(),
      } as any;

      const candles = generateCandles(60);
      expect(() => {
        CandidateBacktestRunner.runCandidateBacktest(candidate, { candles });
      }).toThrow(/CANDIDATE_RISK_CONFIG_MISSING/);
    });

    it('rejects candidate with non-positive initialCapital in riskConfig', () => {
      const candidate: StrategyCandidate = {
        id: 'cand-invalid-cap',
        candidateVersion: 'v2.1',
        baseStrategyVersion: 'v2.0',
        type: 'THRESHOLD',
        description: 'Candidate with invalid capital',
        change: {
          parameter: 'minMtfScore',
          value: 75,
          symbol: 'BTCUSDT',
          riskConfig: {
            initialCapital: 0,
            maxRiskPerTrade: 0.01,
            partialExitPolicy: { tp1Ratio: 0.3, tp2Ratio: 0.3, tp3Ratio: 0.4 },
          },
        },
        executionConfig: {
          fillModel: 'OHLC_PATH',
          ambiguityMode: 'CONSERVATIVE',
          feeModel: 'PERCENTAGE',
          slippageModel: 'FIXED_TICKS',
          latencyMs: 0,
        },
        evidence: { sampleSize: 10, expectancyBefore: 0.2, expectancyAfterHistorical: 0.5 },
        status: 'SHADOW_PENDING',
        createdAt: new Date(),
      } as any;

      const candles = generateCandles(60);
      expect(() => {
        CandidateBacktestRunner.runCandidateBacktest(candidate, { candles });
      }).toThrow(/INVALID_CANDIDATE_RISK_CONFIG.*initialCapital/);
    });

    it('rejects candidate with non-positive maxRiskPerTrade in riskConfig', () => {
      const candidate: StrategyCandidate = {
        id: 'cand-invalid-risk',
        candidateVersion: 'v2.1',
        baseStrategyVersion: 'v2.0',
        type: 'THRESHOLD',
        description: 'Candidate with invalid maxRiskPerTrade',
        change: {
          parameter: 'minMtfScore',
          value: 75,
          symbol: 'BTCUSDT',
          riskConfig: {
            initialCapital: 100000,
            maxRiskPerTrade: -0.01,
            partialExitPolicy: { tp1Ratio: 0.3, tp2Ratio: 0.3, tp3Ratio: 0.4 },
          },
        },
        executionConfig: {
          fillModel: 'OHLC_PATH',
          ambiguityMode: 'CONSERVATIVE',
          feeModel: 'PERCENTAGE',
          slippageModel: 'FIXED_TICKS',
          latencyMs: 0,
        },
        evidence: { sampleSize: 10, expectancyBefore: 0.2, expectancyAfterHistorical: 0.5 },
        status: 'SHADOW_PENDING',
        createdAt: new Date(),
      } as any;

      const candles = generateCandles(60);
      expect(() => {
        CandidateBacktestRunner.runCandidateBacktest(candidate, { candles });
      }).toThrow(/INVALID_CANDIDATE_RISK_CONFIG.*maxRiskPerTrade/);
    });

    it('rejects candidate with missing or invalid partialExitPolicy (ratios do not sum to 1)', () => {
      const candidate: StrategyCandidate = {
        id: 'cand-invalid-ratios',
        candidateVersion: 'v2.1',
        baseStrategyVersion: 'v2.0',
        type: 'THRESHOLD',
        description: 'Candidate with non-unity ratios',
        change: {
          parameter: 'minMtfScore',
          value: 75,
          symbol: 'BTCUSDT',
          riskConfig: {
            initialCapital: 100000,
            maxRiskPerTrade: 0.01,
            partialExitPolicy: { tp1Ratio: 0.3, tp2Ratio: 0.3, tp3Ratio: 0.3 }, // sums to 0.9
          },
        },
        executionConfig: {
          fillModel: 'OHLC_PATH',
          ambiguityMode: 'CONSERVATIVE',
          feeModel: 'PERCENTAGE',
          slippageModel: 'FIXED_TICKS',
          latencyMs: 0,
        },
        evidence: { sampleSize: 10, expectancyBefore: 0.2, expectancyAfterHistorical: 0.5 },
        status: 'SHADOW_PENDING',
        createdAt: new Date(),
      } as any;

      const candles = generateCandles(60);
      expect(() => {
        CandidateBacktestRunner.runCandidateBacktest(candidate, { candles });
      }).toThrow(/INVALID_CANDIDATE_RISK_CONFIG.*RATIOS_DO_NOT_SUM_TO_ONE/);
    });
  });

  describe('2. Authoritative minMtfScore Enforcement (Zero Downstream Fallbacks)', () => {
    it('SignalGenerator strictly filters out signals below strategyConfig.minMtfScore without arbitrary fallback', async () => {
      const baseTs = new Date(1700000000000);
      const sampleCandles: ICandle[] = [
        { timestamp: new Date(1700000000000 - 60000), open: 100, high: 101, low: 99, close: 100, volume: 1000 },
        { timestamp: baseTs, open: 100, high: 102, low: 99.5, close: 101.5, volume: 1500 },
      ];

      // 1. With deterministic signal having score 75 and minMtfScore 70, setup passes
      const passingSetup = SignalGenerator.generateSignal({
        symbol: 'BTCUSDT',
        executionCandles: sampleCandles,
        asOfTimestamp: baseTs,
        strategyConfig: {
          minMtfScore: 70,
          deterministicSignal: {
            direction: Direction.BULLISH,
            entryPrice: 101.5,
            stopLoss: 98,
            score: 75,
            timestamp: baseTs,
          },
        },
      });
      expect(passingSetup.direction).toBe(Direction.BULLISH);
      expect(passingSetup.score).toBe(75);

      // 2. With unreachable threshold (minMtfScore = 80), exact same setup is strictly rejected
      const filteredSetup = SignalGenerator.generateSignal({
        symbol: 'BTCUSDT',
        executionCandles: sampleCandles,
        asOfTimestamp: baseTs,
        strategyConfig: {
          minMtfScore: 80,
          deterministicSignal: {
            direction: Direction.BULLISH,
            entryPrice: 101.5,
            stopLoss: 98,
            score: 75,
            timestamp: baseTs,
          },
        },
      });

      expect(filteredSetup.direction).toBe(Direction.NEUTRAL);
      expect(filteredSetup.grade).toBe(SignalGrade.NO_TRADE);
      expect(filteredSetup.reasoning.htfStructure).toMatch(/below configured candidate minMtfScore/);
    });

    it('ShadowOrchestrator throws MISSING_MIN_MTF_SCORE if candidate artifact lacks minMtfScore', () => {
      const candidate: StrategyCandidate = {
        id: 'cand-no-score',
        candidateVersion: 'v2.1',
        baseStrategyVersion: 'v2.0',
        type: 'REGIME',
        description: 'Regime candidate without minMtfScore',
        change: {
          parameter: 'filterRegime',
          value: 'TRENDING_BULLISH',
          symbol: 'BTCUSDT',
        },
        evidence: {
          sampleSize: 50,
          expectancyBefore: 0.2,
          expectancyAfterHistorical: 0.4,
          winRate: 0.6,
          profitFactor: 1.5,
          referenceRegime: { volatilityRegime: 'NORMAL_VOLATILITY', trendRegime: 'TRENDING_BULLISH' },
        },
        riskConfig: {
          initialCapital: 100000,
          maxRiskPerTrade: 0.01,
          partialExitPolicy: { tp1Ratio: 0.3, tp2Ratio: 0.3, tp3Ratio: 0.4 },
        },
        executionConfig: {
          fillModel: 'OHLC_PATH',
          ambiguityMode: 'CONSERVATIVE',
          feeModel: 'PERCENTAGE',
          slippageModel: 'FIXED_TICKS',
          latencyMs: 0,
        },
        status: 'SHADOW_PENDING',
        createdAt: new Date(),
      } as any;

      expect(() => {
        const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_no_score_001');
        ModelRegistry.registerCandidateArtifact(artifact);

        const orchestrator = new ShadowOrchestrator({ persistenceDir: testDir });
        orchestrator.startCandidate(candidate.id);

        const candles = generateCandles(25);
        for (const c of candles) {
          orchestrator.processCandle(candidate.id, c);
        }
      }).toThrow(/MISSING_MIN_MTF_SCORE/);
    });
  });

  describe('3. ExecutionSimulator Authoritative Sequence State Validation', () => {
    it('accepts consistent sequence state (nextOrderSequence === orderCounter + 1)', () => {
      const sim = new ExecutionSimulator();
      expect(() => {
        sim.setExecutionSequences({
          nextOrderSequence: 10,
          orderCounter: 9,
          nextFillSequence: 5,
          fillCounter: 4,
          nextEventSequence: 20,
          eventCounter: 19,
        });
      }).not.toThrow();

      const seqs = sim.getExecutionSequences();
      expect(seqs.nextOrderSequence).toBe(10);
      expect(seqs.nextFillSequence).toBe(5);
      expect(seqs.nextEventSequence).toBe(20);
    });

    it('rejects contradictory order sequences fail-closed (CORRUPT_EXECUTION_SEQUENCE_STATE)', () => {
      const sim = new ExecutionSimulator();
      expect(() => {
        sim.setExecutionSequences({
          nextOrderSequence: 10,
          orderCounter: 5, // Contradicts nextOrderSequence = 10 (expects 9)
        });
      }).toThrow(/CORRUPT_EXECUTION_SEQUENCE_STATE.*Contradictory order sequence state/);
    });

    it('rejects contradictory fill sequences fail-closed (CORRUPT_EXECUTION_SEQUENCE_STATE)', () => {
      const sim = new ExecutionSimulator();
      expect(() => {
        sim.setExecutionSequences({
          nextFillSequence: 8,
          fillCounter: 2, // Contradicts nextFillSequence = 8 (expects 7)
        });
      }).toThrow(/CORRUPT_EXECUTION_SEQUENCE_STATE.*Contradictory fill sequence state/);
    });

    it('rejects contradictory event sequences fail-closed (CORRUPT_EXECUTION_SEQUENCE_STATE)', () => {
      const sim = new ExecutionSimulator();
      expect(() => {
        sim.setExecutionSequences({
          nextEventSequence: 15,
          eventCounter: 3, // Contradicts nextEventSequence = 15 (expects 14)
        });
      }).toThrow(/CORRUPT_EXECUTION_SEQUENCE_STATE.*Contradictory event sequence state/);
    });
  });
});
