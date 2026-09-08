import { Direction, IBreakOfStructure, ICandle, IChangeOfCharacter, IDealingRange, IFairValueGap, ILiquidityPool, IMarketRegime, IOrderBlock, ISwingPoint, Timeframe } from '@quant/shared';
export interface PointInTimeContext {
    asOfTimestamp: Date;
    executionTimeframe: Timeframe | string;
    executionCandles: ICandle[];
    htf1Candles?: ICandle[];
    htf1Timeframe?: Timeframe | string;
    htf2Candles?: ICandle[];
    htf2Timeframe?: Timeframe | string;
}
export interface ISMCAnalysisConfig {
    asOfTimestamp?: Date;
    timeframe?: Timeframe | string;
    swingLeftBars?: number;
    swingRightBars?: number;
    minSwingDistanceAtrMultiplier?: number;
    displacementThresholdAtr?: number;
    equalHighLowToleranceAtr?: number;
    fvgMinGapAtr?: number;
}
export interface ISMCAnalysisResult {
    symbol?: string;
    timeframe?: string;
    candlesCount: number;
    swingPoints: ISwingPoint[];
    confirmedSwingHighs: ISwingPoint[];
    confirmedSwingLows: ISwingPoint[];
    breaksOfStructure: IBreakOfStructure[];
    changesOfCharacter: IChangeOfCharacter[];
    liquidityPools: ILiquidityPool[];
    liquiditySweeps: ILiquidityPool[];
    fairValueGaps: IFairValueGap[];
    activeFVGs: IFairValueGap[];
    orderBlocks: IOrderBlock[];
    activeOrderBlocks: IOrderBlock[];
    dealingRange: IDealingRange | null;
    marketRegime: IMarketRegime;
    currentTrend: Direction;
}
