import { Timeframe } from '@quant/shared';
export declare class GetCandlesDto {
    symbol: string;
    timeframe: Timeframe;
    limit: number;
    from?: string;
    to?: string;
}
export declare class IngestCandlesDto {
    symbol: string;
    timeframe: Timeframe;
    limit: number;
}
