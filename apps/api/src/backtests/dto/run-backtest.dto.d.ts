import { Timeframe } from '@quant/shared';
export declare class RunBacktestDto {
    symbol: string;
    timeframe?: Timeframe;
    initialCapital?: number;
    riskPerTradePercent?: number;
    minScore?: number;
    limit?: number;
}
