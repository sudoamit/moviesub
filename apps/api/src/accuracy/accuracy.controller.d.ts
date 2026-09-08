import { AccuracyService } from './accuracy.service';
export declare class AccuracyController {
    private readonly accuracyService;
    constructor(accuracyService: AccuracyService);
    getSessionInfo(symbol?: string): import("@quant/trading-engine").ISessionInfo;
    getSMTDivergence(assetA?: string, assetB?: string, timeframe?: string): Promise<import("@quant/trading-engine").ISMTDivergenceResult>;
    getSMTMultiTimeframe(assetA?: string, assetB?: string): Promise<{
        assetA: string;
        assetB: string;
        primary: {
            assetA: string;
            assetB: string;
            divergenceType: import("@quant/trading-engine").SMTType;
            convictionScore: number;
            assetASwing: {
                type: "HIGH" | "LOW";
                price1: number;
                price2: number;
                trend: "HH" | "LH" | "LL" | "HL";
            };
            assetBSwing: {
                type: "HIGH" | "LOW";
                price1: number;
                price2: number;
                trend: "HH" | "LH" | "LL" | "HL";
            };
            narrative: string;
            actionableSignal: "STRONG_BUY" | "STRONG_SELL" | "NO_DIVERGENCE";
            timestamp: string;
            timeframe: string;
        };
        divergenceConfluenceCount: number;
        timeframeResults: {
            assetA: string;
            assetB: string;
            divergenceType: import("@quant/trading-engine").SMTType;
            convictionScore: number;
            assetASwing: {
                type: "HIGH" | "LOW";
                price1: number;
                price2: number;
                trend: "HH" | "LH" | "LL" | "HL";
            };
            assetBSwing: {
                type: "HIGH" | "LOW";
                price1: number;
                price2: number;
                trend: "HH" | "LH" | "LL" | "HL";
            };
            narrative: string;
            actionableSignal: "STRONG_BUY" | "STRONG_SELL" | "NO_DIVERGENCE";
            timestamp: string;
            timeframe: string;
        }[];
        timestamp: string;
    }>;
    getMTFFlowRadar(symbol?: string): Promise<import("@quant/trading-engine").IMTFFlowRadarResult>;
    getDynamicTrailing(entryPrice: string, stopLoss: string, tp1: string, tp2: string, currentPrice: string, direction?: 'BULLISH' | 'BEARISH'): import("@quant/trading-engine").IDynamicTrailingState;
    getLiquidityHeatmap(symbol?: string): Promise<import("@quant/trading-engine").ILiquidityHeatmapResult>;
}
