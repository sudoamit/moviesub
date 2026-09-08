import { ICandle, ILiquidityPool, ISwingPoint } from '@quant/shared';
export interface ILiquidityEngineOptions {
    equalHighLowToleranceAtr?: number;
}
export declare class LiquidityEngine {
    /**
     * Detects Liquidity Pools (Equal Highs/Lows, BSL, SSL) and Liquidity Sweeps with zero look-ahead bias.
     * A pool is only eligible to be swept AFTER all of its constituent swing points have been fully confirmed.
     */
    static detectLiquidity(candles: ICandle[], swings: ISwingPoint[], options?: ILiquidityEngineOptions): {
        pools: ILiquidityPool[];
        sweeps: ILiquidityPool[];
    };
}
