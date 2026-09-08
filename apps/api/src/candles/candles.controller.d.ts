import { CandlesService, ICandlesResponse, IChartDataResponse } from './candles.service';
import { GetCandlesDto, IngestCandlesDto } from './dto/get-candles.dto';
import { ICandle, Timeframe } from '@quant/shared';
export declare class CandlesController {
    private readonly candlesService;
    constructor(candlesService: CandlesService);
    getCandles(query: GetCandlesDto): Promise<ICandlesResponse>;
    getChartData(symbol?: string, timeframe?: Timeframe, limit?: number): Promise<IChartDataResponse>;
    getLatestCandle(symbol: string, timeframe?: Timeframe): Promise<ICandle>;
    ingestCandles(body: IngestCandlesDto): Promise<import("../market-data/market-data.service").IIngestionSummary>;
}
