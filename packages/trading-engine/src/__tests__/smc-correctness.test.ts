import { BOSConfirmationType, Direction, ICandle, ISwingPoint, LiquidityType, StructureType } from '@quant/shared';
import { BOSEngine } from '../bos-engine';
import { OrderBlockEngine } from '../order-block-engine';
import { LiquidityEngine } from '../liquidity-engine';

const candle = (i: number, o: number, h: number, l: number, c: number): ICandle => ({
  timestamp: new Date(i * 60_000),
  open: o,
  high: h,
  low: l,
  close: c,
  volume: 100,
});

const swing = (index: number, type: StructureType, price: number): ISwingPoint => ({
  index,
  type,
  price,
  timestamp: new Date(index * 60_000),
  confirmedAtIndex: index + 1,
  confirmedAtTimestamp: new Date((index + 1) * 60_000),
});

describe('SMC definitions', () => {
  it('BOS is only emitted with the prevailing structure; a counter-trend break is left to CHoCH', () => {
    const candles = [
      candle(0, 100, 101, 99, 100),
      candle(1, 100, 105, 99, 104),
      candle(2, 104, 110, 103, 108), // swing high 110
      candle(3, 108, 109, 100, 101),
      candle(4, 101, 102, 95, 97), // swing low 95
      candle(5, 97, 104, 96, 103),
      candle(6, 103, 113, 102, 112), // closes above 110 -> bullish BOS (first break)
      candle(7, 112, 112, 89, 90), // closes below 95 -> counter-trend: no bearish BOS
      candle(8, 90, 92, 86, 88),
      candle(9, 88, 89, 85, 87), // swing low 85
      candle(10, 87, 90, 86, 89),
      candle(11, 89, 89, 79, 80), // closes below 85 -> bearish BOS (structure is now bearish)
    ];
    const swings = [
      swing(2, StructureType.SWING_HIGH, 110),
      swing(4, StructureType.SWING_LOW, 95),
      swing(9, StructureType.LOWER_LOW, 85),
    ];
    const bos = BOSEngine.detectBOS(candles, swings, { confirmationType: BOSConfirmationType.CANDLE_CLOSE });
    expect(bos.map((b) => [b.candleIndex, b.direction])).toEqual([
      [6, Direction.BULLISH],
      [11, Direction.BEARISH],
    ]);
  });

  it('order block is the LAST opposite candle before the impulse', () => {
    const candles = [
      candle(0, 105, 106, 99, 100), // bearish
      candle(1, 100, 101, 96, 97), // bearish, last one before the impulse
      candle(2, 97, 116, 97, 115),
      candle(3, 115, 126, 114, 125),
      candle(4, 125, 130, 124, 128),
      candle(5, 128, 129, 126, 127),
    ];
    const { allOrderBlocks } = OrderBlockEngine.detectOrderBlocks(candles);
    const bullish = allOrderBlocks.filter((ob) => ob.direction === Direction.BULLISH);
    expect(bullish.map((ob) => ob.candleIndex)).toEqual([1]);
  });

  it('order block requires the impulse to break structure or leave an imbalance', () => {
    // Large overlapping up-move with no gap and no BOS -> no order block
    const candles = [
      candle(0, 105, 106, 99, 100),
      candle(1, 100, 108, 99, 107),
      candle(2, 107, 112, 104, 111),
      candle(3, 111, 113, 107, 112),
      candle(4, 112, 113, 110, 111),
    ];
    const { allOrderBlocks } = OrderBlockEngine.detectOrderBlocks(candles, [], [], { displacementThresholdAtr: 0.5 });
    expect(allOrderBlocks.filter((ob) => ob.direction === Direction.BULLISH)).toEqual([]);
  });

  it('equal highs are not grouped when price traded through the level between them', () => {
    const candles = Array.from({ length: 14 }, (_, i) => candle(i, 98, 99, 97, 98));
    candles[2] = candle(2, 98, 100, 97, 99); // high 100
    candles[6] = candle(6, 99, 103, 98, 99); // trades through 100
    candles[10] = candle(10, 98, 100.05, 97, 99); // high 100.05
    const swings = [swing(2, StructureType.SWING_HIGH, 100), swing(10, StructureType.SWING_HIGH, 100.05)];
    const { pools } = LiquidityEngine.detectLiquidity(candles, swings);
    expect(pools.some((p) => p.type === LiquidityType.EQUAL_HIGHS)).toBe(false);
    expect(pools.filter((p) => p.type === LiquidityType.BUY_SIDE)).toHaveLength(2);
  });

  it('untouched equal highs are still grouped (full-precision level)', () => {
    const candles = Array.from({ length: 14 }, (_, i) => candle(i, 98, 99, 97, 98));
    candles[2] = candle(2, 98, 100, 97, 99);
    candles[10] = candle(10, 98, 100.05, 97, 99);
    const swings = [swing(2, StructureType.SWING_HIGH, 100), swing(10, StructureType.SWING_HIGH, 100.05)];
    const { pools } = LiquidityEngine.detectLiquidity(candles, swings);
    const eqh = pools.find((p) => p.type === LiquidityType.EQUAL_HIGHS);
    expect(eqh?.priceLevel).toBeCloseTo(100.025, 6);
  });
});
