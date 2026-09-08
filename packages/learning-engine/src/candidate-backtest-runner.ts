import { createHash } from 'crypto';
import { ICandle, IBacktestTrade } from '@quant/shared';
import { BacktestSimulator, IBacktestOptions } from '@quant/backtesting';
import { CandidateArtifact, StrategyCandidate, TradingExperience } from './types';

export interface CandidateExecutionConfig {
  candidateId: string;
  candidateVersion: string;
  configHash: string;
  minMtfScore?: number;
  stopLossAtrMultiplier?: number;
  enablePartialTp1Trailing?: boolean;
  highVolatilitySizingMultiplier?: number;
  sizingMultiplier?: number;
  filterRegime?: string;
  regimeMode?: 'INCLUDE' | 'EXCLUDE';
  minProbability?: number;
  conditionRules?: string[];
  fittedValue?: number;
}

export interface CandidateExecutionResult {
  candidateId: string;
  totalTrades: number;
  trades: IBacktestTrade[];
  rMultiples: number[];
  netPnL: number;
  grossProfit: number;
  grossLoss: number;
  winRate: number;
  expectancyR: number;
  profitFactor: number;
  maxDrawdownR: number;
}

function deepFreeze<T extends object>(obj: T): Readonly<T> {
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as any)[key];
    if (val !== null && (typeof val === 'object' || typeof val === 'function') && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

export class CandidateBacktestRunner {
  /**
   * Creates an immutable, reproducible CandidateArtifact.
   */
  public static createCandidateArtifact(
    candidate: StrategyCandidate,
    datasetHash: string = 'canonical_default_hash',
  ): CandidateArtifact {
    const config = this.createExecutionConfig(candidate);
    const artifactId = createHash('sha256')
      .update(`${candidate.id}_${candidate.candidateVersion || candidate.id}_${config.configHash}_${datasetHash}`)
      .digest('hex');

    const artifact: CandidateArtifact = {
      artifactId,
      candidateId: candidate.id,
      candidateVersion: candidate.candidateVersion || candidate.id,
      datasetHash,
      strategyVersion: candidate.baseStrategyVersion || '1.0.0',
      strategyConfig: candidate.change || {},
      featureSchemaVersion: candidate.featureSchemaVersion || '2.0',
      selectedFeatures: (candidate.change?.selectedFeatures as string[]) || [],
      modelArtifact: (candidate.change?.modelArtifact as any) || undefined,
      scalerArtifact: (candidate.change?.scalerArtifact as any) || undefined,
      riskConfig: { stopLossAtrMultiplier: config.stopLossAtrMultiplier },
      executionConfig: config as any,
      createdAt: new Date(),
      configHash: config.configHash,
    };
    return deepFreeze(artifact);
  }

  /**
   * Converts a StrategyCandidate into an executable strategy configuration object
   * with a canonical SHA-256 configuration hash.
   */
  public static createExecutionConfig(candidate: StrategyCandidate): CandidateExecutionConfig {
    const change = candidate.change || {};
    const minMtfScore =
      change.parameter === 'minMtfScore'
        ? (typeof change.value === 'number' ? change.value : (change.fittedValue as number))
        : (typeof change.minMtfScore === 'number' ? change.minMtfScore : (change.minScore as number));

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

    const filterRegime = (change.filterRegime as string) || (change.parameter === 'filterRegime' ? (change.value as string) : undefined);
    const regimeMode: 'INCLUDE' | 'EXCLUDE' = (change.regimeMode as 'INCLUDE' | 'EXCLUDE') || (candidate.type === 'REGIME' && change.includeRegime ? 'INCLUDE' : 'EXCLUDE');
    const conditionRules = (change.conditionRules as string[]) || [];

    // Canonical SHA-256 hash over candidate parameters
    const hashPayload = JSON.stringify({
      id: candidate.id,
      candidateVersion: candidate.candidateVersion,
      type: candidate.type,
      baseStrategyVersion: candidate.baseStrategyVersion,
      minMtfScore,
      stopLossAtrMultiplier,
      sizingMultiplier,
      highVolatilitySizingMultiplier,
      filterRegime,
      regimeMode,
      minProbability,
      conditionRules,
      enablePartialTp1Trailing: change.parameter === 'enablePartialTp1Trailing',
      fittedValue: typeof change.fittedValue === 'number' ? change.fittedValue : undefined,
      fittedOnFold: change.fittedOnFold,
      modelArtifactId: (change.modelArtifact as any)?.modelVersion || (change.modelArtifact as any)?.modelId,
      changeValues: Object.keys(change).sort().map(k => [k, change[k]]),
    });
    const configHash = createHash('sha256').update(hashPayload).digest('hex');

    return {
      candidateId: candidate.id,
      candidateVersion: candidate.candidateVersion || candidate.id,
      configHash,
      minMtfScore,
      stopLossAtrMultiplier,
      enablePartialTp1Trailing: change.parameter === 'enablePartialTp1Trailing',
      highVolatilitySizingMultiplier,
      sizingMultiplier,
      filterRegime,
      regimeMode,
      minProbability,
      conditionRules,
      fittedValue: typeof change.fittedValue === 'number' ? change.fittedValue : undefined,
    };
  }

  /**
   * Replays candidate execution strictly through the authoritative BacktestSimulator engine.
   */
  public static runCandidateBacktest(
    candidate: StrategyCandidate,
    experiences: TradingExperience[],
    options?: { candles?: ICandle[] },
  ): CandidateExecutionResult {
    const config = this.createExecutionConfig(candidate);

    // Collect and order market candles from experiences or options
    let candles: ICandle[] = options?.candles || [];
    if (!candles || candles.length === 0) {
      const candleMap = new Map<number, ICandle>();
      for (const exp of experiences) {
        const expCandles = (exp as any).candlesDuringTrade || [];
        for (const c of expCandles) {
          const t = c.timestamp instanceof Date ? c.timestamp.getTime() : new Date(c.timestamp).getTime();
          if (!candleMap.has(t)) {
            candleMap.set(t, c);
          }
        }
      }

      candles = Array.from(candleMap.values()).sort((a, b) => {
        const ta = a.timestamp instanceof Date ? a.timestamp.getTime() : new Date(a.timestamp).getTime();
        const tb = b.timestamp instanceof Date ? b.timestamp.getTime() : new Date(b.timestamp).getTime();
        return ta - tb;
      });
    }

    if (!candles || candles.length === 0) {
      throw new Error('INSUFFICIENT_MARKET_DATA_FOR_CANDIDATE_EXECUTION');
    }

    const backtestOptions: IBacktestOptions = {
      runId: `cand_bt_${candidate.id}`,
      symbol: experiences[0]?.instrument?.symbol || 'BTCUSDT',
      timeframe: (experiences[0] as any)?.timeframe || '15m',
      candles,
      experiences,
      minimumCandles: 1,
      warmupBars: 0,
      minScore: config.minMtfScore,
      stopLossAtrMultiplier: config.stopLossAtrMultiplier,
      sizingMultiplier: config.sizingMultiplier,
      highVolatilitySizingMultiplier: config.highVolatilitySizingMultiplier,
      filterRegime: config.filterRegime,
      regimeMode: config.regimeMode,
      minProbability: config.minProbability,
      conditionRules: config.conditionRules,
      enablePartialTp1Trailing: config.enablePartialTp1Trailing,
    };

    // Invoke authoritative BacktestSimulator engine directly
    const simResult = BacktestSimulator.runSimulation(backtestOptions);
    const trades = simResult.trades || [];
    const rMultiples = trades.map((t) => t.pnlRMultiple || 0);

    return {
      candidateId: candidate.id,
      totalTrades: simResult.totalTrades,
      trades,
      rMultiples,
      netPnL: simResult.netPnL,
      grossProfit: simResult.trades.filter((t) => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0),
      grossLoss: simResult.trades.filter((t) => t.pnl < 0).reduce((sum, t) => sum + Math.abs(t.pnl), 0),
      winRate: simResult.winRate,
      expectancyR: simResult.averageR,
      profitFactor: simResult.profitFactor,
      maxDrawdownR: simResult.maxDrawdownPercent,
    };
  }
}
