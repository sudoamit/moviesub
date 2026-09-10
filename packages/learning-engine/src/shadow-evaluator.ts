import {
  CandidateMarketDataset,
  ShadowEvaluationMetrics,
  ShadowEvaluationResult,
  ShadowEvaluationWindow,
  StrategyCandidate,
} from './types';
import { CandidateBacktestRunner } from './candidate-backtest-runner';
import { MarketDatasetValidator } from './market-dataset-validator';
import { sliceContinuousMarketWindow } from './walk-forward-validator';

export interface IEvaluateShadowOptions {
  shadowWindow: ShadowEvaluationWindow;
  marketDataset: CandidateMarketDataset;
  oosEndTimestamp?: number;
  warmupBars?: number;
}

export class ShadowEvaluator {
  /**
   * Evaluates a StrategyCandidate strictly on an independent, non-overlapping shadow market dataset window.
   * Fails closed without synthetic fallbacks.
   */
  public static evaluateShadowWindow(
    candidate: StrategyCandidate,
    options: IEvaluateShadowOptions,
  ): ShadowEvaluationResult {
    const { shadowWindow, marketDataset, oosEndTimestamp } = options;
    const evaluatedAt = Date.now();
    const reasons: string[] = [];

    // 1. Strict Input Validation
    if (!shadowWindow || typeof shadowWindow !== 'object') {
      throw new Error('INVALID_SHADOW_WINDOW: shadowWindow is required');
    }
    if (!marketDataset || !Array.isArray(marketDataset.executionCandles)) {
      throw new Error('INVALID_MARKET_DATASET: continuous executionCandles are required');
    }
    if (shadowWindow.startTimestamp >= shadowWindow.endTimestamp) {
      throw new Error(
        `INVALID_SHADOW_WINDOW_TIMESTAMPS: startTimestamp (${shadowWindow.startTimestamp}) must be < endTimestamp (${shadowWindow.endTimestamp})`,
      );
    }

    // 2. Strict Temporal Non-Overlap Boundary with OOS / Training Timeline
    if (oosEndTimestamp !== undefined && shadowWindow.startTimestamp <= oosEndTimestamp) {
      const reason = `SHADOW_WINDOW_OVERLAP: Shadow window start (${shadowWindow.startTimestamp}) overlaps with prior evaluation window end (${oosEndTimestamp}). Shadow data must be strictly forward in time.`;
      return {
        candidateId: candidate.id,
        passed: false,
        reasons: [],
        rejectionReason: reason,
        window: shadowWindow,
        shadowDatasetHash: marketDataset.datasetHash,
        shadowStartTimestamp: shadowWindow.startTimestamp,
        shadowEndTimestamp: shadowWindow.endTimestamp,
        evaluatedAt,
        metrics: this.createEmptyMetrics(0),
      };
    }

    // 3. Authoritative Market Continuity Validation
    const candles = marketDataset.executionCandles;
    if (candles.length === 0) {
      throw new Error('EMPTY_MARKET_DATA: Market dataset contains no candles for shadow evaluation');
    }
    MarketDatasetValidator.validateCandles(candles, marketDataset.timeframe);

    // 4. Slicing Shadow Market Execution Window
    const warmupBars = options.warmupBars ?? 40;
    let slicedWindow;
    try {
      slicedWindow = sliceContinuousMarketWindow(
        candles,
        shadowWindow.startTimestamp,
        shadowWindow.endTimestamp,
        warmupBars,
      );
    } catch (err: any) {
      return {
        candidateId: candidate.id,
        passed: false,
        reasons: [],
        rejectionReason: `SHADOW_MARKET_SLICING_FAILED: ${err.message}`,
        window: shadowWindow,
        shadowDatasetHash: marketDataset.datasetHash,
        shadowStartTimestamp: shadowWindow.startTimestamp,
        shadowEndTimestamp: shadowWindow.endTimestamp,
        evaluatedAt,
        metrics: this.createEmptyMetrics(0),
      };
    }

    const shadowCandles = slicedWindow.allCandles;
    const evaluationCandles = slicedWindow.evaluationCandles;
    const observationsCount = evaluationCandles.length;

    const symbol = marketDataset.symbol || candidate.symbol || (candidate.executionConfig as any)?.symbol;
    if (!symbol || typeof symbol !== 'string' || symbol.trim() === '') {
      throw new Error(`MISSING_SYMBOL: Candidate '${candidate.id}' is missing authoritative trading symbol in shadow evaluation`);
    }

    // Sliced candidate dataset for backtesting
    const shadowDataset: CandidateMarketDataset = {
      executionCandles: shadowCandles,
      datasetHash: marketDataset.datasetHash,
      timeframe: marketDataset.timeframe || '15m',
      symbol,
      startTimestamp: slicedWindow.warmupStartTimestamp,
      endTimestamp: slicedWindow.evaluationEndTimestamp,
      isContinuous: true,
      expectedIntervalMs: marketDataset.expectedIntervalMs,
    };

    // 5. Authoritative Execution Simulation Replay (Zero Synthetic PnL)
    const backtestRes = CandidateBacktestRunner.runCandidateBacktest(candidate, {
      marketDataset: shadowDataset,
      candles: shadowCandles,
      evaluationStartTimestamp: slicedWindow.evaluationStartTimestamp,
      evaluationEndTimestamp: slicedWindow.evaluationEndTimestamp,
    });

    const trades = backtestRes.trades || [];
    const totalTrades = trades.length;
    const wins = trades.filter((t) => t.pnl > 0).length;
    const losses = trades.filter((t) => t.pnl < 0).length;
    const winRate = totalTrades > 0 ? Number(((wins / totalTrades) * 100).toFixed(1)) : 0;
    const grossPnL = Number(trades.filter((t) => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0).toFixed(2));
    const netPnL = Number(backtestRes.netPnL.toFixed(2));
    const rMultiples = [...(backtestRes.rMultiples || [])].sort((a, b) => a - b);
    const pnlR = Number(rMultiples.reduce((sum, r) => sum + r, 0).toFixed(2));
    const profitFactor = Number(backtestRes.profitFactor.toFixed(2));
    const maxDrawdownR = Number(backtestRes.maxDrawdownR.toFixed(2));
    const maxDrawdown = maxDrawdownR;
    const expectancy = Number(backtestRes.expectancyR.toFixed(2));
    const averageR = totalTrades > 0 ? Number((pnlR / totalTrades).toFixed(2)) : 0;

    const medianR =
      rMultiples.length > 0
        ? rMultiples.length % 2 === 1
          ? rMultiples[Math.floor(rMultiples.length / 2)]
          : Number(((rMultiples[rMultiples.length / 2 - 1] + rMultiples[rMultiples.length / 2]) / 2).toFixed(2))
        : 0;

    const largestLoss = trades.length > 0 ? Number(Math.min(...trades.map((t) => t.pnl)).toFixed(2)) : 0;
    const largestWin = trades.length > 0 ? Number(Math.max(...trades.map((t) => t.pnl)).toFixed(2)) : 0;
    const totalFees = trades.reduce((sum, t) => sum + (t.entryFees || 0) + (t.exitFees || 0), 0);
    const totalSlippage = trades.reduce((sum, t) => sum + (t.entrySlippage || 0) + (t.exitSlippage || 0), 0);

    const metrics: ShadowEvaluationMetrics = {
      totalTrades,
      wins,
      losses,
      winRate,
      grossPnL,
      netPnL,
      pnlR,
      profitFactor,
      maxDrawdown,
      maxDrawdownR,
      expectancy,
      averageR,
      medianR,
      largestLoss,
      largestWin,
      fees: Number(totalFees.toFixed(2)),
      slippage: Number(totalSlippage.toFixed(2)),
      observationsCount,
    };

    // 6. Minimum Observations & Trades Invariants
    const minObs = shadowWindow.minimumObservations ?? 20;
    const minTrades = shadowWindow.minimumTrades ?? 5;

    if (observationsCount < minObs) {
      return {
        candidateId: candidate.id,
        passed: false,
        reasons: [],
        rejectionReason: `INSUFFICIENT_SHADOW_OBSERVATIONS: Shadow window contained ${observationsCount} observations < required ${minObs}`,
        window: shadowWindow,
        shadowDatasetHash: marketDataset.datasetHash,
        shadowStartTimestamp: shadowWindow.startTimestamp,
        shadowEndTimestamp: shadowWindow.endTimestamp,
        evaluatedAt,
        metrics,
      };
    }

    if (totalTrades < minTrades) {
      return {
        candidateId: candidate.id,
        passed: false,
        reasons: [],
        rejectionReason: `INSUFFICIENT_SHADOW_TRADES: Shadow window produced ${totalTrades} trades < required ${minTrades}`,
        window: shadowWindow,
        shadowDatasetHash: marketDataset.datasetHash,
        shadowStartTimestamp: shadowWindow.startTimestamp,
        shadowEndTimestamp: shadowWindow.endTimestamp,
        evaluatedAt,
        metrics,
      };
    }

    reasons.push(
      `Validated independent shadow observation window (${observationsCount} observations, ${totalTrades} execution trades).`,
    );
    reasons.push(`Shadow expectancy: +${expectancy}R, Win Rate: ${winRate}%, Profit Factor: ${profitFactor}.`);

    return {
      candidateId: candidate.id,
      passed: true,
      metrics,
      reasons,
      window: shadowWindow,
      shadowDatasetHash: marketDataset.datasetHash,
      shadowStartTimestamp: shadowWindow.startTimestamp,
      shadowEndTimestamp: shadowWindow.endTimestamp,
      evaluatedAt,
    };
  }

  private static createEmptyMetrics(observationsCount: number): ShadowEvaluationMetrics {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      grossPnL: 0,
      netPnL: 0,
      pnlR: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      maxDrawdownR: 0,
      expectancy: 0,
      averageR: 0,
      medianR: 0,
      largestLoss: 0,
      largestWin: 0,
      fees: 0,
      slippage: 0,
      observationsCount,
    };
  }
}
