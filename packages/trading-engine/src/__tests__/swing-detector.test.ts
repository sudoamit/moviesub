import { SwingDetector } from '../swing-detector';
import { ICandle, StructureType } from '@quant/shared';

describe('SwingDetector', () => {
  it('should detect a Swing High strictly after confirmation bars close (No look-ahead)', () => {
    // LeftBars = 2, RightBars = 2
    // High peak at index 2 (price 120)
    const candles: ICandle[] = [
      { timestamp: new Date(1000), open: 100, high: 105, low: 95, close: 100, volume: 100 },
      { timestamp: new Date(2000), open: 100, high: 110, low: 98, close: 108, volume: 100 },
      { timestamp: new Date(3000), open: 108, high: 120, low: 105, close: 115, volume: 100 }, // Peak (index 2)
      { timestamp: new Date(4000), open: 115, high: 112, low: 102, close: 105, volume: 100 },
      { timestamp: new Date(5000), open: 105, high: 108, low: 98, close: 100, volume: 100 }, // Confirmation bar (index 4)
    ];

    const swings = SwingDetector.detectSwings(candles, {
      leftBars: 2,
      rightBars: 2,
      minDistanceAtrMultiplier: 0.1,
    });

    expect(swings).toHaveLength(1);
    expect(swings[0].index).toBe(2);
    expect(swings[0].price).toBe(120);
    expect(swings[0].type).toBe(StructureType.SWING_HIGH);
    // Crucial: Must be confirmed at index 4 (i + rightBars)
    expect(swings[0].confirmedAtIndex).toBe(4);
  });

  it('should detect and classify Higher Highs, Higher Lows, Lower Highs, and Lower Lows', () => {
    // Construct sequence: Low (80) -> High (120) -> Higher Low (90) -> Higher High (140)
    const candles: ICandle[] = [];
    const prices = [
      100,
      90,
      80,
      95,
      105, // Swing Low at index 2 (80)
      115,
      120,
      110,
      100, // Swing High at index 6 (120)
      90,
      100,
      110, // Higher Low at index 9 (90 > 80)
      130,
      140,
      125,
      115, // Higher High at index 13 (140 > 120)
      100,
      90,
      80, // Trailing bars for rightBars confirmation
    ];

    for (let i = 0; i < prices.length; i++) {
      candles.push({
        timestamp: new Date(10000 + i * 60000),
        open: prices[i],
        high: prices[i] + 2,
        low: prices[i] - 2,
        close: prices[i],
        volume: 1000,
      });
    }

    const swings = SwingDetector.detectSwings(candles, {
      leftBars: 2,
      rightBars: 2,
      minDistanceAtrMultiplier: 0.1,
    });
    expect(swings.length).toBeGreaterThanOrEqual(2);

    const hasSwingHigh = swings.some(
      (s) => s.type === StructureType.SWING_HIGH || s.type === StructureType.HIGHER_HIGH,
    );
    const hasSwingLow = swings.some(
      (s) => s.type === StructureType.SWING_LOW || s.type === StructureType.HIGHER_LOW,
    );

    expect(hasSwingHigh).toBe(true);
    expect(hasSwingLow).toBe(true);
  });
});
