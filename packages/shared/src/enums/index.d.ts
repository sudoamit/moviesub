export declare enum Role {
    USER = "USER",
    ADMIN = "ADMIN"
}
export declare enum SubscriptionTier {
    FREE = "FREE",
    PRO = "PRO",
    ADVANCED = "ADVANCED"
}
export declare enum AssetType {
    INDEX = "INDEX",
    EQUITY = "EQUITY",
    CRYPTO = "CRYPTO",
    COMMODITY = "COMMODITY",
    FOREX = "FOREX"
}
export declare enum Timeframe {
    M1 = "1m",
    M5 = "5m",
    M15 = "15m",
    M30 = "30m",
    H1 = "1h",
    H4 = "4h",
    D1 = "1d"
}
export declare enum Direction {
    BULLISH = "BULLISH",
    BEARISH = "BEARISH",
    NEUTRAL = "NEUTRAL"
}
export declare enum SignalState {
    PENDING = "PENDING",
    ACTIVE = "ACTIVE",
    TP1_HIT = "TP1_HIT",
    TP2_HIT = "TP2_HIT",
    TP3_HIT = "TP3_HIT",
    SL_HIT = "SL_HIT",
    EXPIRED = "EXPIRED",
    INVALIDATED = "INVALIDATED",
    CANCELLED = "CANCELLED"
}
export declare enum SignalGrade {
    A_PLUS = "A+",
    A = "A",
    B = "B",
    C = "C",
    NO_TRADE = "NO_TRADE"
}
export declare enum MarketRegimeType {
    BULLISH_TREND = "BULLISH_TREND",
    BEARISH_TREND = "BEARISH_TREND",
    RANGE = "RANGE",
    HIGH_VOLATILITY = "HIGH_VOLATILITY",
    LOW_VOLATILITY = "LOW_VOLATILITY"
}
export declare enum StructureType {
    SWING_HIGH = "SWING_HIGH",
    SWING_LOW = "SWING_LOW",
    HIGHER_HIGH = "HIGHER_HIGH",
    HIGHER_LOW = "HIGHER_LOW",
    LOWER_HIGH = "LOWER_HIGH",
    LOWER_LOW = "LOWER_LOW"
}
export declare enum LiquidityType {
    EQUAL_HIGHS = "EQUAL_HIGHS",
    EQUAL_LOWS = "EQUAL_LOWS",
    BUY_SIDE = "BUY_SIDE",
    SELL_SIDE = "SELL_SIDE"
}
export declare enum AlertChannel {
    WEB_PUSH = "WEB_PUSH",
    EMAIL = "EMAIL",
    TELEGRAM = "TELEGRAM"
}
export declare enum BOSConfirmationType {
    WICK_BREAK = "WICK_BREAK",
    CANDLE_CLOSE = "CANDLE_CLOSE",
    CANDLE_CLOSE_AND_DISPLACEMENT = "CANDLE_CLOSE_AND_DISPLACEMENT"
}
export declare enum MTFMode {
    STRICT = "STRICT",
    BALANCED = "BALANCED",
    AGGRESSIVE = "AGGRESSIVE"
}
export declare enum OrderState {
    CREATED = "CREATED",
    RISK_CHECKED = "RISK_CHECKED",
    REJECTED = "REJECTED",
    SUBMITTED = "SUBMITTED",
    ACKNOWLEDGED = "ACKNOWLEDGED",
    PARTIALLY_FILLED = "PARTIALLY_FILLED",
    FILLED = "FILLED",
    CANCEL_REQUESTED = "CANCEL_REQUESTED",
    CANCELLED = "CANCELLED",
    FAILED = "FAILED"
}
export declare enum PositionState {
    PENDING = "PENDING",
    OPEN = "OPEN",
    PARTIALLY_CLOSED = "PARTIALLY_CLOSED",
    CLOSING = "CLOSING",
    EXIT_PENDING = "EXIT_PENDING",
    CLOSED = "CLOSED",
    INVALIDATED = "INVALIDATED"
}
export declare enum ExecutionPriceSource {
    LIVE_TICK = "LIVE_TICK",
    LATEST_CANDLE = "LATEST_CANDLE",
    BACKTEST_CANDLE = "BACKTEST_CANDLE",
    SIMULATED_FILL = "SIMULATED_FILL"
}
export declare enum RetrainJobStatus {
    PENDING = "PENDING",
    RUNNING = "RUNNING",
    COMPLETED = "COMPLETED",
    FAILED = "FAILED"
}
export declare enum TradingMode {
    BACKTEST = "BACKTEST",
    PAPER = "PAPER",
    SHADOW = "SHADOW",
    LIVE = "LIVE"
}
export declare enum RiskRejectionReason {
    DAILY_LOSS_LIMIT = "DAILY_LOSS_LIMIT",
    POSITION_SIZE_LIMIT = "POSITION_SIZE_LIMIT",
    POSITION_RISK_LIMIT = "POSITION_RISK_LIMIT",
    EXPOSURE_LIMIT = "EXPOSURE_LIMIT",
    TOTAL_EXPOSURE_LIMIT = "TOTAL_EXPOSURE_LIMIT",
    TRADE_COUNT_LIMIT = "TRADE_COUNT_LIMIT",
    MAX_TRADES_PER_DAY = "MAX_TRADES_PER_DAY",
    MAX_OPEN_POSITIONS = "MAX_OPEN_POSITIONS",
    CONSECUTIVE_LOSS_LIMIT = "CONSECUTIVE_LOSS_LIMIT",
    MAX_CONSECUTIVE_LOSSES = "MAX_CONSECUTIVE_LOSSES",
    MAX_LEVERAGE = "MAX_LEVERAGE",
    INVALID_STOP_LOSS = "INVALID_STOP_LOSS",
    MISSING_STOP_LOSS = "MISSING_STOP_LOSS",
    INVALID_TAKE_PROFIT = "INVALID_TAKE_PROFIT",
    MISSING_TAKE_PROFIT = "MISSING_TAKE_PROFIT",
    INVALID_RISK_REWARD = "INVALID_RISK_REWARD",
    STALE_MARKET_DATA = "STALE_MARKET_DATA",
    MARKET_DATA_UNAVAILABLE = "MARKET_DATA_UNAVAILABLE",
    TRADING_DISABLED = "TRADING_DISABLED",
    DUPLICATE_ORDER = "DUPLICATE_ORDER",
    INSUFFICIENT_MARGIN = "INSUFFICIENT_MARGIN"
}
export declare function toPrismaTimeframe(tf: string | Timeframe): any;
