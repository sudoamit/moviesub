"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BlackScholesModel = void 0;
class BlackScholesModel {
    /**
     * High-precision Abramowitz and Stegun polynomial approximation of standard normal CDF
     */
    static normalCDF(x) {
        const a1 = 0.254829592;
        const a2 = -0.284496736;
        const a3 = 1.421413741;
        const a4 = -1.453152027;
        const a5 = 1.061405429;
        const p = 0.3275911;
        const sign = x < 0 ? -1 : 1;
        const absX = Math.abs(x) / Math.sqrt(2.0);
        const t = 1.0 / (1.0 + p * absX);
        const erf = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
        return 0.5 * (1.0 + sign * erf);
    }
    /**
     * Standard normal probability density function (PDF)
     */
    static normalPDF(x) {
        return (1.0 / Math.sqrt(2.0 * Math.PI)) * Math.exp(-0.5 * x * x);
    }
    /**
     * Calculates Black-Scholes-Merton Price and Greeks for Call or Put option
     * @param spot Underlying spot price S
     * @param strike Strike price K
     * @param timeToExpiryYears Time to expiry T in years (e.g. days / 365)
     * @param riskFreeRate Annualized risk free interest rate r (e.g. 0.07 for 7%)
     * @param volatility Annualized Implied Volatility sigma (e.g. 0.135 for 13.5%)
     * @param type 'CE' | 'PE'
     */
    static calculate(spot, strike, timeToExpiryYears, riskFreeRate = 0.07, volatility = 0.135, type = 'CE') {
        const S = Math.max(0.01, spot);
        const K = Math.max(0.01, strike);
        // Floor time to expiry at 1 hour (0.000114 years) to prevent division by zero on expiry day
        const T = Math.max(0.000114, timeToExpiryYears);
        const r = riskFreeRate;
        const sigma = Math.max(0.01, volatility);
        const sqrtT = Math.sqrt(T);
        const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2.0) * T) / (sigma * sqrtT);
        const d2 = d1 - sigma * sqrtT;
        const nd1 = this.normalCDF(d1);
        const nd2 = this.normalCDF(d2);
        const nPdfD1 = this.normalPDF(d1);
        const expDiscount = Math.exp(-r * T);
        const gamma = Number((nPdfD1 / (S * sigma * sqrtT)).toFixed(5));
        const vega = Number(((S * sqrtT * nPdfD1) / 100.0).toFixed(2)); // per 1% vol change
        let price = 0;
        let intrinsicValue = 0;
        let delta = 0;
        let theta = 0;
        let rho = 0;
        if (type === 'CE') {
            price = S * nd1 - K * expDiscount * nd2;
            intrinsicValue = Math.max(0, S - K);
            delta = Number(nd1.toFixed(3));
            // Daily theta in rupees
            theta = Number(((-(S * nPdfD1 * sigma) / (2.0 * sqrtT) - r * K * expDiscount * nd2) / 365.0).toFixed(2));
            rho = Number(((K * T * expDiscount * nd2) / 100.0).toFixed(3));
        }
        else {
            const nMinusD1 = this.normalCDF(-d1);
            const nMinusD2 = this.normalCDF(-d2);
            price = K * expDiscount * nMinusD2 - S * nMinusD1;
            intrinsicValue = Math.max(0, K - S);
            delta = Number((nd1 - 1.0).toFixed(3));
            // Daily theta in rupees
            theta = Number(((-(S * nPdfD1 * sigma) / (2.0 * sqrtT) + r * K * expDiscount * nMinusD2) / 365.0).toFixed(2));
            rho = Number(((-K * T * expDiscount * nMinusD2) / 100.0).toFixed(3));
        }
        // Minimum tick price is 0.05 on NSE
        const cleanPrice = Math.max(0.05, Number(price.toFixed(2)));
        const timeValue = Math.max(0.05, Number((cleanPrice - intrinsicValue).toFixed(2)));
        return {
            price: cleanPrice,
            intrinsicValue: Number(intrinsicValue.toFixed(2)),
            timeValue,
            greeks: {
                delta,
                gamma,
                theta,
                vega,
                rho,
            },
            iv: Number((volatility * 100).toFixed(1)),
        };
    }
}
exports.BlackScholesModel = BlackScholesModel;
//# sourceMappingURL=black-scholes.js.map