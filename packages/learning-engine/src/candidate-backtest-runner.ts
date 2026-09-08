import { ICandle, IBacktestTrade, Direction, SignalState, SignalGrade } from '@quant/shared';
import {
  ExecutionSimulator,
  FillModel,
  SameCandleAmbiguityMode,
  IOrder,
} from '@quant/backtesting';
import { StrategyCandidate, TradingExperience } from './types';

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
    const execSim = new ExecutionSimulator(
      FillModel.OHLC_PATH,
      SameCandleAmbiguityMode.OHLC_PATH,
      { submissionLatencyMs: 15, processingLatencyMs: 5 },
      `cand_${candidate.id}`,
    );

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
      const entryTime = exp.labelStartTimestamp || (exp.execution?.entryTime ? new Date(exp.execution.entryTime).getTime() : new Date(exp.timestamp).getTime());

      if (candles && candles.length > 0 && stopDist > 0) {
        // Submit entry order and execute via ExecutionSimulator
        execSim.submitOrder({
          tradeId: exp.id,
          symbol: exp.instrument?.symbol || 'BTCUSDT',
          side: isLong ? 'BUY' : 'SELL',
          orderType: 'MARKET',
          quantity: currentSizing,
          timestamp: entryTime,
          exitTarget: 'ENTRY',
        });

        const candleRes = execSim.processCandle(candles[0], candles[1]);
        const fillEntry = candleRes.fills;

        if (fillEntry.length > 0) {
          let exitFillPrice = fillEntry[0].price;
          let isWin = false;
          let stoppedOut = false;

          for (let cIdx = 0; cIdx < candles.length; cIdx++) {
            const candle = candles[cIdx];
            const low = candle.low;
            const high = candle.high;

            const slHit = isLong ? low <= stopPrice : high >= stopPrice;
            const tpHit = isLong ? high >= target1 : low <= target1;

            if (slHit && tpHit) {
              const openDistSl = Math.abs(candle.open - stopPrice);
              const openDistTp = Math.abs(candle.open - target1);
              if (openDistTp < openDistSl) {
                isWin = true;
                exitFillPrice = target1;
              } else {
                stoppedOut = true;
                exitFillPrice = stopPrice;
              }
              break;
            } else if (slHit) {
              stoppedOut = true;
              exitFillPrice = stopPrice;
              break;
            } else if (tpHit) {
              isWin = true;
              exitFillPrice = target1;
              break;
            }
          }

          if (!stoppedOut && !isWin) {
            exitFillPrice = exp.execution?.exitPrice || entryPrice;
          }

          const realizedR = isLong
            ? (exitFillPrice - fillEntry[0].price) / stopDist
            : (fillEntry[0].price - exitFillPrice) / stopDist;

          const pnlR = Number((realizedR * currentSizing - 0.05).toFixed(4));
          const pnl = Number(((exitFillPrice - fillEntry[0].price) * (isLong ? 1 : -1) * currentSizing).toFixed(2));

          rMultiples.push(pnlR);
          executedTrades.push({
            id: `tr_${exp.id}`,
            direction: isLong ? Direction.BULLISH : Direction.BEARISH,
            entryTime: new Date(entryTime),
            entryPrice: fillEntry[0].price,
            exitTime: new Date(exp.labelEndTimestamp || entryTime + 3600000),
            exitPrice: exitFillPrice,
            stopLoss: stopPrice,
            takeProfit: target1,
            positionSize: currentSizing,
            pnl,
            pnlRMultiple: pnlR,
            exitReason: isWin ? SignalState.TP1_HIT : stoppedOut ? SignalState.SL_HIT : SignalState.EXPIRED,
            signalTimestamp: new Date(exp.decisionTimestamp || entryTime),
            orderCreatedAt: new Date(entryTime),
            orderSubmittedAt: new Date(entryTime),
            entryFillTimestamp: new Date(entryTime),
            entryReferencePrice: entryPrice,
            entryFillPrice: fillEntry[0].price,
            entryFees: 0.0007 * fillEntry[0].price * currentSizing,
            entrySlippage: Math.abs(fillEntry[0].price - entryPrice),
            exitOrderTimestamp: new Date(exp.labelEndTimestamp || entryTime + 3600000),
            exitOrderCreatedAt: new Date(exp.labelEndTimestamp || entryTime + 3600000),
            exitOrderSubmittedAt: new Date(exp.labelEndTimestamp || entryTime + 3600000),
            exitTriggerTimestamp: new Date(exp.labelEndTimestamp || entryTime + 3600000),
            exitFillTimestamp: new Date(exp.labelEndTimestamp || entryTime + 3600000),
            exitReferencePrice: exitFillPrice,
            exitFillPrice,
            exitFees: 0.0007 * exitFillPrice * currentSizing,
            exitSlippage: 0,
            executedPrice: exitFillPrice,
            fees: 0.0014 * exitFillPrice * currentSizing,
            slippageAmount: Math.abs(fillEntry[0].price - entryPrice),
            slippageBps: 5,
          } as any);
        }
      } else {
        // Fallback using exact price levels and risk distance
        const expRealizedR = exp.outcome?.pnlR || 0;
        let realizedR = expRealizedR;
        if (candidate.type === 'EXIT' && candidate.change.parameter === 'stopLossAtrMultiplier') {
          const slMult = config.stopLossAtrMultiplier || 1.0;
          if (exp.outcome?.status === 'LOSS') {
            const maxAdverse = exp.outcome.maxAdverseExcursion || 1.0;
            realizedR = maxAdverse <= slMult ? expRealizedR : -1.0;
          }
        }
        const pnlR = Number((realizedR * currentSizing - 0.05).toFixed(4));
        const pnl = Number(((exp.outcome?.pnl || 0) * currentSizing).toFixed(2));

        rMultiples.push(pnlR);
        executedTrades.push({
          id: `tr_${exp.id}`,
          direction: isLong ? Direction.BULLISH : Direction.BEARISH,
          entryTime: new Date(entryTime),
          entryPrice,
          exitTime: new Date(exp.labelEndTimestamp || entryTime + 3600000),
          exitPrice: exp.execution?.exitPrice || entryPrice,
          stopLoss: stopPrice,
          takeProfit: target1,
          positionSize: currentSizing,
          pnl,
          pnlRMultiple: pnlR,
          exitReason: exp.outcome?.status === 'WIN' ? SignalState.TP1_HIT : SignalState.SL_HIT,
          signalTimestamp: new Date(exp.decisionTimestamp || entryTime),
          orderCreatedAt: new Date(entryTime),
          orderSubmittedAt: new Date(entryTime),
          entryFillTimestamp: new Date(entryTime),
          entryReferencePrice: entryPrice,
          entryFillPrice: entryPrice,
          entryFees: 0.0007 * entryPrice * currentSizing,
          entrySlippage: 0,
          exitOrderTimestamp: new Date(exp.labelEndTimestamp || entryTime + 3600000),
          exitOrderCreatedAt: new Date(exp.labelEndTimestamp || entryTime + 3600000),
          exitOrderSubmittedAt: new Date(exp.labelEndTimestamp || entryTime + 3600000),
          exitTriggerTimestamp: new Date(exp.labelEndTimestamp || entryTime + 3600000),
          exitFillTimestamp: new Date(exp.labelEndTimestamp || entryTime + 3600000),
          exitReferencePrice: exp.execution?.exitPrice || entryPrice,
          exitFillPrice: exp.execution?.exitPrice || entryPrice,
          exitFees: 0.0007 * (exp.execution?.exitPrice || entryPrice) * currentSizing,
          exitSlippage: 0,
          executedPrice: exp.execution?.exitPrice || entryPrice,
          fees: 0.0014 * entryPrice * currentSizing,
          slippageAmount: 0,
          slippageBps: 0,
        } as any);
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
