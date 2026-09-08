import { ICandle } from '@quant/shared';
export interface IBacktestMarketData {
    executionCandles: ICandle[];
    htf1Candles?: ICandle[];
    htf2Candles?: ICandle[];
    executionTimeframe: string;
    htf1Timeframe?: string;
    htf2Timeframe?: string;
}
export declare class MarketDataRouter {
    private executionCandles;
    private htf1Candles;
    private htf2Candles;
    private executionTimeframe;
    private htf1Timeframe;
    private htf2Timeframe;
    constructor(data: IBacktestMarketData);
    private normalizeAndSort;
    private getDurationMs;
    /**
     * Returns market data slice available strictly AT OR BEFORE simulation timestamp T.
     * Higher timeframe candles that close after T are strictly excluded to eliminate lookahead bias.
     */
    getAvailableMarketDataAt(currentExecutionIndex: number): {
        executionSlice: ICandle[];
        htf1Slice: ICandle[];
        htf2Slice: ICandle[];
        currentCandle: ICandle;
        timestamp: number;
    };
    getTotalBars(): number;
    getExecutionCandles(): ICandle[];
}
