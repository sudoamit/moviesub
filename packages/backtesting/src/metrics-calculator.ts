import { IBacktestTrade } from '@quant/shared';
import { IEquityPoint, IEquitySnapshot, IQuantitativeMetrics } from './types';
import { PositionLot } from '@quant/risk-engine';

export class MetricsCalculator {
  /**
   * Computes comprehensive quantitative performance metrics according to institutional standards
   */
  static calculateMetrics(
    trades: IBacktestTrade[],
    initialCapital: number,
    equityCurve: IEquityPoint[],
    equitySnapshots: IEquitySnapshot[] = [],
    positionLots: PositionLot[] = [],
  ): IQuantitativeMetrics {
    if (trades.length === 0) {
      return {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        profitFactor: 0,
        netPnL: 0,
        totalReturnPercent: 0,
        cagr: 0,
        averageR: 0,
        medianR: 0,
        averageWin: 0,
        averageLoss: 0,
        payoffRatio: 0,
        expectancy: 0,
        maxDrawdownPercent: 0,
        drawdownDurationBars: 0,
        recoveryTimeBars: 0,
        sharpeRatio: 0,
        sortinoRatio: 0,
        calmarRatio: 0,
        valueAtRisk95: 0,
        cvar95: 0,
        exposurePercent: 0,
        turnover: 0,
        totalFees: 0,
        totalSlippage: 0,
        maxMAE: 0,
        maxMFE: 0,
        maxConsecutiveLosses: 0,
        finalEquity: initialCapital,
      };
    }

    let winningTrades = 0;
    let losingTrades = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let totalR = 0;
    const rValues: number[] = [];
    const pnlValues: number[] = [];
    let maxConsecutiveLosses = 0;
    let currentConsecutiveLosses = 0;
    let turnover = 0;
    if (positionLots && positionLots.length > 0) {
      for (const lot of positionLots) {
        if (lot.partialFills && lot.partialFills.length > 0) {
          for (const fill of lot.partialFills) {
            turnover += Math.abs((fill.price || 0) * (fill.quantity || 0));
          }
        } else {
          turnover += Math.abs((lot.entryPrice || 0) * (lot.initialQuantity || 0));
        }
      }
    } else {
      for (const trade of trades) {
        const entryTurnover = Math.abs((trade.entryPrice || 0) * (trade.positionSize || 0));
        const exitPrice = trade.exitPrice || trade.entryPrice || 0;
        const exitTurnover = Math.abs(exitPrice * (trade.positionSize || 0));
        turnover += entryTurnover + exitTurnover;
      }
    }

    for (const trade of trades) {
      const pnl = trade.pnl;
      const r = trade.pnlRMultiple;
      totalR += r;
      rValues.push(r);
      pnlValues.push(pnl);

      if (pnl > 0) {
        winningTrades++;
        grossProfit += pnl;
        currentConsecutiveLosses = 0;
      } else if (pnl < 0) {
        losingTrades++;
        grossLoss += Math.abs(pnl);
        currentConsecutiveLosses++;
        if (currentConsecutiveLosses > maxConsecutiveLosses) {
          maxConsecutiveLosses = currentConsecutiveLosses;
        }
      }
    }

    const totalTrades = trades.length;
    const winRate = Number(((winningTrades / totalTrades) * 100).toFixed(2));
    const profitFactor =
      grossLoss === 0
        ? grossProfit > 0
          ? 99.99
          : 1.0
        : Number((grossProfit / grossLoss).toFixed(2));

    const netPnL = Number((grossProfit - grossLoss).toFixed(2));
    const averageR = Number((totalR / totalTrades).toFixed(2));

    // Median R
    rValues.sort((a, b) => a - b);
    const mid = Math.floor(rValues.length / 2);
    const medianR =
      rValues.length % 2 !== 0
        ? rValues[mid]
        : Number(((rValues[mid - 1] + rValues[mid]) / 2).toFixed(2));

    const averageWin = winningTrades > 0 ? Number((grossProfit / winningTrades).toFixed(2)) : 0;
    const averageLoss = losingTrades > 0 ? Number((grossLoss / losingTrades).toFixed(2)) : 0;
    const payoffRatio =
      averageLoss > 0 ? Number((averageWin / averageLoss).toFixed(2)) : averageWin > 0 ? 99.99 : 0;

    const winProb = winningTrades / totalTrades;
    const lossProb = losingTrades / totalTrades;
    const expectancy = Number(
      (
        winProb * (winningTrades > 0 ? grossProfit / winningTrades : 0) -
        lossProb * (losingTrades > 0 ? grossLoss / losingTrades : 0)
      ).toFixed(2),
    );

    // Peak-to-trough maximum drawdown, duration, and recovery
    let peak = initialCapital;
    let maxDDPercent = 0;
    let currentDDDuration = 0;
    let maxDDDuration = 0;
    let recoveryBars = 0;

    const points = equitySnapshots.length > 0 ? equitySnapshots : equityCurve;

    for (const pt of points) {
      if (pt.equity >= peak) {
        peak = pt.equity;
        currentDDDuration = 0;
      } else {
        currentDDDuration++;
        if (currentDDDuration > maxDDDuration) {
          maxDDDuration = currentDDDuration;
        }
        const dd = ((peak - pt.equity) / peak) * 100;
        if (dd > maxDDPercent) {
          maxDDPercent = dd;
          recoveryBars = currentDDDuration;
        }
      }
    }

    // Daily sampled returns for Sharpe, Sortino, VaR (Aggregating intraday to daily closing equity)
    const dailyEquityMap = new Map<string, number>();
    for (const pt of points) {
      const dt = pt.timestamp instanceof Date ? pt.timestamp : new Date(pt.timestamp);
      const dayKey = dt.toISOString().slice(0, 10);
      dailyEquityMap.set(dayKey, pt.equity);
    }

    const dailyEquities = Array.from(dailyEquityMap.values());
    const returns: number[] = [];

    if (dailyEquities.length > 1) {
      for (let i = 1; i < dailyEquities.length; i++) {
        const prev = dailyEquities[i - 1];
        const curr = dailyEquities[i];
        if (prev > 0) {
          returns.push((curr - prev) / prev);
        }
      }
    } else {
      // Fallback if simulation has single day or synthetic timestamps
      for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1].equity;
        const curr = points[i].equity;
        if (prev > 0) {
          returns.push((curr - prev) / prev);
        }
      }
    }

    let sharpeRatio = 0;
    let sortinoRatio = 0;
    let valueAtRisk95 = 0;
    let cvar95 = 0;

    if (returns.length > 1) {
      const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance =
        returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / (returns.length - 1);
      const stdDev = Math.sqrt(variance);

      // Downside deviation for Sortino
      const downsideReturns = returns.filter((r) => r < 0);
      const downsideVariance =
        downsideReturns.length > 0
          ? downsideReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) / downsideReturns.length
          : 0;
      const downsideStdDev = Math.sqrt(downsideVariance);

      if (stdDev > 0) {
        sharpeRatio = Number(((meanReturn / stdDev) * Math.sqrt(252)).toFixed(2));
      }
      if (downsideStdDev > 0) {
        sortinoRatio = Number(((meanReturn / downsideStdDev) * Math.sqrt(252)).toFixed(2));
      }

      // VaR 95% & CVaR 95%
      const sortedReturns = [...returns].sort((a, b) => a - b);
      const varIdx = Math.floor(sortedReturns.length * 0.05);
      valueAtRisk95 = Number((Math.abs(sortedReturns[varIdx] || 0) * 100).toFixed(2));

      const tailReturns = sortedReturns.slice(0, Math.max(1, varIdx));
      const cvarMean = tailReturns.reduce((a, b) => a + b, 0) / tailReturns.length;
      cvar95 = Number((Math.abs(cvarMean) * 100).toFixed(2));
    }

    const finalEquity =
      points.length > 0
        ? Number(points[points.length - 1].equity.toFixed(2))
        : initialCapital + netPnL;

    const totalReturnPercent = Number(
      (((finalEquity - initialCapital) / initialCapital) * 100).toFixed(2),
    );

    // Institutional CAGR using elapsed calendar days
    let elapsedDays = 1;
    if (points.length >= 2) {
      const t0 = new Date(points[0].timestamp).getTime();
      const tEnd = new Date(points[points.length - 1].timestamp).getTime();
      if (tEnd > t0) {
        elapsedDays = Math.max(1, (tEnd - t0) / (24 * 3600 * 1000));
      }
    }
    const cagr = Number(
      ((Math.pow(Math.max(0.0001, finalEquity / initialCapital), 365.25 / elapsedDays) - 1) * 100).toFixed(2),
    );
    const calmarRatio =
      maxDDPercent > 0 ? Number((cagr / maxDDPercent).toFixed(2)) : cagr > 0 ? 99.99 : 0;

    // Fees, slippage, MAE/MFE totals
    let totalFees = 0;
    let totalSlippage = 0;
    let maxMAE = 0;
    let maxMFE = 0;

    for (const lot of positionLots) {
      maxMAE = Math.max(maxMAE, lot.mae);
      maxMFE = Math.max(maxMFE, lot.mfe);
      for (const fill of lot.partialFills) {
        totalFees += fill.fee;
        totalSlippage += fill.slippage;
      }
    }

    const exposureBars = equitySnapshots.filter((s) => s.grossExposure > 0).length;
    const exposurePercent =
      equitySnapshots.length > 0
        ? Number(((exposureBars / equitySnapshots.length) * 100).toFixed(2))
        : 0;

    return {
      totalTrades,
      winningTrades,
      losingTrades,
      winRate,
      profitFactor,
      netPnL,
      totalReturnPercent,
      cagr,
      averageR,
      medianR,
      averageWin,
      averageLoss,
      payoffRatio,
      expectancy,
      maxDrawdownPercent: Number(maxDDPercent.toFixed(2)),
      drawdownDurationBars: maxDDDuration,
      recoveryTimeBars: recoveryBars,
      sharpeRatio,
      sortinoRatio,
      calmarRatio,
      valueAtRisk95,
      cvar95,
      exposurePercent,
      turnover: Number(turnover.toFixed(2)),
      totalFees: Number(totalFees.toFixed(2)),
      totalSlippage: Number(totalSlippage.toFixed(2)),
      maxMAE: Number(maxMAE.toFixed(2)),
      maxMFE: Number(maxMFE.toFixed(2)),
      maxConsecutiveLosses,
      finalEquity,
    };
  }
}
