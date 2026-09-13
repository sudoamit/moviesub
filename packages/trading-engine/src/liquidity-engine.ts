import { ICandle, ILiquidityPool, ISwingPoint, LiquidityType, StructureType } from '@quant/shared';
import { calculateATR } from '@quant/indicators';

export interface ILiquidityEngineOptions {
  equalHighLowToleranceAtr?: number;
  asOfTimestamp?: Date;
  timeframe?: string;
}

export class LiquidityEngine {
  /**
   * Detects Liquidity Pools (Equal Highs/Lows, BSL, SSL) and Liquidity Sweeps with zero look-ahead bias.
   * A pool is only eligible to be swept AFTER all of its constituent swing points have been fully confirmed.
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

    const lastIndex = candles.length - 1;

    // 1. Group and detect Equal Highs (EQH) and Buy-Side Liquidity (BSL) via multi-touch clustering
    for (let i = 0; i < swingHighs.length; i++) {
      const h1 = swingHighs[i];
      if (consumedHighIndices.has(h1.index)) continue;

      const candleAtr = atr[h1.index] || Math.max(1, candles[h1.index].high * 0.005);
      const tolerance = candleAtr * toleranceMult;

      const cluster: ISwingPoint[] = [h1];
      for (let j = i + 1; j < swingHighs.length; j++) {
        const h2 = swingHighs[j];
        if (consumedHighIndices.has(h2.index)) continue;

        const currentAvg = cluster.reduce((sum, s) => sum + s.price, 0) / cluster.length;
        if (Math.abs(h2.price - currentAvg) <= tolerance) {
          cluster.push(h2);
        }
      }

      if (cluster.length >= 2) {
        const avgLevel = cluster.reduce((sum, s) => sum + s.price, 0) / cluster.length;
        const availableAtIndex = Math.max(...cluster.map((s) => s.confirmedAtIndex));
        const firstTimestamp = cluster[0].timestamp;
        const lastTimestamp = cluster[cluster.length - 1].timestamp;
        const availableAtTimestamp = cluster.reduce(
          (latest, s) =>
            s.confirmedAtTimestamp && s.confirmedAtTimestamp > latest ? s.confirmedAtTimestamp : latest,
          cluster[0].confirmedAtTimestamp || cluster[0].timestamp,
        );

        if (availableAtIndex <= lastIndex) {
          pools.push({
            id: `eqh-${cluster.map((s) => s.index).join('-')}`,
            type: LiquidityType.EQUAL_HIGHS,
            priceLevel: Number(avgLevel.toFixed(2)),
            firstTimestamp,
            lastTimestamp,
            touchCount: cluster.length,
            isSwept: false,
            sweepState: 'UNSWEPT',
            availableAtIndex,
            availableAtTimestamp,
          });
        }
        for (const s of cluster) {
          consumedHighIndices.add(s.index);
        }
      } else {
        const availableAtIndex = h1.confirmedAtIndex;
        const availableAtTimestamp =
          h1.confirmedAtTimestamp || candles[h1.confirmedAtIndex]?.timestamp || h1.timestamp;

        if (availableAtIndex <= lastIndex) {
          pools.push({
            id: `bsl-${h1.index}`,
            type: LiquidityType.BUY_SIDE,
            priceLevel: h1.price,
            firstTimestamp: h1.timestamp,
            lastTimestamp: h1.timestamp,
            touchCount: 1,
            isSwept: false,
            sweepState: 'UNSWEPT',
            availableAtIndex,
            availableAtTimestamp,
          });
        }
        consumedHighIndices.add(h1.index);
      }
    }

    // 2. Group and detect Equal Lows (EQL) and Sell-Side Liquidity (SSL) via multi-touch clustering
    for (let i = 0; i < swingLows.length; i++) {
      const l1 = swingLows[i];
      if (consumedLowIndices.has(l1.index)) continue;

      const candleAtr = atr[l1.index] || Math.max(1, candles[l1.index].low * 0.005);
      const tolerance = candleAtr * toleranceMult;

      const cluster: ISwingPoint[] = [l1];
      for (let j = i + 1; j < swingLows.length; j++) {
        const l2 = swingLows[j];
        if (consumedLowIndices.has(l2.index)) continue;

        const currentAvg = cluster.reduce((sum, s) => sum + s.price, 0) / cluster.length;
        if (Math.abs(l2.price - currentAvg) <= tolerance) {
          cluster.push(l2);
        }
      }

      if (cluster.length >= 2) {
        const avgLevel = cluster.reduce((sum, s) => sum + s.price, 0) / cluster.length;
        const availableAtIndex = Math.max(...cluster.map((s) => s.confirmedAtIndex));
        const firstTimestamp = cluster[0].timestamp;
        const lastTimestamp = cluster[cluster.length - 1].timestamp;
        const availableAtTimestamp = cluster.reduce(
          (latest, s) =>
            s.confirmedAtTimestamp && s.confirmedAtTimestamp > latest ? s.confirmedAtTimestamp : latest,
          cluster[0].confirmedAtTimestamp || cluster[0].timestamp,
        );

        if (availableAtIndex <= lastIndex) {
          pools.push({
            id: `eql-${cluster.map((s) => s.index).join('-')}`,
            type: LiquidityType.EQUAL_LOWS,
            priceLevel: Number(avgLevel.toFixed(2)),
            firstTimestamp,
            lastTimestamp,
            touchCount: cluster.length,
            isSwept: false,
            sweepState: 'UNSWEPT',
            availableAtIndex,
            availableAtTimestamp,
          });
        }
        for (const s of cluster) {
          consumedLowIndices.add(s.index);
        }
      } else {
        const availableAtIndex = l1.confirmedAtIndex;
        const availableAtTimestamp =
          l1.confirmedAtTimestamp || candles[l1.confirmedAtIndex]?.timestamp || l1.timestamp;

        if (availableAtIndex <= lastIndex) {
          pools.push({
            id: `ssl-${l1.index}`,
            type: LiquidityType.SELL_SIDE,
            priceLevel: l1.price,
            firstTimestamp: l1.timestamp,
            lastTimestamp: l1.timestamp,
            touchCount: 1,
            isSwept: false,
            sweepState: 'UNSWEPT',
            availableAtIndex,
            availableAtTimestamp,
          });
        }
        consumedLowIndices.add(l1.index);
      }
    }

    // 3. Detect Liquidity Sweeps (strictly chronologically after availability)
    for (let c = 0; c < candles.length; c++) {
      const candle = candles[c];

      for (const pool of pools) {
        if (pool.isSwept) continue;

        // Enforce availability boundary: candle can only sweep AFTER pool confirmation
        if (pool.availableAtIndex !== undefined) {
          if (c < pool.availableAtIndex) continue;
        } else if (pool.availableAtTimestamp) {
          if (candle.timestamp < pool.availableAtTimestamp) continue;
        } else if (candle.timestamp <= pool.lastTimestamp) {
          continue;
        }

        // BSL / EQH Sweep
        if (pool.type === LiquidityType.BUY_SIDE || pool.type === LiquidityType.EQUAL_HIGHS) {
          if (candle.high > pool.priceLevel) {
            pool.isSwept = true;
            pool.sweptAtIndex = c;
            pool.sweptTimestamp = candle.timestamp;
            pool.sweptPrice = candle.high;
            pool.displacement = candle.high - pool.priceLevel;

            if (candle.close <= pool.priceLevel) {
              pool.sweepState = 'SWEEP_RECLAIMED';
            } else {
              pool.sweepState = 'ACCEPTED_BREAK';
            }
            sweeps.push({ ...pool });
          }
        }

        // SSL / EQL Sweep
        if (pool.type === LiquidityType.SELL_SIDE || pool.type === LiquidityType.EQUAL_LOWS) {
          if (candle.low < pool.priceLevel) {
            pool.isSwept = true;
            pool.sweptAtIndex = c;
            pool.sweptTimestamp = candle.timestamp;
            pool.sweptPrice = candle.low;
            pool.displacement = pool.priceLevel - candle.low;

            if (candle.close >= pool.priceLevel) {
              pool.sweepState = 'SWEEP_RECLAIMED';
            } else {
              pool.sweepState = 'ACCEPTED_BREAK';
            }
            sweeps.push({ ...pool });
          }
        }
      }
    }

    return { pools, sweeps };
  }
}

