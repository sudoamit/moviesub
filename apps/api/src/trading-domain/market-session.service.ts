import { Injectable, Logger, BadRequestException, Optional } from '@nestjs/common';
import {
  IMarketSessionDomainService,
  InstrumentDefinition,
  MarketScheduleProfile,
  MarketSessionState,
  SessionCheckResult,
} from '@quant/shared';
import { InstrumentMasterService } from './instrument-master.service';

@Injectable()
export class MarketSessionService implements IMarketSessionDomainService {
  private readonly logger = new Logger(MarketSessionService.name);

  private readonly scheduleProfiles = new Map<string, MarketScheduleProfile>();

  constructor(@Optional() private readonly instrumentMaster?: InstrumentMasterService) {
    this.initializeScheduleProfiles();
  }

  private initializeScheduleProfiles(): void {
    // 1. BINANCE / CRYPTO: 24/7/365 Continuous Trading
    this.scheduleProfiles.set('BINANCE', {
      exchange: 'BINANCE',
      timezone: 'UTC',
      is24x7: true,
      regularTradingStart: '00:00',
      regularTradingEnd: '24:00',
      weekendDays: [],
      holidays: [],
    });

    // 2. NSE: Indian Equities, Indices, and Derivatives (Asia/Kolkata)
    this.scheduleProfiles.set('NSE', {
      exchange: 'NSE',
      timezone: 'Asia/Kolkata',
      is24x7: false,
      regularTradingStart: '09:15',
      regularTradingEnd: '15:30',
      preOpenStart: '09:00',
      preOpenEnd: '09:15',
      postCloseStart: '15:40',
      postCloseEnd: '16:00',
      weekendDays: [0, 6], // Sunday=0, Saturday=6
      holidays: [
        // 2026 Official NSE Trading Holidays
        '2026-01-26', // Republic Day
        '2026-02-15', // Mahashivratri
        '2026-03-04', // Holi
        '2026-03-20', // Id-Ul-Fitr
        '2026-04-03', // Good Friday
        '2026-04-14', // Dr. Ambedkar Jayanti
        '2026-05-01', // Maharashtra Day
        '2026-05-27', // Bakri Id
        '2026-06-25', // Moharram
        '2026-08-15', // Independence Day
        '2026-10-02', // Mahatma Gandhi Jayanti
        '2026-10-20', // Dussehra
        '2026-11-08', // Diwali-Laxmi Pujan
        '2026-11-24', // Gurunanak Jayanti
        '2026-12-25', // Christmas
      ],
    });
  }

  /**
   * Registers a trading holiday for an exchange
   */
  public registerHoliday(exchange: string, dateStr: string): void {
    const profile = this.scheduleProfiles.get(exchange.toUpperCase());
    if (profile) {
      if (!profile.holidays.includes(dateStr)) {
        profile.holidays.push(dateStr);
      }
    }
  }

  /**
   * Returns registered holidays for an exchange
   */
  public getHolidays(exchange: string): string[] {
    const profile = this.scheduleProfiles.get(exchange.toUpperCase());
    return profile ? [...profile.holidays] : [];
  }

