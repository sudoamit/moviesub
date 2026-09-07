import { calculateRSI } from '../rsi';

describe('calculateRSI', () => {
  it('should return 100 for continuous upward prices', () => {
    const prices = [10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40];
    const rsi14 = calculateRSI(prices, 14);

    expect(rsi14[14]).toBe(100);
    expect(rsi14[15]).toBe(100);
  });

  it('should return 0 for continuous downward prices', () => {
    const prices = [50, 48, 46, 44, 42, 40, 38, 36, 34, 32, 30, 28, 26, 24, 22, 20];
    const rsi14 = calculateRSI(prices, 14);

    expect(rsi14[14]).toBe(0);
    expect(rsi14[15]).toBe(0);
  });

  it('should return oscillating values between 0 and 100 for normal price series', () => {
    const prices = [
      100, 102, 101, 103, 105, 104, 106, 108, 107, 109, 111, 110, 112, 114, 113, 115, 114, 116, 118,
      117,
    ];
    const rsi14 = calculateRSI(prices, 14);

    for (let i = 14; i < prices.length; i++) {
      expect(rsi14[i]).toBeGreaterThan(0);
      expect(rsi14[i]).toBeLessThan(100);
    }
  });
});
