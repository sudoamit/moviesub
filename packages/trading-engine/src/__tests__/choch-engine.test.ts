import { CHOCHEngine } from '../choch-engine';
import { Direction, ICandle, ISwingPoint, StructureType } from '@quant/shared';

describe('CHOCHEngine', () => {
  it('should detect Bullish CHoCH when price breaks above previous Lower High in a downtrend', () => {
    const swings: ISwingPoint[] = [
      { index: 1, type: StructureType.SWING_HIGH, price: 150, timestamp: new Date(1000), confirmedAtIndex: 3, confirmedAtTimestamp: new Date(3000) },
      { index: 4, type: StructureType.LOWER_LOW, price: 110, timestamp: new Date(4000), confirmedAtIndex: 6, confirmedAtTimestamp: new Date(6000) },
      { index: 7, type: StructureType.LOWER_HIGH, price: 130, timestamp: new Date(7000), confirmedAtIndex: 9, confirmedAtTimestamp: new Date(9000) },
      { index: 10, type: StructureType.LOWER_LOW, price: 95, timestamp: new Date(10000), confirmedAtIndex: 12, confirmedAtTimestamp: new Date(12000) },
    ];

    const candles: ICandle[] = [];
    for (let i = 0; i <= 15; i++) {
      const price = i === 14 ? 135 : 100; // Bar 14 explodes above LH (130)
      candles.push({
        timestamp: new Date(i * 1000),
        open: price - 2,
        high: price + 3,
        low: price - 3,
        close: price,
        volume: 1000,
      });
    }

    const choch = CHOCHEngine.detectCHOCH(candles, swings);
    expect(choch.length).toBeGreaterThanOrEqual(1);
    expect(choch[0].direction).toBe(Direction.BULLISH);
    expect(choch[0].previousTrend).toBe(Direction.BEARISH);
  });
});
