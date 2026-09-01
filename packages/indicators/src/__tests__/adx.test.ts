import { calculateADX } from '../adx';
import { ICandle } from '@quant/shared';

describe('calculateADX', () => {
  it('should calculate ADX, +DI, and -DI for a directional trend', () => {
    const candles: ICandle[] = [];
    let price = 100;

    for (let i = 0; i < 40; i++) {
      price += 2; // Strong uptrend
      candles.push({
        timestamp: new Date(Date.now() + i * 60000),
        open: price - 1,
        high: price + 2,
        low: price - 2,
        close: price + 1,
        volume: 1000,
      });
    }

    const { adx, plusDI, minusDI } = calculateADX(candles, 14);

    // In a strong uptrend, +DI must be significantly higher than -DI
    const lastIdx = candles.length - 1;
    expect(plusDI[lastIdx]).toBeGreaterThan(minusDI[lastIdx]!);
    expect(adx[lastIdx]).toBeGreaterThan(20);
  });
});
