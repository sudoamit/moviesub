export interface IOptionGreeks {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    rho: number;
}
export interface IOptionContractPrice {
    price: number;
    intrinsicValue: number;
    timeValue: number;
    greeks: IOptionGreeks;
    iv: number;
}
export declare class BlackScholesModel {
    /**
     * High-precision Abramowitz and Stegun polynomial approximation of standard normal CDF
     */
    static normalCDF(x: number): number;
    /**
     * Standard normal probability density function (PDF)
     */
    static normalPDF(x: number): number;
    /**
     * Calculates Black-Scholes-Merton Price and Greeks for Call or Put option
     * @param spot Underlying spot price S
     * @param strike Strike price K
     * @param timeToExpiryYears Time to expiry T in years (e.g. days / 365)
     * @param riskFreeRate Annualized risk free interest rate r (e.g. 0.07 for 7%)
     * @param volatility Annualized Implied Volatility sigma (e.g. 0.135 for 13.5%)
     * @param type 'CE' | 'PE'
     */
    static calculate(spot: number, strike: number, timeToExpiryYears: number, riskFreeRate?: number, volatility?: number, type?: 'CE' | 'PE'): IOptionContractPrice;
}
