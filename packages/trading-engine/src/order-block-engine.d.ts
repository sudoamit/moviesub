import { IBreakOfStructure, ICandle, IFairValueGap, IOrderBlock } from '@quant/shared';
export interface IOrderBlockOptions {
    displacementThresholdAtr?: number;
    asOfTimestamp?: Date;
    timeframe?: string;
}
export declare class OrderBlockEngine {
    /**
     * Identifies institutional Order Blocks preceding structure breaks and displacement legs
     * with strictly zero look-ahead bias and explicit point-in-time lifecycles.
     */
    static detectOrderBlocks(rawCandles: ICandle[], bosList?: IBreakOfStructure[], fvgList?: IFairValueGap[], options?: IOrderBlockOptions): {
        allOrderBlocks: IOrderBlock[];
        activeOrderBlocks: IOrderBlock[];
    };
}
