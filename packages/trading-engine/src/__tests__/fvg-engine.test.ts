import { FVGEngine } from '../fvg-engine';
import { Direction, ICandle } from '@quant/shared';

describe('FVGEngine', () => {
  it('should detect 3-candle Bullish FVG and track mitigation', () => {
    const candles: ICandle[] = [
      { timestamp: new Date(1000), open: 100, high: 105, low: 98, close: 102, volume: 100 }, // Candle 1: High = 105
      { timestamp: new Date(2000), open: 102, high: 120, low: 102, close: 118, volume: 1000 }, // Candle 2: Big expansion
      { timestamp: new Date(3000), open: 118, high: 125, low: 112, close: 122, volume: 500 }, // Candle 3: Low = 112 > 105 -> Gap [105, 112]
      { timestamp: new Date(4000), open: 122, high: 124, low: 115, close: 120, volume: 200 }, // Retest above FVG
      { timestamp: new Date(5000), open: 120, high: 121, low: 108, close: 116, volume: 300 }, // Enters FVG: Low 108 fills partially: (112 - 108) / (112 - 105) = 4/7 = 57%
    ];

    const { allFVGs, activeFVGs } = FVGEngine.detectFVGs(candles, { minGapAtrMultiplier: 0.1 });

    expect(allFVGs).toHaveLength(1);
    expect(allFVGs[0].direction).toBe(Direction.BULLISH);
    expect(allFVGs[0].lowerBound).toBe(105);
    expect(allFVGs[0].upperBound).toBe(112);
    expect(allFVGs[0].fillPercentage).toBeGreaterThan(50);
    expect(activeFVGs).toHaveLength(1); // Not fully filled or invalidated yet
  });
});
