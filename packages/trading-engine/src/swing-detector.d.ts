import { ICandle, ISwingPoint } from '@quant/shared';
export interface ISwingDetectorOptions {
    leftBars?: number;
    rightBars?: number;
    minDistanceAtrMultiplier?: number;
}
export declare class SwingDetector {
    /**
     * Detects and classifies structural swings with strictly zero look-ahead bias.
     * A swing at index i is ONLY confirmed at index i + rightBars.
     */
    static detectSwings(candles: ICandle[], options?: ISwingDetectorOptions): ISwingPoint[];
}
