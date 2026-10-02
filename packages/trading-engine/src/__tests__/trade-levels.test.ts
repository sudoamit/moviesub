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
      {
        index: 5,
        type: 'SWING_LOW' as any,
        price: 95,
        timestamp: new Date(),
        confirmedAtIndex: 8,
        confirmedAtTimestamp: new Date(),
      },
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

describe('TradeLevelsCalculator - crypto stop bounds', () => {
  // 15m BTC around 84,000 with a ~150-point ATR and an order block 30 points wide
  const btcCandles = (): ICandle[] =>
    Array.from({ length: 30 }, (_, i) => ({
      timestamp: new Date(i * 900000),
      open: 84000,
      high: 84075,
      low: 83925,
      close: 84000 + (i % 2 === 0 ? 10 : -10),
      volume: 100,
    }));
  const bearOB: any = { direction: Direction.BEARISH, low: 84200, high: 84230 };

  it('BTC stop is at least 0.5% of price (not the old 100-220 point clamp), targets scale with it', () => {
    const lv = TradeLevelsCalculator.calculateLevels(Direction.BEARISH, btcCandles(), null, bearOB, null, 'BTCUSDT_PERP')!;
    const risk = lv.stopLoss - lv.entry;
    expect(risk).toBeGreaterThanOrEqual(lv.entry * 0.005 - 0.01);
    expect(risk).toBeLessThanOrEqual(lv.entry * 0.02 + 0.01);
    expect(lv.entry - lv.takeProfits.tp1).toBeCloseTo(risk * 2, 1);
  });

  it('NIFTY is not treated as BTC: index stops are 0.1%-0.6% of the index level', () => {
    const niftyCandles = btcCandles().map((c) => ({ ...c, open: 25000, high: 25020, low: 24980, close: c.close - 59000 }));
    const ob: any = { direction: Direction.BEARISH, low: 25030, high: 25045 };
    const lv = TradeLevelsCalculator.calculateLevels(Direction.BEARISH, niftyCandles, null, ob, null, 'NIFTY')!;
    const risk = lv.stopLoss - lv.entry;
    expect(lv.stopLoss).toBeGreaterThan(ob.high); // beyond the order block
    // bounds are a share of the current index level (last close 24,990)
    expect(risk).toBeGreaterThanOrEqual(24990 * 0.001 - 0.01);
    expect(risk).toBeLessThanOrEqual(24990 * 0.006 + 0.01);
  });

  it('keeps the stop beyond the order block: a zone needing more than the maximum risk is rejected', () => {
    // Bearish OB 5% wide on BTC: entry mid-zone, a stop above it needs > 2% risk, so no levels (not a stop inside the zone)
    const wideOB: any = { direction: Direction.BEARISH, low: 84100, high: 88300 };
    expect(TradeLevelsCalculator.calculateLevels(Direction.BEARISH, btcCandles(), null, wideOB, null, 'BTCUSDT_PERP')).toBeNull();
    const lv = TradeLevelsCalculator.calculateLevels(Direction.BEARISH, btcCandles(), null, bearOB, null, 'BTCUSDT_PERP')!;
    expect(lv.stopLoss).toBeGreaterThan(bearOB.high);
  });
});
