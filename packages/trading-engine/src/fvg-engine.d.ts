import { IFairValueGap, ICandle } from '@quant/shared';
export interface IFVGEngineOptions {
    minGapAtrMultiplier?: number;
    asOfTimestamp?: Date;
    timeframe?: string;
}
export declare class FVGEngine {
    /**
     * Detects 3-candle Fair Value Gaps (imbalances) and tracks point-in-time mitigation/fill percentage.
     * State is evaluated strictly chronologically up to asOfTimestamp without look-ahead bias.
     */
    static detectFVGs(rawCandles: ICandle[], options?: IFVGEngineOptions): {
        allFVGs: IFairValueGap[];
        activeFVGs: IFairValueGap[];
    };
}
