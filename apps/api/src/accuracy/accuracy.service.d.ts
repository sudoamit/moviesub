import { PrismaService } from '../common/prisma/prisma.service';
import { ISessionInfo, ISMTDivergenceResult, IMTFFlowRadarResult, ILiquidityHeatmapResult, IDynamicTrailingState } from '@quant/trading-engine';
export declare class AccuracyService {
    private readonly prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    /**
     * 1. Get Live Active ICT Session & Kill Zone Info
     */
    getSessionInfo(symbol?: string): ISessionInfo;
    /**
     * Helper to fetch parsed candles for an instrument
     */
    private getCandlesForInstrument;
    /**
     * 2. SMT (Smart Money Technique) Correlation Divergence Engine
     */
    getSMTDivergence(assetA?: string, assetB?: string, timeframe?: string): Promise<ISMTDivergenceResult>;
    /**
     * 2b. Multi-Timeframe SMT Divergence Heatmap Matrix (1m -> 5m -> 15m -> 1h -> 4h -> 1d)
     */
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
    /**
     * 3. Multi-Timeframe 4-Tier Order Flow Confluence Radar (4h -> 1h -> 15m -> 5m)
     */
    getMTFFlowRadar(symbol?: string): Promise<IMTFFlowRadarResult>;
    /**
     * 4. Dynamic Breakeven & Auto-Trailing Stop Engine
     */
    getDynamicTrailingState(entryPrice: number, stopLoss: number, tp1: number, tp2: number, currentPrice: number, direction?: 'BULLISH' | 'BEARISH', atr?: number): IDynamicTrailingState;
    /**
     * 5. Institutional Liquidity Heatmap
     */
    getLiquidityHeatmap(symbol?: string): Promise<ILiquidityHeatmapResult>;
}
