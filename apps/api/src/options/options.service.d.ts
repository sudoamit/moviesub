import { PrismaService } from '../common/prisma/prisma.service';
import { IExpiryInfo } from '@quant/trading-engine';
export interface IOptionGreekDetails {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    rho: number;
}
export interface IOptionContractDetails {
    symbol: string;
    ltp: number;
    change: number;
    changePercent: number;
    oi: number;
    oiChange: number;
    volume: number;
    iv: number;
    intrinsicValue: number;
    timeValue: number;
    delta: number;
    theta: number;
    gamma: number;
    vega: number;
    gex?: number;
}
export interface IOptionStrikeData {
    strikePrice: number;
    isATM: boolean;
    netGex?: number;
    call: IOptionContractDetails;
    put: IOptionContractDetails;
}
export interface IOptionChainResponse {
    symbol: string;
    spotPrice: number;
    atmStrike: number;
    selectedExpiry: string;
    daysToExpiry: number;
    availableExpiries: IExpiryInfo[];
    pcr: number;
    maxPain: number;
    gammaFlipLevel?: number;
    netGammaExposure?: number;
    totalCallOI: number;
    totalPutOI: number;
    expectedWeeklyMovePts: number;
    expectedRange: {
        lower: number;
        upper: number;
    };
    lotSize: number;
    strikes: IOptionStrikeData[];
}
export interface ISmartOptionRecommendation {
    underlyingSymbol: string;
    direction: 'BULLISH' | 'BEARISH';
    recommendedStrike: number;
    optionType: 'CE' | 'PE';
    contractName: string;
    isATM: boolean;
    spotPrice: number;
    expiryLabel: string;
    daysToExpiry: number;
    optionLtp: number;
    optionStopLoss: number;
    optionTarget1: number;
    optionTarget2: number;
    delta: number;
    theta: number;
    iv: number;
    lotSize: number;
    riskAmountPerLot: number;
    expectedProfitPerLot: number;
    roiPercent: number;
}
export declare class OptionsService {
    private readonly prisma;
    private readonly logger;
    private liveChainCache;
    constructor(prisma: PrismaService);
    /**
     * Fetches real-time live Option Chain directly from NSE Exchange API with 2-second in-memory cache
     */
    private fetchLiveNSEChain;
    /**
     * Generates Option Chain using direct Real-Time Live NSE Quotes with Black-Scholes Greeks fallback
     */
    getOptionChain(symbol?: string, targetExpiryDate?: string, spotPriceOverride?: number): Promise<IOptionChainResponse>;
    getSmartOptionRecommendation(symbol: string, direction: 'BULLISH' | 'BEARISH', spotTarget?: number, spotStopLoss?: number, targetExpiryDate?: string, spotPriceOverride?: number, strikeOverride?: number): Promise<ISmartOptionRecommendation>;
    getSmartStrikeRecommendation(symbol: string, direction: 'BULLISH' | 'BEARISH', spotTarget?: number, spotStopLoss?: number, targetExpiryDate?: string, spotPriceOverride?: number, strikeOverride?: number): Promise<ISmartOptionRecommendation>;
}
