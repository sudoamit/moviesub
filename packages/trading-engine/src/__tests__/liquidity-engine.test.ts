import { LiquidityEngine } from '../liquidity-engine';
import { ICandle, ISwingPoint, LiquidityType, StructureType } from '@quant/shared';

describe('LiquidityEngine', () => {
  it('should detect Equal Highs and sweeps of buy-side liquidity', () => {
    const swings: ISwingPoint[] = [
      { index: 2, type: StructureType.SWING_HIGH, price: 100.0, timestamp: new Date(2000), confirmedAtIndex: 4, confirmedAtTimestamp: new Date(4000) },
      { index: 6, type: StructureType.SWING_HIGH, price: 100.1, timestamp: new Date(6000), confirmedAtIndex: 8, confirmedAtTimestamp: new Date(8000) }, // Near equal high
    ];

    const candles: ICandle[] = [
      { timestamp: new Date(1000), open: 90, high: 95, low: 88, close: 92, volume: 100 },
      { timestamp: new Date(2000), open: 92, high: 100.0, low: 90, close: 95, volume: 100 },
      { timestamp: new Date(3000), open: 95, high: 97, low: 90, close: 92, volume: 100 },
      { timestamp: new Date(4000), open: 92, high: 94, low: 89, close: 91, volume: 100 },
      { timestamp: new Date(5000), open: 91, high: 96, low: 90, close: 95, volume: 100 },
      { timestamp: new Date(6000), open: 95, high: 100.1, low: 92, close: 96, volume: 100 },
      { timestamp: new Date(7000), open: 96, high: 98, low: 93, close: 94, volume: 100 },
      { timestamp: new Date(8000), open: 94, high: 96, low: 91, close: 93, volume: 100 },
      { timestamp: new Date(9000), open: 93, high: 102.5, low: 92, close: 98.0, volume: 500 }, // Sweep: pierces 100.05 but closes at 98.0
    ];

    const { pools, sweeps } = LiquidityEngine.detectLiquidity(candles, swings, { equalHighLowToleranceAtr: 0.2 });

    expect(pools.length).toBeGreaterThanOrEqual(1);
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0].sweptPrice).toBe(102.5);
    expect(sweeps[0].isSwept).toBe(true);
  });
});
