"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IndianOptionsExpiryEngine = void 0;
class IndianOptionsExpiryEngine {
    /**
     * Computes authentic upcoming NSE Derivatives & Crypto expiry dates based on institutional exchange rules
     */
    static getUpcomingExpiries(symbol = 'NIFTY', baseDate = new Date()) {
        const sym = symbol.toUpperCase();
        const isEquity = [
            'RELIANCE',
            'HDFCBANK',
            'INFY',
            'TCS',
            'ICICIBANK',
            'SBIN',
            'TATAMOTORS',
        ].includes(sym);
        const isCrypto = sym.startsWith('BTC') || sym.startsWith('ETH') || sym === 'BTCUSDT';
        // NSE Exchange Specific Weekly Expiry Days:
        // NIFTY: Tuesday (Day 2)
        // BANKNIFTY: Wednesday (Day 3)
        // FINNIFTY: Tuesday (Day 2)
        // MIDCPNIFTY: Monday (Day 1)
        // SENSEX: Friday (Day 5)
        // CRYPTO (Deribit/Binance): Friday (Day 5)
        // Indian Single-Stock Equities: Monthly Only (Last Thursday of Month, Day 4)
        const targetDay = isCrypto
            ? 5
            : sym === 'NIFTY'
                ? 2 // Tuesday
                : sym === 'BANKNIFTY'
                    ? 3 // Wednesday
                    : sym === 'FINNIFTY'
                        ? 2 // Tuesday
                        : sym === 'MIDCPNIFTY'
                            ? 1 // Monday
                            : sym === 'SENSEX'
                                ? 5 // Friday
                                : 4; // 4 = Thursday (Equities)
        const results = [];
        if (isEquity) {
            // Single-stock equities only trade monthly series on NSE
            // 1. Current Month Expiry
            const currentMonth = this.getLastWeekdayOfMonth(baseDate.getFullYear(), baseDate.getMonth(), targetDay);
            if (currentMonth.getTime() > baseDate.getTime()) {
                results.push(this.formatExpiryInfo(currentMonth, baseDate, true));
            }
            // 2. Next Month Expiry
            const nextMonth = this.getLastWeekdayOfMonth(baseDate.getMonth() === 11 ? baseDate.getFullYear() + 1 : baseDate.getFullYear(), (baseDate.getMonth() + 1) % 12, targetDay);
            results.push(this.formatExpiryInfo(nextMonth, baseDate, true));
            // 3. Far Month Expiry
            const farMonth = this.getLastWeekdayOfMonth(baseDate.getMonth() >= 10 ? baseDate.getFullYear() + 1 : baseDate.getFullYear(), (baseDate.getMonth() + 2) % 12, targetDay);
            results.push(this.formatExpiryInfo(farMonth, baseDate, true));
            return results;
        }
        // 1. Current Weekly Expiry
        const currentWeekly = this.calculateNextWeekday(baseDate, targetDay);
        results.push(this.formatExpiryInfo(currentWeekly, baseDate, false));
        // 2. Next Weekly Expiry (+7 days)
        const nextWeekly = new Date(currentWeekly);
        nextWeekly.setDate(nextWeekly.getDate() + 7);
        results.push(this.formatExpiryInfo(nextWeekly, baseDate, false));
        // 3. Near Monthly Expiry (Last Target Day of Month)
        const monthlyExpiry = this.getLastWeekdayOfMonth(baseDate.getFullYear(), baseDate.getMonth(), targetDay);
        if (monthlyExpiry.getTime() <= baseDate.getTime() ||
            monthlyExpiry.toDateString() === currentWeekly.toDateString()) {
            const nextMonthExpiry = this.getLastWeekdayOfMonth(baseDate.getMonth() === 11 ? baseDate.getFullYear() + 1 : baseDate.getFullYear(), (baseDate.getMonth() + 1) % 12, targetDay);
            results.push(this.formatExpiryInfo(nextMonthExpiry, baseDate, true));
        }
        else {
            results.push(this.formatExpiryInfo(monthlyExpiry, baseDate, true));
        }
        return results;
    }
    static calculateNextWeekday(base, targetDayOfWeek) {
        const d = new Date(base);
        d.setHours(15, 30, 0, 0); // 03:30 PM IST Market Close
        const currentDay = d.getDay();
        let daysUntilTarget = (targetDayOfWeek - currentDay + 7) % 7;
        // If today is expiry day and time is past 15:30, move to next week
        if (daysUntilTarget === 0 && base.getTime() > d.getTime()) {
            daysUntilTarget = 7;
        }
        const nextDate = new Date(base);
        nextDate.setDate(base.getDate() + daysUntilTarget);
        nextDate.setHours(15, 30, 0, 0);
        return nextDate;
    }
    static getLastWeekdayOfMonth(year, month, targetDayOfWeek) {
        // Start at last day of the month
        const lastDay = new Date(year, month + 1, 0, 15, 30, 0, 0);
        const day = lastDay.getDay();
        const diff = (day - targetDayOfWeek + 7) % 7;
        lastDay.setDate(lastDay.getDate() - diff);
        return lastDay;
    }
    static formatExpiryInfo(expiryDate, baseDate, isMonthly) {
        const diffMs = expiryDate.getTime() - baseDate.getTime();
        const daysToExpiry = Math.max(0.1, Number((diffMs / (1000 * 60 * 60 * 24)).toFixed(1)));
        const timeToExpiryYears = Math.max(0.000114, Number((daysToExpiry / 365.0).toFixed(6)));
        const months = [
            'Jan',
            'Feb',
            'Mar',
            'Apr',
            'May',
            'Jun',
            'Jul',
            'Aug',
            'Sep',
            'Oct',
            'Nov',
            'Dec',
        ];
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const dd = String(expiryDate.getDate()).padStart(2, '0');
        const mmm = months[expiryDate.getMonth()];
        const yyyy = expiryDate.getFullYear();
        const dayName = days[expiryDate.getDay()];
        const dateString = `${dd}-${mmm}-${yyyy}`;
        const formattedLabel = `${dateString} (${dayName}) • ${daysToExpiry < 1 ? `${Math.round(daysToExpiry * 24)}H` : `${Math.round(daysToExpiry)}D`} to Expiry${isMonthly ? ' [MONTHLY]' : ''}`;
        return {
            dateString,
            formattedLabel,
            daysToExpiry,
            timeToExpiryYears,
            isMonthly,
            dayOfWeek: dayName,
        };
    }
}
exports.IndianOptionsExpiryEngine = IndianOptionsExpiryEngine;
//# sourceMappingURL=indian-options-expiry.js.map