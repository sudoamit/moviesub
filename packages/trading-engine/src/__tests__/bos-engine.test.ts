import { BOSEngine } from '../bos-engine';
import { Direction, ICandle, ISwingPoint, StructureType } from '@quant/shared';

describe('BOSEngine', () => {
  it('should detect a Bullish BOS when price closes above a confirmed Swing High with displacement', () => {
    const swingHigh: ISwingPoint = {
      index: 2,
      type: StructureType.SWING_HIGH,
      price: 120,
      timestamp: new Date(3000),
      confirmedAtIndex: 4,
      confirmedAtTimestamp: new Date(5000),
    };

    const candles: ICandle[] = [
      { timestamp: new Date(1000), open: 100, high: 105, low: 95, close: 100, volume: 100 },
      { timestamp: new Date(2000), open: 100, high: 110, low: 98, close: 108, volume: 100 },
      { timestamp: new Date(3000), open: 108, high: 120, low: 105, close: 115, volume: 100 }, // Swing High
      { timestamp: new Date(4000), open: 115, high: 112, low: 102, close: 105, volume: 100 },
      { timestamp: new Date(5000), open: 105, high: 108, low: 98, close: 100, volume: 100 }, // Confirmed at bar 4
      { timestamp: new Date(6000), open: 100, high: 115, low: 99, close: 114, volume: 100 },
      { timestamp: new Date(7000), open: 114, high: 130, low: 113, close: 128, volume: 500 }, // Breakout bar closing at 128 > 120
    ];

    const bos = BOSEngine.detectBOS(candles, [swingHigh], { displacementThresholdAtr: 0.5 });

    expect(bos).toHaveLength(1);
    expect(bos[0].direction).toBe(Direction.BULLISH);
    expect(bos[0].brokenLevel).toBe(120);
    expect(bos[0].candleIndex).toBe(6);
    expect(bos[0].breakPrice).toBe(128);
  });
});
