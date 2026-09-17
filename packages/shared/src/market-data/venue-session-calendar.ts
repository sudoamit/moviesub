/**
 * Canonical Venue & Exchange Trading Session Calendar Manager
 *
 * Provides deterministic venue-specific session keys based on symbol/venue and event timestamps.
 * Eliminates generic '1d' bucket assumptions for exchange trading sessions.
 */
export class VenueSessionCalendar {
  /**
   * Resolves venue type from symbol or venue identifier.
   */
  public static resolveVenue(symbol: string): 'NSE' | 'METALS' | 'CRYPTO' | 'GENERIC' {
    const sym = (symbol || '').toUpperCase().trim();

    if (
      sym.startsWith('NSE:') ||
      sym === 'NIFTY' ||
      sym === 'NIFTY_SPOT' ||
      sym === 'NIFTY50' ||
      sym === '^NSEI' ||
      sym === 'BANKNIFTY' ||
      sym === 'BANKNIFTY_SPOT' ||
      sym === '^NSEBANK' ||
      sym === 'FINNIFTY' ||
      sym === 'RELIANCE' ||
      sym === 'HDFCBANK' ||
      sym === 'INFY' ||
      sym.endsWith('.NS')
    ) {
      return 'NSE';
    }

    if (
      sym.startsWith('COMEX:') ||
      sym.startsWith('METALS:') ||
      sym === 'XAUUSD' ||
      sym === 'GOLD' ||
      sym === 'SILVER' ||
      sym === 'GC=F' ||
      sym === 'GOLD_MCX'
    ) {
      return 'METALS';
    }

    if (
      sym.startsWith('CRYPTO:') ||
      sym.startsWith('BINANCE:') ||
      sym === 'BTCUSDT' ||
      sym === 'BTCUSDT_SPOT' ||
      sym === 'BTCUSD' ||
      sym === 'ETHUSDT' ||
      sym === 'PAXGUSDT' ||
      sym.endsWith('USDT')
    ) {
      return 'CRYPTO';
    }

    return 'GENERIC';
  }

  /**
   * Computes deterministic venue trading session key for a given timestamp.
   *
   * Session Boundaries:
   * - NSE: 09:15 IST (03:45 UTC) start. Returns 'NSE:YYYY-MM-DD' anchored to IST trading date.
   * - METALS: 22:00 UTC start. Ticks >= 22:00 UTC belong to next trade session 'METALS:YYYY-MM-DD+1'.
   * - CRYPTO: 00:00 UTC 24/7 start. Returns 'CRYPTO:YYYY-MM-DD' anchored to UTC date.
   * - GENERIC: 00:00 UTC start. Returns 'GENERIC:YYYY-MM-DD'.
   */
  public static getSessionKey(symbol: string, timestamp: Date | string | number): string {
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    const timeMs = date.getTime();
    if (isNaN(timeMs)) {
      throw new Error(`Invalid timestamp provided for getSessionKey: ${timestamp}`);
    }

    const venue = this.resolveVenue(symbol);

    if (venue === 'NSE') {
      // IST is UTC + 5 hours 30 minutes (330 minutes = 19,800,000 ms)
      const istDate = new Date(timeMs + 330 * 60 * 1000);
      const year = istDate.getUTCFullYear();
      const month = String(istDate.getUTCMonth() + 1).padStart(2, '0');
      const day = String(istDate.getUTCDate()).padStart(2, '0');
      return `NSE:${year}-${month}-${day}`;
    }

    if (venue === 'METALS') {
      const utcHours = date.getUTCHours();
      let targetDate = new Date(date.getTime());
      if (utcHours >= 22) {
        // Ticks at/after 22:00 UTC belong to the next day's trade session
        targetDate.setUTCDate(targetDate.getUTCDate() + 1);
      }
      const year = targetDate.getUTCFullYear();
      const month = String(targetDate.getUTCMonth() + 1).padStart(2, '0');
      const day = String(targetDate.getUTCDate()).padStart(2, '0');
      return `METALS:${year}-${month}-${day}`;
    }

    if (venue === 'CRYPTO') {
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const day = String(date.getUTCDate()).padStart(2, '0');
      return `CRYPTO:${year}-${month}-${day}`;
    }

    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `GENERIC:${year}-${month}-${day}`;
  }
}
