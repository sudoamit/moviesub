export declare class MarketDataUnavailableError extends Error {
    readonly symbol: string;
    readonly reason: string;
    readonly sourceTimestamp?: Date;
    constructor(symbol: string, reason?: string, sourceTimestamp?: Date);
}
export declare class StaleMarketDataError extends Error {
    readonly symbol: string;
    readonly ageSeconds: number;
    readonly maxAllowedSeconds: number;
    readonly sourceTimestamp: Date;
    constructor(symbol: string, ageSeconds: number, maxAllowedSeconds: number, sourceTimestamp: Date);
}
