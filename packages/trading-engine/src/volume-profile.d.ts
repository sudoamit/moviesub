import { ICandle } from '@quant/shared';
export interface IVolumeProfileBin {
    priceLevel: number;
    totalVolume: number;
    buyVolume: number;
    sellVolume: number;
    delta: number;
}
export interface IVolumeProfileResult {
    poc: number;
    vah: number;
    val: number;
    totalVolume: number;
    bins: IVolumeProfileBin[];
    cvd: {
        timestamp: string;
        delta: number;
        cumulativeDelta: number;
    }[];
}
export declare class VolumeProfileAnalyzer {
    /**
     * Computes Volume Profile and Cumulative Volume Delta (CVD) across given candlestick history
     * @param candles Array of clean candlesticks
     * @param binCount Number of price distribution bins (default 30)
     * @param valueAreaPercentage Percentage of volume for value area (default 70%)
     */
    static compute(candles: ICandle[], binCount?: number, valueAreaPercentage?: number): IVolumeProfileResult | null;
}
