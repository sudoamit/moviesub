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

export function toPrismaTimeframe(tf: string | Timeframe): string {
  if (!tf || typeof tf !== 'string') {
    throw new Error('INVALID_TIMEFRAME: Timeframe must be a non-empty string');
  }
  const s = String(tf).toLowerCase().trim();
  switch (s) {
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
      throw new Error(`INVALID_TIMEFRAME: Unsupported timeframe '${tf}'. Supported timeframes: 1m, 5m, 15m, 30m, 1h, 4h, 1d`);
  }
}

export function toPrismaTimeframeOrDefault(
  tf: string | Timeframe | null | undefined,
  defaultTf: string | Timeframe = Timeframe.M15,
): string {
  if (!tf) {
    return toPrismaTimeframe(defaultTf);
  }
  try {
    return toPrismaTimeframe(tf);
  } catch {
    return toPrismaTimeframe(defaultTf);
  }
}

export function getTimeframeDurationMs(tf: string | Timeframe): number {
  const norm = String(tf).toLowerCase().trim();
  switch (norm) {
    case '1m':
    case 'm1':
      return 60 * 1000;
    case '5m':
    case 'm5':
      return 5 * 60 * 1000;
    case '15m':
    case 'm15':
      return 15 * 60 * 1000;
    case '30m':
    case 'm30':
      return 30 * 60 * 1000;
    case '1h':
    case 'h1':
    case '60m':
      return 60 * 60 * 1000;
    case '4h':
    case 'h4':
    case '240m':
      return 4 * 60 * 60 * 1000;
    case '1d':
    case 'd1':
      return 24 * 60 * 60 * 1000;
    default:
      return 15 * 60 * 1000;
  }
}

export enum Direction {
  BULLISH = 'BULLISH',
  BEARISH = 'BEARISH',
  NEUTRAL = 'NEUTRAL',
}

export enum PositionSide {
  LONG = 'LONG',
  SHORT = 'SHORT',
}

export function normalizeDirection(dir: Direction | PositionSide | string | undefined | null): PositionSide | 'NEUTRAL' {
  if (!dir) return 'NEUTRAL';
  const upper = String(dir).toUpperCase();
  if (upper === 'BULLISH' || upper === 'LONG') return PositionSide.LONG;
  if (upper === 'BEARISH' || upper === 'SHORT') return PositionSide.SHORT;
  return 'NEUTRAL';
}

export function isLongPosition(dir: Direction | PositionSide | string | undefined | null): boolean {
  if (!dir) return false;
  const upper = String(dir).toUpperCase();
  if (upper === 'BUY') return true;
  return normalizeDirection(dir) === PositionSide.LONG;
}

export function isShortPosition(dir: Direction | PositionSide | string | undefined | null): boolean {
  if (!dir) return false;
  const upper = String(dir).toUpperCase();
  if (upper === 'SELL') return true;
  return normalizeDirection(dir) === PositionSide.SHORT;
}

