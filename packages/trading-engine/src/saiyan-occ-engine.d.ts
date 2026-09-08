import { Direction, ICandle, ISignalSetup, SignalGrade } from '@quant/shared';
export interface ISaiyanOCCConfig {
    basisType: 'ALMA' | 'HullMA' | 'TEMA' | 'EMA' | 'SMA';
    basisLen: number;
    offsetSigma: number;
    offsetALMA: number;
    intRes: number;
    swingLength: number;
    boxWidth: number;
    historyToKeep: number;
    tp1Percent: number;
    tp1Qty: number;
    tp2Percent: number;
    tp2Qty: number;
    tp3Percent: number;
    tp3Qty: number;
    slPercent: number;
}
export interface ISaiyanSupplyDemandBox {
    id: string;
    type: 'SUPPLY' | 'DEMAND' | 'BOS';
    top: number;
    bottom: number;
    poi: number;
    startIndex: number;
    endIndex: number;
    isBroken: boolean;
}
export interface ISaiyanOCCResult {
    direction: Direction;
    isLongTrigger: boolean;
    isShortTrigger: boolean;
    triggerTimestamp: Date;
    openSeriesAlt: number[];
    closeSeriesAlt: number[];
    currentCloseAlt: number;
    currentOpenAlt: number;
    supplyBoxes: ISaiyanSupplyDemandBox[];
    demandBoxes: ISaiyanSupplyDemandBox[];
    bosBoxes: ISaiyanSupplyDemandBox[];
    entryPrice: number;
    stopLoss: number;
    tp1: number;
    tp2: number;
    tp3: number;
    signalScore: number;
    signalGrade: SignalGrade;
}
export declare class SaiyanOCCEngine {
    static readonly DEFAULT_CONFIG: ISaiyanOCCConfig;
    /**
     * Arnaud Legoux Moving Average (ALMA)
     * Exact PineScript formula:
     * m = offsetALMA * (len - 1)
     * s = len / offsetSigma
     * w_i = exp(-((i - m)^2) / (2 * s^2))
     */
    static calculateALMA(src: number[], len: number, offset?: number, sigma?: number): number[];
    /**
     * Weighted Moving Average (WMA)
     */
    static calculateWMA(src: number[], len: number): number[];
    /**
     * Hull Moving Average (HullMA = WMA(2*WMA(n/2) - WMA(n), sqrt(n)))
     */
    static calculateHullMA(src: number[], len: number): number[];
    /**
     * Moving Average Variant selector matching PineScript variant()
     */
    static calculateVariant(type: 'ALMA' | 'HullMA' | 'TEMA' | 'EMA' | 'SMA', src: number[], len: number, sigma?: number, almaOffset?: number): number[];
    /**
     * Alternate Resolution Smoothing Simulator (intRes = 8)
     */
    static smoothAlternateResolution(series: number[], factor?: number): number[];
    /**
     * Full PineScript Strategy Execution Engine
     */
    static analyze(candles: ICandle[], config?: Partial<ISaiyanOCCConfig>): ISaiyanOCCResult;
    /**
     * Convert Saiyan OCC analysis into a unified ISignalSetup
     */
    static generateSignal(symbol: string, candles: ICandle[], timeframe?: string): ISignalSetup;
}
