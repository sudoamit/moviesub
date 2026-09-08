import { ICandle } from '@quant/shared';
export type PriceSource = 'close' | 'open' | 'high' | 'low' | 'hl2' | 'hlc3' | 'ohlc4';
export declare function extractPrices(candles: ICandle[], source?: PriceSource): number[];
export interface IADXResult {
    adx: (number | null)[];
    plusDI: (number | null)[];
    minusDI: (number | null)[];
}
export interface IBollingerBandsResult {
    upper: (number | null)[];
    middle: (number | null)[];
    lower: (number | null)[];
    bandwidth: (number | null)[];
    percentB: (number | null)[];
}
export interface IIndicatorSummary {
    ema9: number | null;
    ema20: number | null;
    ema50: number | null;
    ema200: number | null;
    sma20: number | null;
    sma50: number | null;
    rsi14: number | null;
    atr14: number | null;
    adx14: number | null;
    plusDI: number | null;
    minusDI: number | null;
    bollingerUpper: number | null;
    bollingerMiddle: number | null;
    bollingerLower: number | null;
    vwap: number | null;
}
