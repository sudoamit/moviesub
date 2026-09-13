import { Timeframe } from '../enums';

export interface ITimeframeDefinition {
  readonly timeframe: Timeframe;
  readonly prismaEnum: string;
  readonly durationMs: number;
  readonly durationMinutes: number;
  readonly binanceInterval: string;
  readonly yahooInterval: string;
  readonly isIntraday: boolean;
}

export class TimeframeRegistry {
  private static readonly DEFINITIONS: Record<string, ITimeframeDefinition> = {
    '1m': {
      timeframe: Timeframe.M1,
      prismaEnum: 'M1',
      durationMs: 60 * 1000,
      durationMinutes: 1,
      binanceInterval: '1m',
      yahooInterval: '1m',
      isIntraday: true,
    },
    'm1': {
      timeframe: Timeframe.M1,
      prismaEnum: 'M1',
      durationMs: 60 * 1000,
      durationMinutes: 1,
      binanceInterval: '1m',
      yahooInterval: '1m',
      isIntraday: true,
    },
    '5m': {
      timeframe: Timeframe.M5,
      prismaEnum: 'M5',
      durationMs: 5 * 60 * 1000,
      durationMinutes: 5,
      binanceInterval: '5m',
      yahooInterval: '5m',
      isIntraday: true,
    },
    'm5': {
      timeframe: Timeframe.M5,
      prismaEnum: 'M5',
      durationMs: 5 * 60 * 1000,
      durationMinutes: 5,
      binanceInterval: '5m',
      yahooInterval: '5m',
      isIntraday: true,
    },
    '15m': {
      timeframe: Timeframe.M15,
      prismaEnum: 'M15',
      durationMs: 15 * 60 * 1000,
      durationMinutes: 15,
      binanceInterval: '15m',
      yahooInterval: '15m',
      isIntraday: true,
    },
    'm15': {
      timeframe: Timeframe.M15,
      prismaEnum: 'M15',
      durationMs: 15 * 60 * 1000,
      durationMinutes: 15,
      binanceInterval: '15m',
      yahooInterval: '15m',
      isIntraday: true,
    },
    '30m': {
      timeframe: Timeframe.M30,
      prismaEnum: 'M30',
      durationMs: 30 * 60 * 1000,
      durationMinutes: 30,
      binanceInterval: '30m',
      yahooInterval: '30m',
      isIntraday: true,
    },
    'm30': {
      timeframe: Timeframe.M30,
      prismaEnum: 'M30',
      durationMs: 30 * 60 * 1000,
      durationMinutes: 30,
      binanceInterval: '30m',
      yahooInterval: '30m',
      isIntraday: true,
    },
    '1h': {
      timeframe: Timeframe.H1,
      prismaEnum: 'H1',
      durationMs: 60 * 60 * 1000,
      durationMinutes: 60,
      binanceInterval: '1h',
      yahooInterval: '60m',
      isIntraday: true,
    },
    'h1': {
      timeframe: Timeframe.H1,
      prismaEnum: 'H1',
      durationMs: 60 * 60 * 1000,
      durationMinutes: 60,
      binanceInterval: '1h',
      yahooInterval: '60m',
      isIntraday: true,
    },
    '60m': {
      timeframe: Timeframe.H1,
      prismaEnum: 'H1',
      durationMs: 60 * 60 * 1000,
      durationMinutes: 60,
      binanceInterval: '1h',
      yahooInterval: '60m',
      isIntraday: true,
    },
    '4h': {
      timeframe: Timeframe.H4,
      prismaEnum: 'H4',
      durationMs: 4 * 60 * 60 * 1000,
      durationMinutes: 240,
      binanceInterval: '4h',
      yahooInterval: '60m',
      isIntraday: true,
    },
    'h4': {
      timeframe: Timeframe.H4,
      prismaEnum: 'H4',
      durationMs: 4 * 60 * 60 * 1000,
      durationMinutes: 240,
      binanceInterval: '4h',
      yahooInterval: '60m',
      isIntraday: true,
    },
    '240m': {
      timeframe: Timeframe.H4,
      prismaEnum: 'H4',
      durationMs: 4 * 60 * 60 * 1000,
      durationMinutes: 240,
      binanceInterval: '4h',
      yahooInterval: '60m',
      isIntraday: true,
    },
    '1d': {
      timeframe: Timeframe.D1,
      prismaEnum: 'D1',
      durationMs: 24 * 60 * 60 * 1000,
      durationMinutes: 1440,
      binanceInterval: '1d',
      yahooInterval: '1d',
      isIntraday: false,
    },
    'd1': {
      timeframe: Timeframe.D1,
      prismaEnum: 'D1',
      durationMs: 24 * 60 * 60 * 1000,
      durationMinutes: 1440,
      binanceInterval: '1d',
      yahooInterval: '1d',
      isIntraday: false,
    },
  };

  /**
   * Resolves canonical timeframe definition.
   * Throws INVALID_TIMEFRAME on unsupported values.
   */
  static get(tf: string | Timeframe): ITimeframeDefinition {
    if (!tf || typeof tf !== 'string') {
      throw new Error(`INVALID_TIMEFRAME: Timeframe must be a non-empty string, got '${tf}'`);
    }
    const key = String(tf).toLowerCase().trim();
    const def = this.DEFINITIONS[key];
    if (!def) {
      throw new Error(
        `INVALID_TIMEFRAME: Unsupported timeframe '${tf}'. Supported timeframes: 1m, 5m, 15m, 30m, 1h, 4h, 1d`,
      );
    }
    return def;
  }

  static getDurationMs(tf: string | Timeframe): number {
    return this.get(tf).durationMs;
  }

  static getDurationMinutes(tf: string | Timeframe): number {
    return this.get(tf).durationMinutes;
  }

  static toPrisma(tf: string | Timeframe): string {
    return this.get(tf).prismaEnum;
  }

  static toPrismaOrDefault(
    tf: string | Timeframe | null | undefined,
    defaultTf: string | Timeframe = Timeframe.M15,
  ): string {
    if (!tf) {
      return this.toPrisma(defaultTf);
    }
    try {
      return this.toPrisma(tf);
    } catch {
      return this.toPrisma(defaultTf);
    }
  }

  static getBinanceInterval(tf: string | Timeframe): string {
    return this.get(tf).binanceInterval;
  }

  static getYahooInterval(tf: string | Timeframe): string {
    return this.get(tf).yahooInterval;
  }

  static isHigherTimeframe(htf: string | Timeframe, ltf: string | Timeframe): boolean {
    return this.getDurationMs(htf) > this.getDurationMs(ltf);
  }
}
