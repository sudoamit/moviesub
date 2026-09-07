import { TradingExperience } from './types';

export interface IStrategyPerformanceReport {
  totalTrades: number;
  winCount: number;
  lossCount: number;
  scratchCount: number;
  timeoutCount: number;
  winRate: number;
  expectancy: number;
  averageMFE: number;
  averageMAE: number;
  mfeMaeRatio: number;
  averageHoldingTimeMinutes: number;
  goodTradeLossRatio: number;
  badTradeWinRatio: number;
  tp1HitRate: number;
  tp2HitRate: number;
}

export class StrategyPerformanceAnalyzer {
  /**
   * Performs deep trade management, execution quality, and MFE/MAE analytics.
   */
  public static analyze(experiences: TradingExperience[]): IStrategyPerformanceReport {
    const totalTrades = experiences.length;
    if (totalTrades === 0) {
      return {
        totalTrades: 0,
        winCount: 0,
        lossCount: 0,
        scratchCount: 0,
        timeoutCount: 0,
        winRate: 0,
        expectancy: 0,
        averageMFE: 0,
        averageMAE: 0,
        mfeMaeRatio: 1.0,
        averageHoldingTimeMinutes: 0,
        goodTradeLossRatio: 0,
        badTradeWinRatio: 0,
        tp1HitRate: 0,
        tp2HitRate: 0,
      };
    }

    const winCount = experiences.filter((e) => e.outcome.status === 'WIN').length;
    const lossCount = experiences.filter((e) => e.outcome.status === 'LOSS').length;
    const scratchCount = experiences.filter((e) => e.outcome.status === 'SCRATCH').length;
    const timeoutCount = experiences.filter((e) => e.outcome.status === 'TIMEOUT').length;

    const winRate = Number(((winCount / totalTrades) * 100).toFixed(1));
    const totalR = experiences.reduce((sum, e) => sum + e.outcome.pnlR, 0);
    const expectancy = Number((totalR / totalTrades).toFixed(2));

    const totalMFE = experiences.reduce((sum, e) => sum + e.outcome.maxFavorableExcursion, 0);
    const totalMAE = experiences.reduce((sum, e) => sum + e.outcome.maxAdverseExcursion, 0);
    const averageMFE = Number((totalMFE / totalTrades).toFixed(2));
    const averageMAE = Number((totalMAE / totalTrades).toFixed(2));
    const mfeMaeRatio = averageMAE > 0 ? Number((averageMFE / averageMAE).toFixed(2)) : 2.0;

    const totalHoldingSeconds = experiences.reduce(
      (sum, e) => sum + e.outcome.holdingTimeSeconds,
      0,
    );
    const averageHoldingTimeMinutes = Math.round(totalHoldingSeconds / totalTrades / 60);

    const goodLosses = experiences.filter(
      (e) => e.outcomeClassification === 'GOOD_TRADE_LOSS',
    ).length;
    const goodTradeLossRatio =
      lossCount > 0 ? Number(((goodLosses / lossCount) * 100).toFixed(1)) : 0;

    const badWins = experiences.filter((e) => e.outcomeClassification === 'BAD_TRADE_WIN').length;
    const badTradeWinRatio = winCount > 0 ? Number(((badWins / winCount) * 100).toFixed(1)) : 0;

    const tp1Hits = experiences.filter((e) => e.outcome.maxFavorableExcursion >= 1.5).length;
    const tp2Hits = experiences.filter((e) => e.outcome.maxFavorableExcursion >= 2.5).length;
    const tp1HitRate = Number(((tp1Hits / totalTrades) * 100).toFixed(1));
    const tp2HitRate = Number(((tp2Hits / totalTrades) * 100).toFixed(1));

    return {
      totalTrades,
      winCount,
      lossCount,
      scratchCount,
      timeoutCount,
      winRate,
      expectancy,
      averageMFE,
      averageMAE,
      mfeMaeRatio,
      averageHoldingTimeMinutes,
      goodTradeLossRatio,
      badTradeWinRatio,
      tp1HitRate,
      tp2HitRate,
    };
  }
}
