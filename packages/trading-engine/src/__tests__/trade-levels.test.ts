import { TradeLevelsCalculator } from '../trade-levels';
import { Direction, ICandle } from '@quant/shared';

describe('TradeLevelsCalculator', () => {
  it('should calculate valid Long levels, invalidation SL, and multi-tier TPs', () => {
    const candles: ICandle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push({
        timestamp: new Date(i * 1000),
        open: 100 + i,
        high: 102 + i,
        low: 98 + i,
        close: 101 + i,
        volume: 1000,
      });
    }

    const levels = TradeLevelsCalculator.calculateLevels(
      Direction.BULLISH,
      candles,
      { index: 5, type: 'SWING_LOW' as any, price: 95, timestamp: new Date(), confirmedAtIndex: 8, confirmedAtTimestamp: new Date() },
      null,
      null,
    );

    expect(levels).not.toBeNull();
    expect(levels!.direction).toBe(Direction.BULLISH);
    expect(levels!.stopLoss).toBeLessThan(levels!.entryZone.optimal);
    expect(levels!.takeProfits.tp1).toBeGreaterThan(levels!.entryZone.optimal);
    expect(levels!.takeProfits.tp2).toBeGreaterThan(levels!.takeProfits.tp1);
    expect(levels!.takeProfits.tp3).toBeGreaterThan(levels!.takeProfits.tp2);
  });
});
