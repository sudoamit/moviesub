import { ICandle, ISignalSetup, MTFMode, Timeframe } from '@quant/shared';
export interface IGenerateSignalOptions {
    symbol: string;
    executionCandles: ICandle[];
    executionTimeframe?: Timeframe | string;
    htf1Candles?: ICandle[];
    htf1Timeframe?: Timeframe | string;
    htf2Candles?: ICandle[];
    htf2Timeframe?: Timeframe | string;
    mtfMode?: MTFMode;
    strategyMode?: 'SMC' | 'SAIYAN_OCC' | 'HYBRID';
    asOfTimestamp?: Date;
}
export declare class SignalGenerator {
    /**
     * Generates analytical LONG / SHORT / NO_TRADE signal setup with full scoring, levels, and rationale
     * with strictly zero look-ahead bias.
     */
    static generateSignal(options: IGenerateSignalOptions): ISignalSetup;
    private static createNoTradeSignal;
}
