import { ICandle } from '@quant/shared';
export type SMTType = 'BULLISH_SMT' | 'BEARISH_SMT' | 'NEUTRAL';
export interface ISMTDivergenceResult {
    assetA: string;
    assetB: string;
    divergenceType: SMTType;
    convictionScore: number;
    assetASwing: {
        type: 'HIGH' | 'LOW';
        price1: number;
        price2: number;
        trend: 'HH' | 'LH' | 'LL' | 'HL';
    };
    assetBSwing: {
        type: 'HIGH' | 'LOW';
        price1: number;
        price2: number;
        trend: 'HH' | 'LH' | 'LL' | 'HL';
    };
    narrative: string;
    actionableSignal: 'STRONG_BUY' | 'STRONG_SELL' | 'NO_DIVERGENCE';
    timestamp: string;
}
export declare class SMTDivergenceEngine {
    /**
     * Detects Smart Money Technique (SMT) Correlation Divergence between two correlated assets
     */
    static analyze(assetASymbol: string, candlesA: ICandle[], assetBSymbol: string, candlesB: ICandle[], lookback?: number): ISMTDivergenceResult;
}
