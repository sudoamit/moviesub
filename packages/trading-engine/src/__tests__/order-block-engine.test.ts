import { OrderBlockEngine } from '../order-block-engine';
import { Direction, ICandle } from '@quant/shared';

describe('OrderBlockEngine', () => {
  it('should detect a Bullish Order Block preceding an aggressive displacement leg', () => {
    const candles: ICandle[] = [
      { timestamp: new Date(1000), open: 105, high: 106, low: 98, close: 100, volume: 200 },   // Index 0: Bearish down-candle
      { timestamp: new Date(2000), open: 100, high: 120, low: 100, close: 118, volume: 1000 }, // Index 1: Explosive up-move
      { timestamp: new Date(3000), open: 118, high: 130, low: 116, close: 128, volume: 1200 }, // Index 2: Follow-through
      { timestamp: new Date(4000), open: 128, high: 135, low: 125, close: 132, volume: 800 },  // Index 3: Top
      { timestamp: new Date(5000), open: 132, high: 133, low: 104, close: 110, volume: 300 },  // Index 4: Pullback entering OB (low 104 <= OB High 106)
    ];

    const { allOrderBlocks } = OrderBlockEngine.detectOrderBlocks(candles, [], [], { displacementThresholdAtr: 0.5 });

    expect(allOrderBlocks.length).toBeGreaterThanOrEqual(1);
    expect(allOrderBlocks[0].direction).toBe(Direction.BULLISH);
    expect(allOrderBlocks[0].high).toBe(106);
    expect(allOrderBlocks[0].low).toBe(98);
    expect(allOrderBlocks[0].isMitigated).toBe(true);
  });
});
