import { IBacktestTrade } from '@quant/shared';
import { IEquityPoint } from './types';

export class MetricsCalculator {
  /**
   * Computes comprehensive quantitative performance metrics for a sequence of completed trades
   */
  static calculateMetrics(
    trades: IBacktestTrade[],
    initialCapital: number,
    equityCurve: IEquityPoint[],
  ) {
    if (trades.length === 0) {
      return {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        profitFactor: 0,
        netPnL: 0,
        averageR: 0,
        expectancy: 0,
        maxDrawdownPercent: 0,
        maxConsecutiveLosses: 0,
        sharpeRatio: 0,
        finalEquity: initialCapital,
      };
    }

    let winningTrades = 0;
    let losingTrades = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let totalR = 0;
    let winRSums = 0;
    let lossRSums = 0;
    let maxConsecutiveLosses = 0;
    let currentConsecutiveLosses = 0;

    for (const trade of trades) {
      const pnl = trade.pnl;
      const r = trade.pnlRMultiple;
      totalR += r;

      if (pnl > 0) {
        winningTrades++;
        grossProfit += pnl;
        winRSums += r;
        currentConsecutiveLosses = 0;
      } else if (pnl < 0) {
        losingTrades++;
        grossLoss += Math.abs(pnl);
        lossRSums += Math.abs(r);
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

    const avgWinR = winningTrades > 0 ? winRSums / winningTrades : 0;
    const avgLossR = losingTrades > 0 ? lossRSums / losingTrades : 1.0;
    const winProb = winningTrades / totalTrades;
    const lossProb = losingTrades / totalTrades;
    const expectancy = Number((winProb * avgWinR - lossProb * avgLossR).toFixed(2));

    // Peak-to-trough maximum drawdown from equity curve
    let peak = initialCapital;
    let maxDDPercent = 0;

    for (const pt of equityCurve) {
      if (pt.equity > peak) {
        peak = pt.equity;
      }
      const dd = ((peak - pt.equity) / peak) * 100;
      if (dd > maxDDPercent) {
        maxDDPercent = dd;
      }
    }

    // Approximate daily return Sharpe Ratio
    const returns: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      const prev = equityCurve[i - 1].equity;
      const curr = equityCurve[i].equity;
      if (prev > 0) {
        returns.push((curr - prev) / prev);
      }
    }

    let sharpeRatio = 0;
    if (returns.length > 1) {
      const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance =
        returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / (returns.length - 1);
      const stdDev = Math.sqrt(variance);
      if (stdDev > 0) {
        sharpeRatio = Number(((meanReturn / stdDev) * Math.sqrt(252)).toFixed(2));
      }
    }

    const finalEquity =
      equityCurve.length > 0
        ? Number(equityCurve[equityCurve.length - 1].equity.toFixed(2))
        : initialCapital + netPnL;

    return {
      totalTrades,
      winningTrades,
      losingTrades,
      winRate,
      profitFactor,
      netPnL,
      averageR,
      expectancy,
      maxDrawdownPercent: Number(maxDDPercent.toFixed(2)),
      maxConsecutiveLosses,
      sharpeRatio,
      finalEquity,
    };
  }
}
