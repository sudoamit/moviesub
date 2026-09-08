import { ICandle, Timeframe } from '@quant/shared';
import { InstrumentIdentity, PointInTimeMarketSnapshot } from './quant-types';
export interface IBuildSnapshotOptions {
    symbol: string;
    executionCandles: ICandle[];
    executionTimeframe?: Timeframe | string;
    htf1Candles?: ICandle[];
    htf1Timeframe?: Timeframe | string;
    htf2Candles?: ICandle[];
    htf2Timeframe?: Timeframe | string;
    asOfTimestamp?: Date;
    instrument?: Partial<InstrumentIdentity>;
}
export declare class SnapshotBuilder {
    /**
     * Constructs a canonical, immutable PointInTimeMarketSnapshot without lookahead.
     */
    static buildSnapshot(options: IBuildSnapshotOptions): PointInTimeMarketSnapshot;
}
