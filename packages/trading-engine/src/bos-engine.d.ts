import { BOSConfirmationType, IBreakOfStructure, ICandle, ISwingPoint } from '@quant/shared';
export interface IBOSEngineOptions {
    confirmationType?: BOSConfirmationType;
    displacementThresholdAtr?: number;
}
export declare class BOSEngine {
    /**
     * Detects valid Bullish and Bearish Breaks of Structure (BOS)
     */
    static detectBOS(candles: ICandle[], swings: ISwingPoint[], options?: IBOSEngineOptions): IBreakOfStructure[];
}
