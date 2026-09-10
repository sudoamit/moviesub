import { ICandle } from '@quant/shared';
import { BacktestSimulator, IBacktestOptions } from '@quant/backtesting';
import { CandidateExecutionResult, IDeterministicTestFixtureOptions } from './candidate-backtest-runner';
import { CandidateArtifact, StrategyCandidate, TradingExperience } from './types';
import { CandidateArtifactBuilder } from './candidate-artifact-builder';

export class DeterministicTestStrategyAdapter {
  /**
   * Adapts test fixture deterministic signals and experiences for simulation replay.
   * Completely decoupled from production ValidatedCandidateArtifact boundaries.
   */
  public static runTestFixture(
    candidate: StrategyCandidate | CandidateArtifact,
    fixture: IDeterministicTestFixtureOptions,
  ): CandidateExecutionResult {
    const candidateId = 'artifactId' in candidate ? candidate.candidateId : candidate.id;
    const change = (candidate as any).change || {};
    const candles = fixture.candles || [];

    const symbol =
      fixture.experiences?.[0]?.instrument?.symbol ||
      fixture.symbol ||
      (candidate as any).symbol ||
      change.symbol ||
      'BTCUSDT';

    const initialCapital =
      fixture.initialCapital ??
      (candidate as any).riskConfig?.initialCapital ??
      100000;

    const minMtfScore =
      change.parameter === 'minMtfScore'
        ? (typeof change.fittedValue === 'number'
            ? change.fittedValue
            : typeof change.value === 'number'
              ? change.value
              : 0)
        : typeof change.minMtfScore === 'number'
          ? change.minMtfScore
          : typeof change.minScore === 'number'
            ? change.minScore
            : typeof (candidate as any).minMtfScore === 'number'
              ? (candidate as any).minMtfScore
              : typeof (candidate as any).strategyConfig?.minMtfScore === 'number'
                ? (candidate as any).strategyConfig.minMtfScore
                : typeof (candidate as any).executionConfig?.minMtfScore === 'number'
                  ? (candidate as any).executionConfig.minMtfScore
                  : 0;

    const stopLossAtrMultiplier =
      typeof change.stopLossAtrMultiplier === 'number'
        ? change.stopLossAtrMultiplier
        : (change.parameter === 'stopLossAtrMultiplier' ? (change.value as number) : 1.0);

    const sizingMultiplier =
      typeof change.sizingMultiplier === 'number'
        ? change.sizingMultiplier
        : (change.parameter === 'sizingMultiplier' ? (change.value as number) : 1.0);

    const highVolatilitySizingMultiplier =
      typeof change.highVolatilitySizingMultiplier === 'number'
        ? change.highVolatilitySizingMultiplier
        : (change.parameter === 'highVolatilitySizingMultiplier' ? (change.value as number) : undefined);

    const minProbability =
      typeof change.minProbability === 'number'
        ? change.minProbability
        : (change.parameter === 'minProbability' ? (change.value as number) : undefined);

    const filterRegime =
      (change.filterRegime as string) ||
      (change.parameter === 'filterRegime' ? (change.value as string) : undefined);

    const regimeMode =
      (change.regimeMode as 'INCLUDE' | 'EXCLUDE') ||
      ((candidate as any).type === 'REGIME' && change.includeRegime ? 'INCLUDE' : 'EXCLUDE');

    const conditionRules = (change.conditionRules as string[]) || [];

    const modelArtifact =
      (candidate as any).modelArtifact ||
      change.modelArtifact;

    const fixtureSignals =
      fixture.signals ||
      (fixture.experiences && fixture.experiences.length > 0
        ? fixture.experiences
            .filter((e: TradingExperience) => e.execution?.entryPrice)
            .map((e: TradingExperience) => ({
              id: e.id,
              direction: e.decision?.action === 'SELL' ? 'BEARISH' : 'BULLISH',
              score: e.decision?.score ?? 80,
              entryPrice: e.execution?.entryPrice,
              stopLoss: e.risk?.stopLoss,
              tp1: e.risk?.target1,
              tp2: e.risk?.target2,
              tp3: e.risk?.target3,
              reasons: [...(e.reasons || []), ...(e.failureReasons || [])],
              marketContext: e.marketContext,
              features: (e as any).features,
              marketState: e.marketState,
              prediction: e.prediction,
              timestamp: e.timestamp,
            }))
        : ((candidate as any).strategyConfig?.deterministicSignals ||
          ((candidate as any).strategyConfig?.deterministicSignal
            ? [(candidate as any).strategyConfig.deterministicSignal]
            : undefined)));

    const strategyConfig = {
      ...((candidate as any).strategyConfig || {}),
      symbol,
      minMtfScore,
      stopLossAtrMultiplier,
      sizingMultiplier,
      highVolatilitySizingMultiplier,
      minProbability,
      filterRegime,
      regimeMode,
      conditionRules,
      deterministicSignals: fixtureSignals,
      deterministicSignal: fixtureSignals && fixtureSignals.length === 1 ? fixtureSignals[0] : undefined,
    };

    const testArtifact: any =
      'artifactId' in candidate && 'configHash' in candidate
        ? candidate
        : {
            artifactId: `test_artifact_${candidateId}`,
            candidateId,
            symbol,
            strategyConfig,
            executionConfig: {
              symbol,
              minMtfScore,
              stopLossAtrMultiplier,
              sizingMultiplier,
              highVolatilitySizingMultiplier,
              minProbability,
              filterRegime,
              regimeMode,
              conditionRules,
            },
            riskConfig: (candidate as any).riskConfig || {
              initialCapital,
              maxRiskPerTrade: 0.01,
              partialExitPolicy: {
                tp1Ratio: 0.33,
                tp2Ratio: 0.33,
                tp3Ratio: 0.34,
                moveStopToBreakevenOnTp1: true,
                trailStopOnTp2: true,
                trailStopOffsetR: 1.0,
              },
            },
          };

    const simOptions: IBacktestOptions = {
      runId: `test_det_${candidateId}_${Date.now()}`,
      symbol,
      timeframe: (fixture.experiences?.[0] as any)?.timeframe || fixture.timeframe || '15m',
      candles,
      experiences: fixture.experiences,
      initialCapital,
      candidateArtifact: testArtifact,
      minScore: minMtfScore,
      stopLossAtrMultiplier,
      sizingMultiplier,
      highVolatilitySizingMultiplier,
      minProbability,
      filterRegime,
      regimeMode,
      conditionRules,
      enablePartialTp1Trailing: change.parameter === 'enablePartialTp1Trailing',
      minimumCandles: fixture.minimumCandles ?? 1,
      warmupBars: fixture.warmupBars ?? 0,
      modelArtifact: modelArtifact
        ? {
            weights: modelArtifact.weights || [],
            bias: modelArtifact.bias ?? 0,
            modelVersion: modelArtifact.modelVersion,
          }
        : undefined,
      strategyConfig,
    };

    const simRes = BacktestSimulator.runSimulation(simOptions);
    const trades = simRes.trades || [];
    const rMultiples = trades.map((t) => t.pnlRMultiple || 0);

    return {
      candidateId,
      totalTrades: simRes.totalTrades,
      trades,
      rMultiples,
      netPnL: simRes.netPnL,
      grossProfit: trades.filter((t) => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0),
      grossLoss: trades.filter((t) => t.pnl < 0).reduce((sum, t) => sum + Math.abs(t.pnl), 0),
      winRate: simRes.winRate,
      expectancyR: simRes.averageR,
      profitFactor: simRes.profitFactor,
      maxDrawdownR: simRes.maxDrawdownPercent,
    };
  }

  /**
   * Builds an artifact specifically for unit test fixtures that require deterministic signals.
   * Isolates test-only deterministic hooks from the production artifact creation path.
   */
  public static createTestArtifact(
    candidate: StrategyCandidate,
    datasetHash: string = 'hash_test_dataset',
  ): CandidateArtifact {
    const raw = CandidateArtifactBuilder.build(candidate, { datasetHash });
    const rawMutable = JSON.parse(JSON.stringify(raw));
    const detSignal = (candidate as any).strategyConfig?.deterministicSignal || (candidate as any).deterministicSignal;
    const detSignals = (candidate as any).strategyConfig?.deterministicSignals || (candidate as any).deterministicSignals;
    const strategy = (candidate as any).strategyConfig?.strategy || (candidate as any).strategy;

    if (detSignal) {
      rawMutable.strategyConfig.deterministicSignal = detSignal;
    }
    if (detSignals) {
      rawMutable.strategyConfig.deterministicSignals = detSignals;
    }
    if (strategy) {
      rawMutable.strategyConfig.strategy = strategy;
    }

    Object.freeze(rawMutable);
    Object.freeze(rawMutable.strategyConfig);
    return rawMutable as CandidateArtifact;
  }
}
