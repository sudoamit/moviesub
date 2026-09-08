export interface ISessionInfo {
    sessionName: string;
    isKillZone: boolean;
    qualityMultiplier: number;
    badge: string;
    description: string;
    timeRange: string;
    activeSession: 'NSE_MORNING' | 'NSE_LUNCH_CHOP' | 'NSE_AFTERNOON' | 'LONDON_OPEN' | 'NY_OPEN' | 'ASIA_RANGE' | 'MARKET_CLOSED';
}
export declare class SessionFilter {
    /**
     * Evaluates active market session and returns ICT Kill Zone quality multiplier
     * @param date Date to evaluate (defaults to current date)
     * @param symbol Symbol to check ('BTCUSDT', 'XAUUSD', or Indian assets)
     */
    static getSessionInfo(date?: Date, symbol?: string): ISessionInfo;
}
