export interface IMacroEvent {
    id: string;
    title: string;
    category: 'CENTRAL_BANK' | 'INFLATION' | 'EARNINGS' | 'EMPLOYMENT';
    country: 'INDIA' | 'USA' | 'GLOBAL';
    scheduledTime: string;
    impact: 'HIGH' | 'MEDIUM' | 'LOW';
    actual?: string;
    forecast?: string;
    previous?: string;
    affectedInstruments: string[];
    advisoryNote: string;
}
export interface IVIXRegime {
    currentVIX: number;
    changePercent: number;
    regime: 'LOW_VOLATILITY_TREND' | 'NORMAL_VOLATILITY_SMC' | 'HIGH_VOLATILITY_EXPANSION' | 'EXTREME_RISK_SPIKE';
    recommendedStrategy: string;
    stopLossBufferMultiplier: number;
    positionSizingMultiplier: number;
    updatedAt: string;
}
export declare class MacroEventsService {
    private readonly logger;
    private events;
    constructor();
    getCalendar(): Promise<{
        events: IMacroEvent[];
        highImpactCount: number;
    }>;
    getVIXRegime(): Promise<IVIXRegime>;
}
