import { ICandle, IMarketRegime, ISwingPoint } from '@quant/shared';
export declare class MarketRegimeEngine {
    /**
     * Deterministically classifies the market regime using ADX, ATR, EMAs, and Price Structure.
     * NO LLM / AI hallucination used.
     */
    static classifyRegime(candles: ICandle[], swings?: ISwingPoint[]): IMarketRegime;
}
