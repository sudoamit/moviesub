export interface ISessionInfo {
  sessionName: string;
  isKillZone: boolean;
  qualityMultiplier: number;
  badge: string;
  description: string;
  timeRange: string;
  activeSession:
    | 'NSE_MORNING'
    | 'NSE_LUNCH_CHOP'
    | 'NSE_AFTERNOON'
    | 'LONDON_OPEN'
    | 'NY_OPEN'
    | 'ASIA_RANGE'
    | 'MARKET_CLOSED';
}

export class SessionFilter {
  /**
   * Evaluates active market session and returns ICT Kill Zone quality multiplier
   * @param date Date to evaluate (defaults to current date)
   * @param symbol Symbol to check ('BTCUSDT', 'XAUUSD', or Indian assets)
   */
  public static getSessionInfo(date: Date = new Date(), symbol: string = 'NIFTY'): ISessionInfo {
    const isCrypto = symbol.toUpperCase() === 'BTCUSDT';
    const isGold = symbol.toUpperCase() === 'XAUUSD' || symbol.toUpperCase() === 'GOLD';
    const isGlobalAsset = isCrypto || isGold;
    const utcHours = date.getUTCHours();
    const utcMinutes = date.getUTCMinutes();
    const utcTimeVal = utcHours * 60 + utcMinutes;

    // IST is UTC + 5:30 (330 minutes)
    const istTimeVal = (utcTimeVal + 330) % 1440;

    // 1. Global Assets (Crypto & Spot Gold 24/5 Continuous Order Flow)
    if (isGlobalAsset) {
      // London Open: 07:00 - 10:00 UTC
      if (utcTimeVal >= 420 && utcTimeVal < 600) {
        return {
          sessionName: isGold ? 'London Gold Fix & London Open' : 'London Open Kill Zone',
          isKillZone: true,
          qualityMultiplier: 1.25,
          badge: isGold ? '🥇 LONDON GOLD FIX' : '⚡ LONDON KILL ZONE',
          description: isGold
            ? 'London Bullion Market peak institutional liquidity & manipulation Judas swing window'
            : 'High institutional expansion and Judas swing displacement window',
          timeRange: '07:00 - 10:00 UTC (12:30 - 15:30 IST)',
          activeSession: 'LONDON_OPEN',
        };
      }
      // NY Open: 12:00 - 15:00 UTC
      if (utcTimeVal >= 720 && utcTimeVal < 900) {
        return {
          sessionName: isGold ? 'COMEX Gold New York Open' : 'New York Open Kill Zone',
          isKillZone: true,
          qualityMultiplier: 1.35,
          badge: isGold ? '🔥 COMEX NY GOLD OPEN' : '🔥 NY OPEN KILL ZONE',
          description: isGold
            ? 'Peak COMEX Gold futures institutional order flow, US economic data & high-conviction displacement'
            : 'Peak crypto and macro volume institutional entry window',
          timeRange: '12:00 - 15:00 UTC (17:30 - 20:30 IST)',
          activeSession: 'NY_OPEN',
        };
      }
      // Asia Range: 00:00 - 06:00 UTC
      if (utcTimeVal >= 0 && utcTimeVal < 360) {
        return {
          sessionName: 'Asia Accumulation Range',
          isKillZone: false,
          qualityMultiplier: 0.9,
          badge: '🌙 ASIA ACCUMULATION',
          description: 'Range-bound accumulation setting high/low of day targets',
          timeRange: '00:00 - 06:00 UTC (05:30 - 11:30 IST)',
          activeSession: 'ASIA_RANGE',
        };
      }
      return {
        sessionName: 'Standard Crypto Flow',
        isKillZone: false,
        qualityMultiplier: 1.0,
        badge: '🌐 GLOBAL FLOW',
        description: 'Standard continuous liquidity cycle',
        timeRange: '24/7 Global Market',
        activeSession: 'LONDON_OPEN',
      };
    }

    // 2. Indian NSE Equities / Indices Specific Timing (09:15 - 15:30 IST)
    // 09:15 IST is 555 mins
    // 15:30 IST is 930 mins
    const isNSEOpen = istTimeVal >= 555 && istTimeVal <= 930;

    if (!isNSEOpen) {
      return {
        sessionName: 'NSE Market Closed',
        isKillZone: false,
        qualityMultiplier: 0.5,
        badge: '🔒 MARKET CLOSED',
        description: 'Orders queued for next trading day opening bell (09:15 AM IST)',
        timeRange: '03:30 PM - 09:15 AM IST',
        activeSession: 'MARKET_CLOSED',
      };
    }

    // A. NSE Morning Power Hour (09:15 - 10:45 IST)
    if (istTimeVal >= 555 && istTimeVal < 645) {
      return {
        sessionName: 'NSE Morning Opening Drive',
        isKillZone: true,
        qualityMultiplier: 1.3,
        badge: '🚀 NSE OPENING POWER HOUR',
        description: 'Peak volume, Initial Balance (IB) sweep & high-conviction displacement',
        timeRange: '09:15 AM - 10:45 AM IST',
        activeSession: 'NSE_MORNING',
      };
    }

    // B. NSE Lunch Chop Trap (11:30 - 13:00 IST)
    if (istTimeVal >= 690 && istTimeVal < 780) {
      return {
        sessionName: 'NSE Mid-Day Lunch Trap',
        isKillZone: false,
        qualityMultiplier: 0.65,
        badge: '⚠️ NSE LUNCH CHOP TRAP',
        description: 'Low institutional participation, retail chop & false breakout traps',
        timeRange: '11:30 AM - 01:00 PM IST',
        activeSession: 'NSE_LUNCH_CHOP',
      };
    }

    // C. NSE Afternoon Power Hour (13:30 - 15:15 IST)
    if (istTimeVal >= 810 && istTimeVal <= 915) {
      return {
        sessionName: 'NSE Afternoon Expansion',
        isKillZone: true,
        qualityMultiplier: 1.2,
        badge: '⚡ NSE AFTERNOON EXPANSION',
        description: 'Institutional closing balance, trend continuation & gamma spikes',
        timeRange: '01:30 PM - 03:15 PM IST',
        activeSession: 'NSE_AFTERNOON',
      };
    }

    // D. Normal Order Flow
    return {
      sessionName: 'NSE Regular Session',
      isKillZone: false,
      qualityMultiplier: 1.0,
      badge: '📊 NSE REGULAR FLOW',
      description: 'Moderate order flow with regular SMC structural validation',
      timeRange: '09:15 AM - 03:30 PM IST',
      activeSession: 'NSE_MORNING',
    };
  }
}
