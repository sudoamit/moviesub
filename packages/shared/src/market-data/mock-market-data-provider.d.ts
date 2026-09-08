import { ICandle, IMarketDataProvider } from '../interfaces';
import { Timeframe } from '../enums';
export interface IMockProviderConfig {
    seed?: number;
    disconnectProbability?: number;
}
export declare class MockMarketDataProvider implements IMarketDataProvider {
    readonly providerName = "MockMarketDataProvider";
    private subscriptions;
    private listeners;
    private isConnected;
    private seed;
    private static readonly INSTRUMENT_PROFILES;
    constructor(config?: IMockProviderConfig);
    private pseudoRandom;
    private getProfile;
    getHistoricalCandles(symbol: string, timeframe: Timeframe | string, limit?: number, endTime?: Date): Promise<ICandle[]>;
    getLatestCandle(symbol: string, timeframe: Timeframe | string): Promise<ICandle>;
    subscribeToMarketData(symbol: string, timeframe: Timeframe | string, onCandle: (candle: ICandle) => void): Promise<void>;
    unsubscribeFromMarketData(symbol: string, timeframe: Timeframe | string): Promise<void>;
    simulateDisconnect(): void;
    simulateReconnect(): void;
    getIsConnected(): boolean;
}
