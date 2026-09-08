import { CandlesService } from '../candles/candles.service';
import { Timeframe } from '@quant/shared';
export declare class SMCService {
    private readonly candlesService;
    private readonly logger;
    constructor(candlesService: CandlesService);
    getSMCAnalysis(symbol: string, timeframe?: Timeframe, limit?: number): Promise<{
        symbol: string;
        timeframe: string;
        candlesCount: number;
        swingPoints: import("@quant/shared").ISwingPoint[];
        confirmedSwingHighs: import("@quant/shared").ISwingPoint[];
        confirmedSwingLows: import("@quant/shared").ISwingPoint[];
        breaksOfStructure: import("@quant/shared").IBreakOfStructure[];
        changesOfCharacter: import("@quant/shared").IChangeOfCharacter[];
        liquidityPools: import("@quant/shared").ILiquidityPool[];
        liquiditySweeps: import("@quant/shared").ILiquidityPool[];
        fairValueGaps: import("@quant/shared").IFairValueGap[];
        activeFVGs: import("@quant/shared").IFairValueGap[];
        orderBlocks: import("@quant/shared").IOrderBlock[];
        activeOrderBlocks: import("@quant/shared").IOrderBlock[];
        dealingRange: import("@quant/shared").IDealingRange | null;
        marketRegime: import("@quant/shared").IMarketRegime;
        currentTrend: import("@quant/shared").Direction;
    }>;
    getMarketStructure(symbol: string, timeframe?: Timeframe): Promise<{
        symbol: string;
        timeframe: string;
        swingPoints: import("@quant/shared").ISwingPoint[];
        breaksOfStructure: import("@quant/shared").IBreakOfStructure[];
        changesOfCharacter: import("@quant/shared").IChangeOfCharacter[];
        currentTrend: import("@quant/shared").Direction;
    }>;
    getLiquidity(symbol: string, timeframe?: Timeframe): Promise<{
        symbol: string;
        timeframe: string;
        liquidityPools: import("@quant/shared").ILiquidityPool[];
        liquiditySweeps: import("@quant/shared").ILiquidityPool[];
    }>;
    getFairValueGaps(symbol: string, timeframe?: Timeframe): Promise<{
        symbol: string;
        timeframe: string;
        fairValueGaps: import("@quant/shared").IFairValueGap[];
    }>;
    getFVG(symbol: string, timeframe?: Timeframe): Promise<{
        symbol: string;
        timeframe: string;
        fairValueGaps: import("@quant/shared").IFairValueGap[];
    }>;
    getOrderBlocks(symbol: string, timeframe?: Timeframe): Promise<{
        symbol: string;
        timeframe: string;
        orderBlocks: import("@quant/shared").IOrderBlock[];
    }>;
    getMarketRegime(symbol: string, timeframe?: Timeframe): Promise<{
        symbol: string;
        timeframe: string;
        regime: import("@quant/shared").IMarketRegime;
        marketRegime: import("@quant/shared").IMarketRegime;
    }>;
}
