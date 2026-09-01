export enum Role {
  USER = 'USER',
  ADMIN = 'ADMIN',
}

export enum SubscriptionTier {
  FREE = 'FREE',
  PRO = 'PRO',
  ADVANCED = 'ADVANCED',
}

export enum AssetType {
  INDEX = 'INDEX',
  EQUITY = 'EQUITY',
  CRYPTO = 'CRYPTO',
  COMMODITY = 'COMMODITY',
  FOREX = 'FOREX',
}

export enum Timeframe {
  M1 = '1m',
  M5 = '5m',
  M15 = '15m',
  M30 = '30m',
  H1 = '1h',
  H4 = '4h',
  D1 = '1d',
}

export enum Direction {
  BULLISH = 'BULLISH',
  BEARISH = 'BEARISH',
  NEUTRAL = 'NEUTRAL',
}

export enum SignalState {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  TP1_HIT = 'TP1_HIT',
  TP2_HIT = 'TP2_HIT',
  TP3_HIT = 'TP3_HIT',
  SL_HIT = 'SL_HIT',
  EXPIRED = 'EXPIRED',
  INVALIDATED = 'INVALIDATED',
  CANCELLED = 'CANCELLED',
}

export enum SignalGrade {
  A_PLUS = 'A+',
  A = 'A',
  B = 'B',
  C = 'C',
  NO_TRADE = 'NO_TRADE',
}

export enum MarketRegimeType {
  BULLISH_TREND = 'BULLISH_TREND',
  BEARISH_TREND = 'BEARISH_TREND',
  RANGE = 'RANGE',
  HIGH_VOLATILITY = 'HIGH_VOLATILITY',
  LOW_VOLATILITY = 'LOW_VOLATILITY',
}

export enum StructureType {
  SWING_HIGH = 'SWING_HIGH',
  SWING_LOW = 'SWING_LOW',
  HIGHER_HIGH = 'HIGHER_HIGH',
  HIGHER_LOW = 'HIGHER_LOW',
  LOWER_HIGH = 'LOWER_HIGH',
  LOWER_LOW = 'LOWER_LOW',
}

export enum LiquidityType {
  EQUAL_HIGHS = 'EQUAL_HIGHS',
  EQUAL_LOWS = 'EQUAL_LOWS',
  BUY_SIDE = 'BUY_SIDE',
  SELL_SIDE = 'SELL_SIDE',
}

export enum AlertChannel {
  WEB_PUSH = 'WEB_PUSH',
  EMAIL = 'EMAIL',
  TELEGRAM = 'TELEGRAM',
}

export enum BOSConfirmationType {
  WICK_BREAK = 'WICK_BREAK',
  CANDLE_CLOSE = 'CANDLE_CLOSE',
  CANDLE_CLOSE_AND_DISPLACEMENT = 'CANDLE_CLOSE_AND_DISPLACEMENT',
}

export enum MTFMode {
  STRICT = 'STRICT',
  BALANCED = 'BALANCED',
  AGGRESSIVE = 'AGGRESSIVE',
}

export function toPrismaTimeframe(tf: string | Timeframe): any {
  const str = String(tf).toLowerCase();
  switch (str) {
    case '1m':
    case 'm1':
      return 'M1';
    case '5m':
    case 'm5':
      return 'M5';
    case '15m':
    case 'm15':
      return 'M15';
    case '30m':
    case 'm30':
      return 'M30';
    case '1h':
    case 'h1':
      return 'H1';
    case '4h':
    case 'h4':
      return 'H4';
    case '1d':
    case 'd1':
      return 'D1';
    default:
      return 'M15';
  }
}
