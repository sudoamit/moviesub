import { ICandle } from '@quant/shared';
export interface ILiquidityHeatBand {
    priceLevel: number;
    type: 'BSL_HEAT' | 'SSL_HEAT';
    densityScore: number;
    intensityColor: string;
    touchCount: number;
    label: string;
    minPrice: number;
    maxPrice: number;
}
export interface ILiquidityHeatmapResult {
    symbol: string;
    currentPrice: number;
    totalRestingLiquidityScore: number;
    topBSLClusters: ILiquidityHeatBand[];
    topSSLClusters: ILiquidityHeatBand[];
    heatBands: ILiquidityHeatBand[];
}
export declare class LiquidityHeatmapEngine {
    /**
     * Generates institutional resting liquidity heatmap density bands
     */
    static compute(candles: ICandle[], tolerancePct?: number): ILiquidityHeatmapResult;
}
