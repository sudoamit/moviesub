import { ICandle } from '@quant/shared';
export interface ITierStatus {
    timeframe: '4h' | '1h' | '15m' | '5m';
    name: string;
    direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    score: number;
    keyFactor: string;
}
export interface IMTFFlowRadarResult {
    symbol: string;
    alignmentScore: number;
    totalScore: number;
    overallBias: 'STRONG_BULLISH' | 'STRONG_BEARISH' | 'NEUTRAL_MIXED';
    tradePermission: 'STRONG_BUY_AUTHORIZED' | 'STRONG_SELL_AUTHORIZED' | 'CAUTION_MIXED_FLOW' | 'TRADE_PROHIBITED';
    tiers: {
        h4: ITierStatus;
        h1: ITierStatus;
        m15: ITierStatus;
        m5: ITierStatus;
    };
    narrative: string;
    timestamp: string;
}
export declare class MTFFlowRadarEngine {
    /**
     * Computes 4-Tier Multi-Timeframe Institutional Order Flow Confluence
     */
    static analyze(symbol: string, candles4h?: ICandle[], candles1h?: ICandle[], candles15m?: ICandle[], candles5m?: ICandle[]): IMTFFlowRadarResult;
}
