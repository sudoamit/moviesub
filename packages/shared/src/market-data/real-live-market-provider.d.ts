import { ICandle, IMarketDataProvider } from '../interfaces';
import { Timeframe } from '../enums';
export declare class RealLiveMarketDataProvider implements IMarketDataProvider {
    readonly providerName = "RealLiveMarketDataProvider";
    private static readonly SYMBOL_MAP;
    /**
     * Fetches real historical candles directly from Yahoo Finance and Binance public APIs
     */
    getHistoricalCandles(symbol: string, timeframe: Timeframe | string, limit?: number, endTime?: Date): Promise<ICandle[]>;
    getLatestCandle(symbol: string, timeframe: Timeframe | string): Promise<ICandle>;
    subscribeToMarketData(symbol: string, timeframe: Timeframe | string, onCandle: (candle: ICandle) => void): Promise<void>;
    unsubscribeFromMarketData(symbol: string, timeframe: Timeframe | string): Promise<void>;
    private fetchBinanceCandles;
    private fetchYahooCandles;
    private mapTimeframeToBinance;
    private mapTimeframeToYahoo;
    private getRangeForTimeframe;
}
