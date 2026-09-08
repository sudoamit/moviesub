import { AlternativeDataState } from './quant-types';
export interface IAlternativeDataInputs {
    symbol: string;
    indiaVix?: number;
    putCallRatio?: number;
    openInterestChangePct?: number;
    marketAdvanceDeclineRatio?: number;
    cryptoFundingRate?: number;
    cryptoOpenInterest?: number;
    btcDominance?: number;
    timestamp?: Date;
}
export declare class AlternativeDataEngine {
    private static cachedData;
    /**
     * Registers latest alternative market data feed for a symbol.
     */
    static updateData(inputs: IAlternativeDataInputs): AlternativeDataState;
    /**
     * Retrieves alternative market data for a symbol with staleness checking (30 minute TTL).
     */
    static getData(symbol: string, asOfTimestamp?: Date, maxLatencyMs?: number): AlternativeDataState;
}
