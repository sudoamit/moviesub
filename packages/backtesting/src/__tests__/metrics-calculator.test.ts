import { MetricsCalculator } from '../metrics-calculator';
import { Direction, IBacktestTrade, SignalState } from '@quant/shared';

describe('MetricsCalculator', () => {
  it('should calculate accurate win rate, profit factor, expectancy, and max drawdown', () => {
    const trades: IBacktestTrade[] = [
      {
        id: '1',
        direction: Direction.BULLISH,
        entryTime: new Date(1000),
        entryPrice: 100,
        exitTime: new Date(2000),
        exitPrice: 110,
        stopLoss: 95,
        takeProfit: 110,
        positionSize: 10,
        pnl: 1000,
        pnlRMultiple: 2.0,
        exitReason: SignalState.TP2_HIT,
      },
      {
        id: '2',
        direction: Direction.BULLISH,
        entryTime: new Date(3000),
        entryPrice: 110,
        exitTime: new Date(4000),
        exitPrice: 105,
        stopLoss: 105,
        takeProfit: 120,
        positionSize: 10,
        pnl: -500,
        pnlRMultiple: -1.0,
        exitReason: SignalState.SL_HIT,
      },
      {
        id: '3',
        direction: Direction.BEARISH,
        entryTime: new Date(5000),
        entryPrice: 120,
        exitTime: new Date(6000),
        exitPrice: 112.5,
        stopLoss: 125,
        takeProfit: 110,
        positionSize: 10,
        pnl: 750,
        pnlRMultiple: 1.5,
        exitReason: SignalState.TP1_HIT,
      },
    ];

    const equityCurve = [
      { timestamp: new Date(0), equity: 100000, drawdownPercent: 0 },
      { timestamp: new Date(2000), equity: 101000, drawdownPercent: 0 },
      { timestamp: new Date(4000), equity: 100500, drawdownPercent: 0.49 },
      { timestamp: new Date(6000), equity: 101250, drawdownPercent: 0 },
    ];

    const metrics = MetricsCalculator.calculateMetrics(trades, 100000, equityCurve);

    expect(metrics.totalTrades).toBe(3);
    expect(metrics.winningTrades).toBe(2);
    expect(metrics.losingTrades).toBe(1);
    expect(metrics.winRate).toBe(66.67);
    expect(metrics.netPnL).toBe(1250);
    expect(metrics.profitFactor).toBe(3.5); // 1750 / 500 = 3.5
    expect(metrics.finalEquity).toBe(101250);
    expect(metrics.expectancy).toBeGreaterThan(0);
  });
});