export function toOrderSide(
  dir: Direction | PositionSide | string | undefined | null,
  action: 'ENTRY' | 'EXIT' | boolean = 'ENTRY',
): 'BUY' | 'SELL' {
  const isLong = isLongPosition(dir);
  const isExit = action === 'EXIT' || action === true;
  if (isExit) {
    return isLong ? 'SELL' : 'BUY';
  }
  return isLong ? 'BUY' : 'SELL';
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

export enum OrderState {
  CREATED = 'CREATED',
  RISK_CHECKED = 'RISK_CHECKED',
  REJECTED = 'REJECTED',
  SUBMITTED = 'SUBMITTED',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  PARTIALLY_FILLED = 'PARTIALLY_FILLED',
  FILLED = 'FILLED',
  CANCEL_REQUESTED = 'CANCEL_REQUESTED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}

export enum PositionState {
  PENDING = 'PENDING',
  OPEN = 'OPEN',
  PARTIALLY_CLOSED = 'PARTIALLY_CLOSED',
  CLOSING = 'CLOSING',
  EXIT_PENDING = 'EXIT_PENDING',
  CLOSED = 'CLOSED',
  INVALIDATED = 'INVALIDATED',
}

export enum ExecutionPriceSource {
  LIVE_TICK = 'LIVE_TICK',
  LATEST_CANDLE = 'LATEST_CANDLE',
  BACKTEST_CANDLE = 'BACKTEST_CANDLE',
  SIMULATED_FILL = 'SIMULATED_FILL',
}

export enum RetrainJobStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export enum TradingMode {
  BACKTEST = 'BACKTEST',
  PAPER = 'PAPER',
  SHADOW = 'SHADOW',
  LIVE = 'LIVE',
}

export enum RiskRejectionReason {
  DAILY_LOSS_LIMIT = 'DAILY_LOSS_LIMIT',
  POSITION_SIZE_LIMIT = 'POSITION_SIZE_LIMIT',
  POSITION_RISK_LIMIT = 'POSITION_RISK_LIMIT',
  EXPOSURE_LIMIT = 'EXPOSURE_LIMIT',
  TOTAL_EXPOSURE_LIMIT = 'TOTAL_EXPOSURE_LIMIT',
  TRADE_COUNT_LIMIT = 'TRADE_COUNT_LIMIT',
  MAX_TRADES_PER_DAY = 'MAX_TRADES_PER_DAY',
  MAX_OPEN_POSITIONS = 'MAX_OPEN_POSITIONS',
  CONSECUTIVE_LOSS_LIMIT = 'CONSECUTIVE_LOSS_LIMIT',
  MAX_CONSECUTIVE_LOSSES = 'MAX_CONSECUTIVE_LOSSES',
  MAX_LEVERAGE = 'MAX_LEVERAGE',
  INVALID_STOP_LOSS = 'INVALID_STOP_LOSS',
  MISSING_STOP_LOSS = 'MISSING_STOP_LOSS',
  INVALID_TAKE_PROFIT = 'INVALID_TAKE_PROFIT',
  MISSING_TAKE_PROFIT = 'MISSING_TAKE_PROFIT',
  INVALID_RISK_REWARD = 'INVALID_RISK_REWARD',
  STALE_MARKET_DATA = 'STALE_MARKET_DATA',
  MARKET_DATA_UNAVAILABLE = 'MARKET_DATA_UNAVAILABLE',
  TRADING_DISABLED = 'TRADING_DISABLED',
  DUPLICATE_ORDER = 'DUPLICATE_ORDER',
  INSUFFICIENT_MARGIN = 'INSUFFICIENT_MARGIN',
}

export enum MarketDataSourceMode {
  LIVE_DECISION = 'LIVE_DECISION',
  BACKTEST = 'BACKTEST',
  LEARNING = 'LEARNING',
  CHART = 'CHART',
  HISTORICAL = 'HISTORICAL',
}

export enum TradeDecisionType {
  TAKE = 'TAKE',
  REJECT = 'REJECT',
}

export enum TradeLifecycleState {
  SIGNAL_DETECTED = 'SIGNAL_DETECTED',
  SIGNAL_VALIDATED = 'SIGNAL_VALIDATED',
  ELIGIBILITY_EVALUATED = 'ELIGIBILITY_EVALUATED',
  RISK_APPROVED = 'RISK_APPROVED',
  PRE_TRADE_APPROVED = 'PRE_TRADE_APPROVED',
  TRADE_TAKEN = 'TRADE_TAKEN',
  TRADE_REJECTED = 'TRADE_REJECTED',
  RESERVATION_CREATED = 'RESERVATION_CREATED',
  RESERVED = 'RESERVED',
  RESERVATION_FAILED = 'RESERVATION_FAILED',
  ORDER_SUBMITTED = 'ORDER_SUBMITTED',
  ORDER_REJECTED = 'ORDER_REJECTED',
  ORDER_PARTIALLY_FILLED = 'ORDER_PARTIALLY_FILLED',
  ORDER_FILLED = 'ORDER_FILLED',
  POSITION_OPENED = 'POSITION_OPENED',
  TP1_TRIGGERED = 'TP1_TRIGGERED',
  TP1_PARTIAL_FILLED = 'TP1_PARTIAL_FILLED',
  POSITION_PARTIALLY_CLOSED = 'POSITION_PARTIALLY_CLOSED',
  SL_MOVED_TO_BREAKEVEN = 'SL_MOVED_TO_BREAKEVEN',
  TP2_TRIGGERED = 'TP2_TRIGGERED',
  TP2_PARTIAL_FILLED = 'TP2_PARTIAL_FILLED',
  TRAILING = 'TRAILING',
  TP3_TRIGGERED = 'TP3_TRIGGERED',
  EXIT_TRIGGERED = 'EXIT_TRIGGERED',
  EXIT_PENDING = 'EXIT_PENDING',
  EXIT_SUBMITTED = 'EXIT_SUBMITTED',
  EXIT_FILLED = 'EXIT_FILLED',
  POSITION_CLOSED = 'POSITION_CLOSED',
  TRADE_CLOSED = 'TRADE_CLOSED',
  TRADE_FAILED = 'TRADE_FAILED',
  TRADE_CANCELLED = 'TRADE_CANCELLED',
}


