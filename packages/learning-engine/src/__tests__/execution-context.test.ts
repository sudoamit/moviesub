import { CandidateArtifactBuilder } from '../candidate-artifact-builder';
import { CandidateArtifactValidator } from '../candidate-artifact-validator';
import {
  assertCompatibleExecutionContexts,
  createExecutionContext,
} from '../execution-context';
import { ModelRegistry } from '../model-registry';
import { StrategyCandidate } from '../types';

const riskConfig = {
  initialCapital: 100000,
  maxRiskPerTrade: 0.01,
  lotSize: 1,
  contractSize: 1,
  partialExitPolicy: {
    tp1Ratio: 0.33,
    tp2Ratio: 0.33,
    tp3Ratio: 0.34,
    moveStopToBreakevenOnTp1: true,
    trailStopOnTp2: true,
    trailStopOffsetR: 1,
  },
};

const candidate: StrategyCandidate = {
  id: 'context-candidate',
  baseStrategyVersion: 'v2',
  candidateVersion: 'v2-context',
  type: 'THRESHOLD',
  description: 'Context contract fixture',
  symbol: 'TEST',
  riskConfig,
  change: {
    symbol: 'TEST',
    fillModel: 'OHLC_PATH',
    ambiguityMode: 'CONSERVATIVE',
    latencyMs: 10,
    minMtfScore: 50,
    stopLossAtrMultiplier: 1.5,
    sizingMultiplier: 1,
  },
  evidence: { sampleSize: 10, expectancyBefore: 0, expectancyAfterHistorical: 1 },
  status: 'TRAINED',
  createdAt: new Date(0),
};

function context(overrides: Record<string, unknown> = {}) {
  return createExecutionContext({
    symbol: 'TEST',
    timeframe: '1h',
    minimumCandles: 50,
    warmupBars: 40,
    fillModel: 'OHLC_PATH',
    ambiguityMode: 'CONSERVATIVE',
    latencyConfig: { submissionLatencyMs: 10, processingLatencyMs: 5 },
    riskConfig,
    sizingConfig: { lotSize: 1, sizingMultiplier: 1 },
    strategyVersion: 'v2',
    executionVersion: 'v2.0',
    ...overrides,
  });
}

describe('Production execution context', () => {
  afterEach(() => {
    ModelRegistry.reset();
    ModelRegistry.setPersistencePath(null);
  });

  it('is immutable, versioned, and hashes every production semantic', () => {
    const base = context();
    expect(Object.isFrozen(base)).toBe(true);
    expect(base.executionContextVersion).toBe('1.0');
    expect(base.productionEligible).toBe(true);

    for (const change of [
      { symbol: 'OTHER' },
      { timeframe: '15m' },
      { minimumCandles: 51 },
      { warmupBars: 41 },
      { fillModel: 'NEXT_BAR_MARKET' },
      { ambiguityMode: 'OPTIMISTIC' },
      { latencyConfig: { submissionLatencyMs: 11, processingLatencyMs: 5 } },
      { riskConfig: { ...riskConfig, maxRiskPerTrade: 0.02 } },
      { sizingConfig: { lotSize: 2, sizingMultiplier: 1 } },
    ]) {
      expect(context(change).executionContextHash).not.toBe(base.executionContextHash);
    }
  });

  it('marks experimental artifacts ineligible and rejects registration', () => {
    const experimental = CandidateArtifactBuilder.build(candidate, {
      datasetHash: 'context-dataset',
      executionContext: 'EXPERIMENTAL',
      productionExecutionContext: context(),
    });

    expect(experimental.productionEligible).toBe(false);
    expect(() => CandidateArtifactValidator.validate(experimental)).not.toThrow();
    expect(() => ModelRegistry.registerCandidateArtifact(experimental)).toThrow(
      'EXPERIMENTAL_ARTIFACT_NOT_PRODUCTION_ELIGIBLE',
    );
  });

  it('fails closed when champion and challenger contexts differ', () => {
    expect(() => assertCompatibleExecutionContexts(context(), context({ timeframe: '15m' }))).toThrow(
      'INCOMPATIBLE_EXECUTION_CONTEXT',
    );
    expect(() => assertCompatibleExecutionContexts(context(), context({ timeframe: '15m' }), true)).not.toThrow();
  });
});