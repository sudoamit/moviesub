import { Direction, MarketRegimeType, SignalGrade, Timeframe } from '../enums';
export declare class FilterScannerDto {
    timeframe?: Timeframe;
    direction?: Direction;
    minGrade?: SignalGrade;
    minScore?: number;
    regime?: MarketRegimeType;
}
export declare class RunBacktestDto {
    instrumentId: string;
    timeframe: Timeframe;
    startDate: string;
    endDate: string;
    initialCapital: number;
    riskPerTradePercent: number;
    minScore?: number;
    strategyConfig?: Record<string, any>;
}
export declare class CreateAlertDto {
    channel: string;
    target: string;
    minScore?: number;
    minGrade?: SignalGrade;
}
export declare class CreateStrategyDto {
    name: string;
    description?: string;
    isDefault?: boolean;
    configJson: Record<string, any>;
}
//# sourceMappingURL=index.d.ts.map