  /**
   * Helper to format a Date into exchange-local components
   */
  public getExchangeLocalTime(date: Date, timezone: string) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      weekday: 'short',
    });

    const parts = formatter.formatToParts(date);
    const getPart = (type: string) => parts.find((p) => p.type === type)?.value || '';

    const year = Number(getPart('year'));
    const month = Number(getPart('month'));
    const day = Number(getPart('day'));
    const hour = Number(getPart('hour'));
    const minute = Number(getPart('minute'));
    const second = Number(getPart('second'));
    const weekdayStr = getPart('weekday');

    const dayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    const dayOfWeek = dayMap[weekdayStr] ?? date.getUTCDay();
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(
      second,
    ).padStart(2, '0')}`;

    return {
      year,
      month,
      day,
      hour,
      minute,
      second,
      dayOfWeek,
      dateStr,
      timeStr,
      timeMinutes: hour * 60 + minute,
    };
  }

  /**
   * Resolves target exchange, timezone, and option metadata from symbol or definition
   */
  public resolveInstrumentMetadata(symbolOrInstrument: string | InstrumentDefinition) {
    let exchange = 'NSE';
    let timezone = 'Asia/Kolkata';
    let symbol = '';
    let isOption = false;
    let expiry: Date | undefined;

    if (typeof symbolOrInstrument === 'object' && symbolOrInstrument !== null) {
      exchange = (symbolOrInstrument.exchange || 'NSE').toUpperCase();
      timezone = symbolOrInstrument.tradingTimezone || (exchange === 'BINANCE' ? 'UTC' : 'Asia/Kolkata');
      symbol = symbolOrInstrument.symbol;
      isOption = symbolOrInstrument.instrumentType === 'OPTION';
      expiry = symbolOrInstrument.expiry ? new Date(symbolOrInstrument.expiry) : undefined;
    } else {
      symbol = String(symbolOrInstrument).trim().toUpperCase();
      if (
        symbol.includes('USDT') ||
        symbol.includes('BTC') ||
        symbol.includes('ETH') ||
        symbol.includes('SOL')
      ) {
        exchange = 'BINANCE';
        timezone = 'UTC';
      } else {
        exchange = 'NSE';
        timezone = 'Asia/Kolkata';
        if (symbol.includes(' CE') || symbol.includes(' PE')) {
          isOption = true;
        }
      }

      if (this.instrumentMaster) {
        try {
          const inst = this.instrumentMaster.getInstrumentSync(symbol);
          if (inst) {
            exchange = inst.exchange.toUpperCase();
            timezone = inst.tradingTimezone || (exchange === 'BINANCE' ? 'UTC' : 'Asia/Kolkata');
            isOption = inst.instrumentType === 'OPTION';
            expiry = inst.expiry ? new Date(inst.expiry) : undefined;
          }
        } catch {
          // Fall back to inferred values
        }
      }
    }

    return { exchange, timezone, symbol, isOption, expiry };
  }

  /**
   * Checks whether an option contract has passed its strict 15:30 IST expiration cutoff
   */
  public isOptionExpired(
    expiry: Date | string,
    timezone: string = 'Asia/Kolkata',
    referenceTime = new Date(),
  ): boolean {
    const expiryDate = expiry instanceof Date ? expiry : new Date(expiry);
    if (isNaN(expiryDate.getTime())) return true;

    const expiryLocal = this.getExchangeLocalTime(expiryDate, timezone);
    const refLocal = this.getExchangeLocalTime(referenceTime, timezone);

    // If reference date is after expiry date
    if (refLocal.dateStr > expiryLocal.dateStr) {
      return true;
    }

    // If reference date is on expiry date, cutoff is strictly at 15:30 IST (930 minutes)
    if (refLocal.dateStr === expiryLocal.dateStr) {
      return refLocal.timeMinutes >= 930;
    }

    return false;
  }

  /**
   * Authoritatively determines the current market session state for an instrument
   */
  public getSessionStatus(
    symbolOrInstrument: string | InstrumentDefinition,
    referenceTime = new Date(),
  ): SessionCheckResult {
    const meta = this.resolveInstrumentMetadata(symbolOrInstrument);
    const profile = this.scheduleProfiles.get(meta.exchange) || {
      exchange: meta.exchange,
      timezone: meta.timezone,
      is24x7: false,
      regularTradingStart: '09:15',
      regularTradingEnd: '15:30',
      weekendDays: [0, 6],
      holidays: [],
    };

    const local = this.getExchangeLocalTime(referenceTime, profile.timezone);
    const localTimeFormatted = `${local.dateStr} ${local.timeStr} (${profile.timezone})`;

    // 1. Option Expiration Check
    if (meta.isOption && meta.expiry) {
      if (this.isOptionExpired(meta.expiry, profile.timezone, referenceTime)) {
        return {
          isOpen: false,
          sessionState: 'EXPIRED',
          exchange: profile.exchange,
          symbol: meta.symbol,
          timezone: profile.timezone,
          localTime: localTimeFormatted,
          isExpired: true,
          expiryTime: meta.expiry,
          reason: 'OPTION_CONTRACT_EXPIRED',
        };
      }
    }

    // 2. Crypto 24/7 Continuous Trading Rule
    if (profile.is24x7) {
      return {
        isOpen: true,
        sessionState: 'OPEN',
        exchange: profile.exchange,
        symbol: meta.symbol,
        timezone: profile.timezone,
        localTime: localTimeFormatted,
      };
    }

    // 3. Weekend Check
    if (profile.weekendDays.includes(local.dayOfWeek)) {
      const nextOpen = this.getNextMarketOpen(symbolOrInstrument, referenceTime);
      return {
        isOpen: false,
        sessionState: 'WEEKEND',
        exchange: profile.exchange,
        symbol: meta.symbol,
        timezone: profile.timezone,
        localTime: localTimeFormatted,
        nextOpenTime: nextOpen,
        reason: 'EXCHANGE_WEEKEND_CLOSED',
      };
    }

    // 4. Exchange Holiday Check
    if (profile.holidays.includes(local.dateStr)) {
      const nextOpen = this.getNextMarketOpen(symbolOrInstrument, referenceTime);
      return {
        isOpen: false,
        sessionState: 'HOLIDAY',
        exchange: profile.exchange,
        symbol: meta.symbol,
        timezone: profile.timezone,
        localTime: localTimeFormatted,
        nextOpenTime: nextOpen,
        reason: `EXCHANGE_HOLIDAY_CLOSED (${local.dateStr})`,
      };
    }

    // 5. Daily Trading Session Check
    const timeMinutes = local.timeMinutes;
    // Standard NSE: pre-open (540-555m = 09:00-09:15), regular (555-930m = 09:15-15:30), closing auction (930-940m), post-close (940-960m)
    if (timeMinutes < 540) {
      const nextOpen = this.getNextMarketOpen(symbolOrInstrument, referenceTime);
      return {
        isOpen: false,
        sessionState: 'CLOSED',
        exchange: profile.exchange,
        symbol: meta.symbol,
        timezone: profile.timezone,
        localTime: localTimeFormatted,
        nextOpenTime: nextOpen,
        reason: 'PRE_MARKET_HOURS',
      };
    }

    if (timeMinutes >= 540 && timeMinutes < 555) {
      const nextOpen = this.getNextMarketOpen(symbolOrInstrument, referenceTime);
      return {
        isOpen: false,
        sessionState: 'PRE_OPEN',
        exchange: profile.exchange,
        symbol: meta.symbol,
        timezone: profile.timezone,
        localTime: localTimeFormatted,
        nextOpenTime: nextOpen,
        reason: 'PRE_OPEN_SESSION_NO_AUTO_TRADING',
      };
    }

    if (timeMinutes >= 555 && timeMinutes < 930) {
      const nextClose = this.getNextMarketClose(symbolOrInstrument, referenceTime);
      return {
        isOpen: true,
        sessionState: 'OPEN',
        exchange: profile.exchange,
        symbol: meta.symbol,
        timezone: profile.timezone,
        localTime: localTimeFormatted,
        nextCloseTime: nextClose,
      };
    }

    if (timeMinutes >= 930 && timeMinutes < 940) {
      const nextOpen = this.getNextMarketOpen(symbolOrInstrument, referenceTime);
      return {
        isOpen: false,
        sessionState: 'CLOSING_AUCTION',
        exchange: profile.exchange,
        symbol: meta.symbol,
        timezone: profile.timezone,
        localTime: localTimeFormatted,
        nextOpenTime: nextOpen,
        reason: 'CLOSING_AUCTION',
      };
    }

    if (timeMinutes >= 940 && timeMinutes < 960) {
      const nextOpen = this.getNextMarketOpen(symbolOrInstrument, referenceTime);
      return {
        isOpen: false,
        sessionState: 'POST_CLOSE',
        exchange: profile.exchange,
        symbol: meta.symbol,
        timezone: profile.timezone,
        localTime: localTimeFormatted,
        nextOpenTime: nextOpen,
        reason: 'POST_CLOSE_SESSION',
      };
    }

    const nextOpen = this.getNextMarketOpen(symbolOrInstrument, referenceTime);
    return {
      isOpen: false,
      sessionState: 'CLOSED',
      exchange: profile.exchange,
      symbol: meta.symbol,
      timezone: profile.timezone,
      localTime: localTimeFormatted,
      nextOpenTime: nextOpen,
      reason: 'POST_MARKET_HOURS',
    };
  }

  /**
   * Fast boolean check for whether the market is open
   */
  public isMarketOpen(
    symbolOrInstrument: string | InstrumentDefinition,
    referenceTime = new Date(),
  ): boolean {
    return this.getSessionStatus(symbolOrInstrument, referenceTime).isOpen;
  }

  /**
   * Asserts market is open. Throws BadRequestException on closed/holiday/weekend/expired.
   */
  public assertMarketOpen(
    symbolOrInstrument: string | InstrumentDefinition,
    referenceTime = new Date(),
  ): void {
    const res = this.getSessionStatus(symbolOrInstrument, referenceTime);
    if (!res.isOpen) {
      throw new BadRequestException(
        `[MARKET_CLOSED] Market for '${res.symbol}' on ${res.exchange} is currently ${res.sessionState}: ${res.reason}`,
      );
    }
  }

  /**
   * Calculates the next market open timestamp
   */
  public getNextMarketOpen(
    symbolOrInstrument: string | InstrumentDefinition,
    referenceTime = new Date(),
  ): Date {
    const meta = this.resolveInstrumentMetadata(symbolOrInstrument);
    const profile = this.scheduleProfiles.get(meta.exchange);
    if (!profile || profile.is24x7) {
      return new Date(referenceTime);
    }

    let cursor = new Date(referenceTime.getTime());

    // Advance in 10-minute increments up to 14 days ahead until session is OPEN
    for (let i = 0; i < 14 * 24 * 6; i++) {
      cursor = new Date(cursor.getTime() + 10 * 60 * 1000);
      const local = this.getExchangeLocalTime(cursor, profile.timezone);

      if (profile.weekendDays.includes(local.dayOfWeek)) continue;
      if (profile.holidays.includes(local.dateStr)) continue;

      if (local.timeMinutes >= 555 && local.timeMinutes < 930) {
        // Return exact 09:15 open timestamp
        const openDiffMinutes = local.timeMinutes - 555;
        return new Date(cursor.getTime() - openDiffMinutes * 60 * 1000 - local.second * 1000);
      }
    }

    return cursor;
  }

  /**
   * Calculates the next market close timestamp
   */
  public getNextMarketClose(
    symbolOrInstrument: string | InstrumentDefinition,
    referenceTime = new Date(),
  ): Date {
    const meta = this.resolveInstrumentMetadata(symbolOrInstrument);
    const profile = this.scheduleProfiles.get(meta.exchange);
    if (!profile || profile.is24x7) {
      // 24/7 crypto has no close
      return new Date(referenceTime.getTime() + 365 * 24 * 3600 * 1000);
    }

    let cursor = new Date(referenceTime.getTime());
    const local = this.getExchangeLocalTime(cursor, profile.timezone);

    if (local.timeMinutes < 930 && !profile.weekendDays.includes(local.dayOfWeek) && !profile.holidays.includes(local.dateStr)) {
      const closeDiffMinutes = 930 - local.timeMinutes;
      return new Date(cursor.getTime() + closeDiffMinutes * 60 * 1000 - local.second * 1000);
    }

    // Otherwise find next open and add regular trading duration
    const nextOpen = this.getNextMarketOpen(symbolOrInstrument, referenceTime);
    return new Date(nextOpen.getTime() + (930 - 555) * 60 * 1000);
  }
}
