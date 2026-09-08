export interface IExpiryInfo {
    dateString: string;
    formattedLabel: string;
    daysToExpiry: number;
    timeToExpiryYears: number;
    isMonthly: boolean;
    dayOfWeek: string;
}
export declare class IndianOptionsExpiryEngine {
    /**
     * Computes authentic upcoming NSE Derivatives & Crypto expiry dates based on institutional exchange rules
     */
    static getUpcomingExpiries(symbol?: string, baseDate?: Date): IExpiryInfo[];
    private static calculateNextWeekday;
    private static getLastWeekdayOfMonth;
    private static formatExpiryInfo;
}
