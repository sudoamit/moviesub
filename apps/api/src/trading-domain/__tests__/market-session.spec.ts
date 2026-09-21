import { MarketSessionService } from '../market-session.service';
import { InstrumentMasterService } from '../instrument-master.service';
import { BadRequestException } from '@nestjs/common';

describe('Phase 22 — Market Hours & Session Calendar Engine', () => {
  let sessionService: MarketSessionService;
  let instrumentMaster: InstrumentMasterService;

  beforeEach(() => {
    instrumentMaster = new InstrumentMasterService();
    sessionService = new MarketSessionService(instrumentMaster);
  });

  // Helper to create exact UTC date representing an Indian Standard Time (IST) moment (UTC = IST - 5h30m)
  const istDate = (year: number, month: number, day: number, hour: number, minute: number): Date => {
    // month is 1-indexed for readability
    const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute));
    // subtract 5h30m (330 minutes)
    return new Date(utcDate.getTime() - 330 * 60 * 1000);
  };

  describe('1. Crypto 24/7 Continuous Trading Invariant', () => {
    it('should report BTCUSDT as OPEN on Sunday midnight, weekends, and holidays', () => {
      // Sunday midnight UTC
      const sundayMidnight = new Date(Date.UTC(2026, 8, 27, 0, 0)); // 2026-09-27 Sunday
      const resSunday = sessionService.getSessionStatus('BTCUSDT', sundayMidnight);
      expect(resSunday.isOpen).toBe(true);
      expect(resSunday.sessionState).toBe('OPEN');
      expect(resSunday.exchange).toBe('BINANCE');

      // Republic Day holiday (2026-01-26)
      const holidayTime = new Date(Date.UTC(2026, 0, 26, 12, 0));
      const resHoliday = sessionService.getSessionStatus('BTCUSDT_SPOT', holidayTime);
      expect(resHoliday.isOpen).toBe(true);
      expect(resHoliday.sessionState).toBe('OPEN');

      // assertMarketOpen should succeed without throwing
      expect(() => sessionService.assertMarketOpen('BTCUSDT', sundayMidnight)).not.toThrow();
    });
  });

  describe('2. NSE Regular Trading Sessions (Asia/Kolkata)', () => {
    // Wednesday 2026-09-23 (Regular trading day)
    it('should report CLOSED before 09:00 IST', () => {
      const earlyMorning = istDate(2026, 9, 23, 8, 30);
      const res = sessionService.getSessionStatus('NIFTY_SPOT', earlyMorning);
      expect(res.isOpen).toBe(false);
      expect(res.sessionState).toBe('CLOSED');
      expect(res.reason).toBe('PRE_MARKET_HOURS');
      expect(() => sessionService.assertMarketOpen('NIFTY_SPOT', earlyMorning)).toThrow(BadRequestException);
    });

    it('should report PRE_OPEN between 09:00 and 09:15 IST and reject auto trading', () => {
      const preOpen = istDate(2026, 9, 23, 9, 5);
      const res = sessionService.getSessionStatus('NIFTY_SPOT', preOpen);
      expect(res.isOpen).toBe(false);
      expect(res.sessionState).toBe('PRE_OPEN');
      expect(res.reason).toBe('PRE_OPEN_SESSION_NO_AUTO_TRADING');
      expect(() => sessionService.assertMarketOpen('NIFTY_SPOT', preOpen)).toThrow(BadRequestException);
    });

    it('should report OPEN between 09:15 and 15:30 IST', () => {
      const morningTrade = istDate(2026, 9, 23, 10, 0);
      const res = sessionService.getSessionStatus('NIFTY_SPOT', morningTrade);
      expect(res.isOpen).toBe(true);
      expect(res.sessionState).toBe('OPEN');
      expect(() => sessionService.assertMarketOpen('NIFTY_SPOT', morningTrade)).not.toThrow();

      // Right before close
      const afternoonTrade = istDate(2026, 9, 23, 15, 29);
      const resAfternoon = sessionService.getSessionStatus('NIFTY_SPOT', afternoonTrade);
      expect(resAfternoon.isOpen).toBe(true);
      expect(resAfternoon.sessionState).toBe('OPEN');
    });

    it('should report CLOSING_AUCTION between 15:30 and 15:40 IST', () => {
      const closingAuction = istDate(2026, 9, 23, 15, 35);
      const res = sessionService.getSessionStatus('NIFTY_SPOT', closingAuction);
      expect(res.isOpen).toBe(false);
      expect(res.sessionState).toBe('CLOSING_AUCTION');
      expect(() => sessionService.assertMarketOpen('NIFTY_SPOT', closingAuction)).toThrow(BadRequestException);
    });

    it('should report POST_CLOSE between 15:40 and 16:00 IST', () => {
      const postClose = istDate(2026, 9, 23, 15, 50);
      const res = sessionService.getSessionStatus('NIFTY_SPOT', postClose);
      expect(res.isOpen).toBe(false);
      expect(res.sessionState).toBe('POST_CLOSE');
      expect(() => sessionService.assertMarketOpen('NIFTY_SPOT', postClose)).toThrow(BadRequestException);
    });

    it('should report CLOSED after 16:00 IST', () => {
      const evening = istDate(2026, 9, 23, 18, 0);
      const res = sessionService.getSessionStatus('NIFTY_SPOT', evening);
      expect(res.isOpen).toBe(false);
      expect(res.sessionState).toBe('CLOSED');
      expect(res.reason).toBe('POST_MARKET_HOURS');
    });
  });

  describe('3. Weekend & Holiday Closures', () => {
    it('should report WEEKEND on Saturday and Sunday for NSE', () => {
      // Saturday 2026-09-26 11:00 IST
      const saturday = istDate(2026, 9, 26, 11, 0);
      const resSat = sessionService.getSessionStatus('NIFTY_SPOT', saturday);
      expect(resSat.isOpen).toBe(false);
      expect(resSat.sessionState).toBe('WEEKEND');
      expect(resSat.reason).toBe('EXCHANGE_WEEKEND_CLOSED');

      // Sunday 2026-09-27 12:00 IST
      const sunday = istDate(2026, 9, 27, 12, 0);
      const resSun = sessionService.getSessionStatus('BANKNIFTY_SPOT', sunday);
      expect(resSun.isOpen).toBe(false);
      expect(resSun.sessionState).toBe('WEEKEND');
    });

    it('should report HOLIDAY on official NSE exchange trading holidays', () => {
      // Republic Day: Monday 2026-01-26 11:00 IST
      const republicDay = istDate(2026, 1, 26, 11, 0);
      const resHoliday = sessionService.getSessionStatus('NIFTY_SPOT', republicDay);
      expect(resHoliday.isOpen).toBe(false);
      expect(resHoliday.sessionState).toBe('HOLIDAY');
      expect(resHoliday.reason).toContain('EXCHANGE_HOLIDAY_CLOSED');

      // assertMarketOpen must fail closed
      expect(() => sessionService.assertMarketOpen('NIFTY_SPOT', republicDay)).toThrow(BadRequestException);
    });

    it('should allow dynamically registering an unexpected exchange holiday', () => {
      sessionService.registerHoliday('NSE', '2026-09-23');
      const wednesday = istDate(2026, 9, 23, 11, 0);
      const res = sessionService.getSessionStatus('NIFTY_SPOT', wednesday);
      expect(res.isOpen).toBe(false);
      expect(res.sessionState).toBe('HOLIDAY');
    });
  });

  describe('4. Option Expiry Cutoff Enforcement', () => {
    const expiryThursday = new Date('2026-09-24'); // Expiration Thursday

    it('should allow option trading before 15:30 IST on expiry date', () => {
      const activeTime = istDate(2026, 9, 24, 14, 0); // 14:00 IST on Thursday
      const isExpired = sessionService.isOptionExpired(expiryThursday, 'Asia/Kolkata', activeTime);
      expect(isExpired).toBe(false);

      const optionDef: any = {
        symbol: 'NIFTY 24500 CE',
        exchange: 'NSE',
        instrumentType: 'OPTION',
        tradingTimezone: 'Asia/Kolkata',
        expiry: expiryThursday,
      };

      const status = sessionService.getSessionStatus(optionDef, activeTime);
      expect(status.isOpen).toBe(true);
      expect(status.sessionState).toBe('OPEN');
    });

    it('should mark option as EXPIRED at or after 15:30 IST on expiry date and throw', () => {
      // Exactly 15:30 IST
      const cutoffTime = istDate(2026, 9, 24, 15, 30);
      expect(sessionService.isOptionExpired(expiryThursday, 'Asia/Kolkata', cutoffTime)).toBe(true);

      const optionDef: any = {
        symbol: 'NIFTY 24500 CE',
        exchange: 'NSE',
        instrumentType: 'OPTION',
        tradingTimezone: 'Asia/Kolkata',
        expiry: expiryThursday,
      };

      const statusAtCutoff = sessionService.getSessionStatus(optionDef, cutoffTime);
      expect(statusAtCutoff.isOpen).toBe(false);
      expect(statusAtCutoff.sessionState).toBe('EXPIRED');
      expect(statusAtCutoff.isExpired).toBe(true);

      // Must throw in assertMarketOpen
      expect(() => sessionService.assertMarketOpen(optionDef, cutoffTime)).toThrow(BadRequestException);
    });

    it('should mark option as EXPIRED on any day after expiry date', () => {
      const dayAfter = istDate(2026, 9, 25, 10, 0); // Friday 10:00 IST
      expect(sessionService.isOptionExpired(expiryThursday, 'Asia/Kolkata', dayAfter)).toBe(true);
    });
  });

  describe('5. Rule Invariant: Never Use a Universal Market-Open Rule', () => {
    it('should simultaneously report BTCUSDT as OPEN and NIFTY as CLOSED on Sunday noon', () => {
      // Sunday 2026-09-27 06:30 UTC = 12:00 IST
      const sundayTime = new Date(Date.UTC(2026, 8, 27, 6, 30));

      const btcStatus = sessionService.getSessionStatus('BTCUSDT', sundayTime);
      const niftyStatus = sessionService.getSessionStatus('NIFTY_SPOT', sundayTime);

      // BTC is OPEN (Crypto 24/7)
      expect(btcStatus.isOpen).toBe(true);
      expect(btcStatus.sessionState).toBe('OPEN');

      // NIFTY is CLOSED (NSE Weekend)
      expect(niftyStatus.isOpen).toBe(false);
      expect(niftyStatus.sessionState).toBe('WEEKEND');

      // Proves no universal boolean is ever used
      expect(btcStatus.isOpen).not.toEqual(niftyStatus.isOpen);
    });
  });

  describe('6. Next Market Open & Close Calculations', () => {
    it('should calculate upcoming next open for NSE outside trading hours', () => {
      // Wednesday 18:00 IST -> next open is Thursday 09:15 IST
      const wedEvening = istDate(2026, 9, 23, 18, 0);
      const nextOpen = sessionService.getNextMarketOpen('NIFTY_SPOT', wedEvening);
      const nextOpenLocal = sessionService.getExchangeLocalTime(nextOpen, 'Asia/Kolkata');

      expect(nextOpenLocal.dateStr).toBe('2026-09-24');
      expect(nextOpenLocal.hour).toBe(9);
      expect(nextOpenLocal.minute).toBe(15);
    });

    it('should calculate upcoming next close for NSE during trading hours', () => {
      // Wednesday 10:00 IST -> next close is Wednesday 15:30 IST
      const wedTrade = istDate(2026, 9, 23, 10, 0);
      const nextClose = sessionService.getNextMarketClose('NIFTY_SPOT', wedTrade);
      const nextCloseLocal = sessionService.getExchangeLocalTime(nextClose, 'Asia/Kolkata');

      expect(nextCloseLocal.dateStr).toBe('2026-09-23');
      expect(nextCloseLocal.hour).toBe(15);
      expect(nextCloseLocal.minute).toBe(30);
    });
  });
});
