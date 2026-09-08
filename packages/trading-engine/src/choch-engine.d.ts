import { ICandle, IChangeOfCharacter, ISwingPoint } from '@quant/shared';
export declare class CHOCHEngine {
    /**
     * Detects market structure trend reversals (Change of Character) with strictly zero look-ahead bias.
     * A CHOCH occurs when price breaks the structural pivot of an opposing established trend:
     * - Bullish CHOCH: In a Bearish trend, price breaks above the most recent confirmed Lower High (or Swing High).
     * - Bearish CHOCH: In a Bullish trend, price breaks below the most recent confirmed Higher Low (or Swing Low).
     */
    static detectCHOCH(candles: ICandle[], swings: ISwingPoint[]): IChangeOfCharacter[];
}
