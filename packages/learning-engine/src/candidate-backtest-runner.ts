import { ICandle, IBacktestTrade, Direction, SignalState, SignalGrade } from '@quant/shared';
import {
  ExecutionSimulator,
  FillModel,
  SameCandleAmbiguityMode,
  IOrder,
} from '@quant/backtesting';
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

export class CandidateBacktestRunner {
  /**
   * Creates an immutable, reproducible CandidateArtifact.
   */
  public static createCandidateArtifact(
    candidate: StrategyCandidate,
    datasetHash: string = 'canonical_default_hash',
  ): CandidateArtifact {
    const config = this.createExecutionConfig(candidate);
    const artifact: CandidateArtifact = {
      candidateId: candidate.id,
      candidateVersion: candidate.candidateVersion || candidate.id,
      datasetHash,
      strategyVersion: candidate.baseStrategyVersion || '1.0.0',
      strategyConfig: candidate.change || {},
      featureSchemaVersion: '1.0.0',
      selectedFeatures: [],
      riskConfig: { stopLossAtrMultiplier: config.stopLossAtrMultiplier },
      executionConfig: config as any,
      createdAt: new Date(),
      configHash: config.configHash,
    };
    return Object.freeze(artifact);
  }
  /**
   * Converts a StrategyCandidate into an executable strategy configuration object.
   */
  public static createExecutionConfig(candidate: StrategyCandidate): CandidateExecutionConfig {
    const change = candidate.change || {};
    const minMtfScore =
      change.parameter === 'minMtfScore'
        ? (typeof change.value === 'number' ? change.value : (change.fittedValue as number))
        : (change.minScore as number);

    const stopLossAtrMultiplier =
      change.parameter === 'stopLossAtrMultiplier' ? (change.value as number) : 1.0;

    const sizingMultiplier =
      change.parameter === 'sizingMultiplier'
        ? (change.value as number)
        : (change.sizingMultiplier as number) || 1.0;

    const highVolatilitySizingMultiplier =
      (change.highVolatilitySizingMultiplier as number) ||
      (change.parameter === 'highVolatilitySizingMultiplier' ? (change.value as number) : undefined);

    const minProbability =
      (change.minProbability as number) ||
      (change.parameter === 'minProbability' ? (change.value as number) : undefined);

    const filterRegime = (change.filterRegime as string) || (change.parameter === 'filterRegime' ? (change.value as string) : undefined);
    const conditionRules = (change.conditionRules as string[]) || [];

    const configHash = `cfg_${candidate.id}_${minMtfScore ?? 0}_${stopLossAtrMultiplier}_${sizingMultiplier}`;

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
      minProbability,
      conditionRules,
      fittedValue: typeof change.fittedValue === 'number' ? change.fittedValue : undefined,
    };
  }

  /**
   * Replays trading experiences through the authoritative ExecutionSimulator from @quant/backtesting.
   */
  public static runCandidateBacktest(
    candidate: StrategyCandidate,
    experiences: TradingExperience[],
  ): CandidateExecutionResult {
    const config = this.createExecutionConfig(candidate);

    const executedTrades: IBacktestTrade[] = [];
    const rMultiples: number[] = [];

    for (let idx = 0; idx < experiences.length; idx++) {
      const exp = experiences[idx];

      // 1. FILTER candidate checks
      if (candidate.type === 'FILTER') {
        if (config.conditionRules?.includes('HTF_CONFLICT') && exp.failureReasons?.includes('HTF_CONFLICT')) {
          continue;
        }
        if (config.conditionRules?.includes('HIGH_VOLATILITY') && exp.marketContext?.regime === 'HIGH_VOLATILITY') {
          continue;
        }
        if (config.minMtfScore !== undefined && (exp.decision?.score || 0) < config.minMtfScore) {
          continue;
        }
      }

      // 2. THRESHOLD candidate checks
      if (candidate.type === 'THRESHOLD') {
        if (config.minMtfScore !== undefined && (exp.decision?.score || 0) < config.minMtfScore) {
          continue;
        }
      }

      // 3. REGIME candidate checks
      if (candidate.type === 'REGIME' && config.filterRegime) {
        if (exp.marketContext?.regime === config.filterRegime) {
          continue;
        }
      }

      // 4. MODEL / FEATURE candidate checks
      if ((candidate.type === 'MODEL' || candidate.type === 'FEATURE') && config.minProbability !== undefined) {
        if (exp.prediction?.probabilityWin !== undefined && exp.prediction.probabilityWin < config.minProbability) {
          continue;
        }
      }

      // Determine sizing multiplier
      let currentSizing = config.sizingMultiplier || 1.0;
      if (
        (exp.marketContext?.regime === 'HIGH_VOLATILITY' || exp.marketContext?.volatilityRegime === 'HIGH') &&
        config.highVolatilitySizingMultiplier !== undefined
      ) {
        currentSizing = config.highVolatilitySizingMultiplier;
      }

      // Extract entry & risk parameters
      const entryPrice = exp.execution?.entryPrice || 100;
      const initialStop = exp.risk?.stopLoss || entryPrice * 0.99;
      const isLong = exp.decision?.action === 'BUY' || entryPrice > initialStop;
      const originalRiskDist = Math.abs(entryPrice - initialStop);

      // Adjust stop distance if candidate alters stopLossAtrMultiplier
      const stopDist = originalRiskDist * (config.stopLossAtrMultiplier || 1.0);
      const stopPrice = isLong ? entryPrice - stopDist : entryPrice + stopDist;
      const target1 = exp.risk?.target1 || (isLong ? entryPrice + 1.5 * stopDist : entryPrice - 1.5 * stopDist);

      const candles = ((exp as any).candlesDuringTrade as ICandle[]) || [];
      if (!candles || candles.length === 0) {
        throw new Error('INSUFFICIENT_MARKET_DATA_FOR_CANDIDATE_EXECUTION');
      }

      const entryTime = exp.labelStartTimestamp || (exp.execution?.entryTime ? new Date(exp.execution.entryTime).getTime() : new Date(exp.timestamp).getTime());

      if (stopDist > 0) {
        const execSim = new ExecutionSimulator(
          FillModel.OHLC_PATH,
          SameCandleAmbiguityMode.OHLC_PATH,
          { submissionLatencyMs: 15, processingLatencyMs: 5 },
          `cand_${candidate.id}_${exp.id}`,
        );

        // 1. Submit Entry Market Order
        execSim.submitOrder({
          tradeId: exp.id,
          symbol: exp.instrument?.symbol || 'BTCUSDT',
          side: isLong ? 'BUY' : 'SELL',
          orderType: 'MARKET',
          quantity: currentSizing,
          timestamp: entryTime,
          exitTarget: 'ENTRY',
        });

        // 2. Submit Protective Stop Order
        execSim.submitOrder({
          tradeId: exp.id,
          symbol: exp.instrument?.symbol || 'BTCUSDT',
          side: isLong ? 'SELL' : 'BUY',
          orderType: 'STOP',
          stopPrice,
          quantity: currentSizing,
          timestamp: entryTime,
          exitTarget: 'SL',
        });

        // 3. Submit Take Profit Limit Order
        execSim.submitOrder({
          tradeId: exp.id,
          symbol: exp.instrument?.symbol || 'BTCUSDT',
          side: isLong ? 'SELL' : 'BUY',
          orderType: 'LIMIT',
          price: target1,
          quantity: currentSizing,
          timestamp: entryTime,
          exitTarget: 'TP1',
        });

        // Process candles bar-by-bar through authoritative ExecutionSimulator
        for (let cIdx = 0; cIdx < candles.length; cIdx++) {
          const bar = candles[cIdx];
          const nextBar = cIdx < candles.length - 1 ? candles[cIdx + 1] : undefined;
          execSim.processCandle(bar, nextBar);
        }

        // Extract fills from ExecutionSimulator
        const allFills = execSim.getAllFills();
        const entryFill = allFills.find((f) => f.exitTarget === 'ENTRY');
        let exitFill = allFills.find(
          (f) => f.exitTarget === 'SL' || f.exitTarget === 'TP1' || f.exitTarget === 'TRAILING_STOP',
        );

        // Market exit at end of window if position remains open
        if (entryFill && !exitFill && candles.length > 0) {
          const lastCandle = candles[candles.length - 1];
          const lastTime =
            lastCandle.timestamp instanceof Date
              ? lastCandle.timestamp.getTime()
              : new Date(lastCandle.timestamp).getTime();
          execSim.submitOrder({
            tradeId: exp.id,
            symbol: exp.instrument?.symbol || 'BTCUSDT',
            side: isLong ? 'SELL' : 'BUY',
            orderType: 'MARKET',
            quantity: currentSizing,
            timestamp: lastTime,
            exitTarget: 'EXPIRED',
          });
          execSim.processCandle(lastCandle);
          exitFill = execSim.getAllFills().find((f) => f.exitTarget === 'EXPIRED');
        }

        if (entryFill && exitFill) {
          const actualEntryPrice = entryFill.price;
          const actualExitPrice = exitFill.price;
          const totalFees = Number((entryFill.fee + exitFill.fee).toFixed(4));
          const totalSlippage = Number((entryFill.slippage + exitFill.slippage).toFixed(4));

          const grossPnL = isLong
            ? (actualExitPrice - actualEntryPrice) * currentSizing
            : (actualEntryPrice - actualExitPrice) * currentSizing;
          const pnl = Number((grossPnL - totalFees).toFixed(2));

          const rawR = isLong
            ? (actualExitPrice - actualEntryPrice) / stopDist
            : (actualEntryPrice - actualExitPrice) / stopDist;
          const pnlR = Number((rawR * currentSizing - totalFees / (stopDist * currentSizing || 1)).toFixed(4));

          const exitReason =
            exitFill.exitTarget === 'TP1'
              ? SignalState.TP1_HIT
              : exitFill.exitTarget === 'SL'
              ? SignalState.SL_HIT
              : SignalState.EXPIRED;

          rMultiples.push(pnlR);
          executedTrades.push({
            id: `tr_${exp.id}`,
            direction: isLong ? Direction.BULLISH : Direction.BEARISH,
            entryTime: new Date(entryFill.timestamp),
            entryPrice: actualEntryPrice,
            exitTime: new Date(exitFill.timestamp),
            exitPrice: actualExitPrice,
            stopLoss: stopPrice,
            takeProfit: target1,
            positionSize: currentSizing,
            pnl,
            pnlRMultiple: pnlR,
            exitReason,
            signalTimestamp: new Date(exp.decisionTimestamp || entryTime),
            orderCreatedAt: new Date(entryFill.orderCreatedAt || entryTime),
            orderSubmittedAt: new Date(entryFill.orderSubmittedAt || entryTime),
            entryFillTimestamp: new Date(entryFill.timestamp),
            entryReferencePrice: entryPrice,
            entryFillPrice: actualEntryPrice,
            entryFees: entryFill.fee,
            entrySlippage: entryFill.slippage,
            exitOrderTimestamp: new Date(exitFill.timestamp),
            exitOrderCreatedAt: new Date(exitFill.exitOrderCreatedAt || exitFill.timestamp),
            exitOrderSubmittedAt: new Date(exitFill.exitOrderSubmittedAt || exitFill.timestamp),
            exitTriggerTimestamp: new Date(exitFill.exitTriggerTimestamp || exitFill.timestamp),
            exitFillTimestamp: new Date(exitFill.timestamp),
            exitReferencePrice: actualExitPrice,
            exitFillPrice: actualExitPrice,
            exitFees: exitFill.fee,
            exitSlippage: exitFill.slippage,
            executedPrice: actualExitPrice,
            fees: totalFees,
            slippageAmount: totalSlippage,
            slippageBps: 5,
          } as any);
        }
      }
    }

    const totalTrades = executedTrades.length;
    if (totalTrades === 0) {
      return {
        candidateId: candidate.id,
        totalTrades: 0,
        trades: [],
        rMultiples: [],
        netPnL: 0,
        grossProfit: 0,
        grossLoss: 0,
        winRate: 0,
        expectancyR: 0,
        profitFactor: 0,
        maxDrawdownR: 0,
      };
    }

    const netPnL = executedTrades.reduce((sum, t) => sum + t.pnl, 0);
    const grossProfit = executedTrades.filter((t) => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = executedTrades.filter((t) => t.pnl < 0).reduce((sum, t) => sum + Math.abs(t.pnl), 0);

    const wins = executedTrades.filter((t) => t.pnlRMultiple > 0).length;
    const winRate = Number(((wins / totalTrades) * 100).toFixed(1));

    const sumR = rMultiples.reduce((sum, r) => sum + r, 0);
    const expectancyR = Number((sumR / totalTrades).toFixed(4));
    const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 5.0 : 0.0;

    let peakR = 0;
    let runningR = 0;
    let maxDDR = 0;
    for (const r of rMultiples) {
      runningR += r;
      if (runningR > peakR) peakR = runningR;
      const dd = peakR - runningR;
      if (dd > maxDDR) maxDDR = dd;
    }

    return {
      candidateId: candidate.id,
      totalTrades,
      trades: executedTrades,
      rMultiples,
      netPnL: Number(netPnL.toFixed(2)),
      grossProfit: Number(grossProfit.toFixed(2)),
      grossLoss: Number(grossLoss.toFixed(2)),
      winRate,
      expectancyR,
      profitFactor,
      maxDrawdownR: Number(maxDDR.toFixed(2)),
    };
  }
}
