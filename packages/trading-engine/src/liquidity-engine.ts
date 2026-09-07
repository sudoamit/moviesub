import { ICandle, ILiquidityPool, ISwingPoint, LiquidityType, StructureType } from '@quant/shared';
import { calculateATR } from '@quant/indicators';

export interface ILiquidityEngineOptions {
  equalHighLowToleranceAtr?: number;
}

export class LiquidityEngine {
  /**
   * Detects Liquidity Pools (Equal Highs/Lows, BSL, SSL) and Liquidity Sweeps
   */
  static detectLiquidity(
    candles: ICandle[],
    swings: ISwingPoint[],
    options: ILiquidityEngineOptions = {},
  ): { pools: ILiquidityPool[]; sweeps: ILiquidityPool[] } {
    if (!candles || candles.length === 0 || !swings || swings.length === 0) {
      return { pools: [], sweeps: [] };
    }

    const toleranceMult = options.equalHighLowToleranceAtr ?? 0.15;
    const atr = calculateATR(candles, 14);
    const pools: ILiquidityPool[] = [];
    const sweeps: ILiquidityPool[] = [];

    const swingHighs = swings.filter(
      (s) =>
        s.type === StructureType.SWING_HIGH ||
        s.type === StructureType.HIGHER_HIGH ||
        s.type === StructureType.LOWER_HIGH,
    );

    const swingLows = swings.filter(
      (s) =>
        s.type === StructureType.SWING_LOW ||
        s.type === StructureType.HIGHER_LOW ||
        s.type === StructureType.LOWER_LOW,
    );

    const consumedHighIndices = new Set<number>();
    const consumedLowIndices = new Set<number>();

    // 1. Group and detect Equal Highs (EQH) and Buy-Side Liquidity (BSL)
    for (let i = 0; i < swingHighs.length; i++) {
      const h1 = swingHighs[i];
      if (consumedHighIndices.has(h1.index)) continue;

      const candleAtr = atr[h1.index] || Math.max(1, candles[h1.index].high * 0.005);
      const tolerance = candleAtr * toleranceMult;

      let matchedEQH = false;
      for (let j = i + 1; j < swingHighs.length; j++) {
        const h2 = swingHighs[j];
        if (consumedHighIndices.has(h2.index)) continue;

        if (Math.abs(h1.price - h2.price) <= tolerance) {
          const avgLevel = (h1.price + h2.price) / 2;
          pools.push({
            id: `eqh-${h1.index}-${h2.index}`,
            type: LiquidityType.EQUAL_HIGHS,
            priceLevel: avgLevel,
            firstTimestamp: h1.timestamp,
            lastTimestamp: h2.timestamp,
            touchCount: 2,
            isSwept: false,
          });
          consumedHighIndices.add(h1.index);
          consumedHighIndices.add(h2.index);
          matchedEQH = true;
          break;
        }
      }

      if (!matchedEQH) {
        pools.push({
          id: `bsl-${h1.index}`,
          type: LiquidityType.BUY_SIDE,
          priceLevel: h1.price,
          firstTimestamp: h1.timestamp,
          lastTimestamp: h1.timestamp,
          touchCount: 1,
          isSwept: false,
        });
        consumedHighIndices.add(h1.index);
      }
    }

    // 2. Group and detect Equal Lows (EQL) and Sell-Side Liquidity (SSL)
    for (let i = 0; i < swingLows.length; i++) {
      const l1 = swingLows[i];
      if (consumedLowIndices.has(l1.index)) continue;

      const candleAtr = atr[l1.index] || Math.max(1, candles[l1.index].low * 0.005);
      const tolerance = candleAtr * toleranceMult;

      let matchedEQL = false;
      for (let j = i + 1; j < swingLows.length; j++) {
        const l2 = swingLows[j];
        if (consumedLowIndices.has(l2.index)) continue;

        if (Math.abs(l1.price - l2.price) <= tolerance) {
          const avgLevel = (l1.price + l2.price) / 2;
          pools.push({
            id: `eql-${l1.index}-${l2.index}`,
            type: LiquidityType.EQUAL_LOWS,
            priceLevel: avgLevel,
            firstTimestamp: l1.timestamp,
            lastTimestamp: l2.timestamp,
            touchCount: 2,
            isSwept: false,
          });
          consumedLowIndices.add(l1.index);
          consumedLowIndices.add(l2.index);
          matchedEQL = true;
          break;
        }
      }

      if (!matchedEQL) {
        pools.push({
          id: `ssl-${l1.index}`,
          type: LiquidityType.SELL_SIDE,
          priceLevel: l1.price,
          firstTimestamp: l1.timestamp,
          lastTimestamp: l1.timestamp,
          touchCount: 1,
          isSwept: false,
        });
        consumedLowIndices.add(l1.index);
      }
    }

    // 3. Detect Liquidity Sweeps
    for (let c = 0; c < candles.length; c++) {
      const candle = candles[c];

      for (const pool of pools) {
        if (pool.isSwept) continue;
        if (candle.timestamp <= pool.lastTimestamp) continue;

        // BSL / EQH Sweep: High trades above level, but Close finishes BELOW level (rejection wick)
        if (
          (pool.type === LiquidityType.BUY_SIDE || pool.type === LiquidityType.EQUAL_HIGHS) &&
          candle.high > pool.priceLevel &&
          candle.close <= pool.priceLevel
        ) {
          pool.isSwept = true;
          pool.sweptAtIndex = c;
          pool.sweptTimestamp = candle.timestamp;
          pool.sweptPrice = candle.high;
          pool.displacement = candle.high - pool.priceLevel;
          sweeps.push({ ...pool });
        }

        // SSL / EQL Sweep: Low trades below level, but Close finishes ABOVE level (rejection wick)
        if (
          (pool.type === LiquidityType.SELL_SIDE || pool.type === LiquidityType.EQUAL_LOWS) &&
          candle.low < pool.priceLevel &&
          candle.close >= pool.priceLevel
        ) {
          pool.isSwept = true;
          pool.sweptAtIndex = c;
          pool.sweptTimestamp = candle.timestamp;
          pool.sweptPrice = candle.low;
          pool.displacement = pool.priceLevel - candle.low;
          sweeps.push({ ...pool });
        }
      }
    }

    return { pools, sweeps };
  }
}
