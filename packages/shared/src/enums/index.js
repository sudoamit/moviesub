"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RiskRejectionReason = exports.TradingMode = exports.RetrainJobStatus = exports.ExecutionPriceSource = exports.PositionState = exports.OrderState = exports.MTFMode = exports.BOSConfirmationType = exports.AlertChannel = exports.LiquidityType = exports.StructureType = exports.MarketRegimeType = exports.SignalGrade = exports.SignalState = exports.Direction = exports.Timeframe = exports.AssetType = exports.SubscriptionTier = exports.Role = void 0;
exports.toPrismaTimeframe = toPrismaTimeframe;
var Role;
(function (Role) {
    Role["USER"] = "USER";
    Role["ADMIN"] = "ADMIN";
})(Role || (exports.Role = Role = {}));
var SubscriptionTier;
(function (SubscriptionTier) {
    SubscriptionTier["FREE"] = "FREE";
    SubscriptionTier["PRO"] = "PRO";
    SubscriptionTier["ADVANCED"] = "ADVANCED";
})(SubscriptionTier || (exports.SubscriptionTier = SubscriptionTier = {}));
var AssetType;
(function (AssetType) {
    AssetType["INDEX"] = "INDEX";
    AssetType["EQUITY"] = "EQUITY";
    AssetType["CRYPTO"] = "CRYPTO";
    AssetType["COMMODITY"] = "COMMODITY";
    AssetType["FOREX"] = "FOREX";
})(AssetType || (exports.AssetType = AssetType = {}));
var Timeframe;
(function (Timeframe) {
    Timeframe["M1"] = "1m";
    Timeframe["M5"] = "5m";
    Timeframe["M15"] = "15m";
    Timeframe["M30"] = "30m";
    Timeframe["H1"] = "1h";
    Timeframe["H4"] = "4h";
    Timeframe["D1"] = "1d";
})(Timeframe || (exports.Timeframe = Timeframe = {}));
var Direction;
(function (Direction) {
    Direction["BULLISH"] = "BULLISH";
    Direction["BEARISH"] = "BEARISH";
    Direction["NEUTRAL"] = "NEUTRAL";
})(Direction || (exports.Direction = Direction = {}));
var SignalState;
(function (SignalState) {
    SignalState["PENDING"] = "PENDING";
    SignalState["ACTIVE"] = "ACTIVE";
    SignalState["TP1_HIT"] = "TP1_HIT";
    SignalState["TP2_HIT"] = "TP2_HIT";
    SignalState["TP3_HIT"] = "TP3_HIT";
    SignalState["SL_HIT"] = "SL_HIT";
    SignalState["EXPIRED"] = "EXPIRED";
    SignalState["INVALIDATED"] = "INVALIDATED";
    SignalState["CANCELLED"] = "CANCELLED";
})(SignalState || (exports.SignalState = SignalState = {}));
var SignalGrade;
(function (SignalGrade) {
    SignalGrade["A_PLUS"] = "A+";
    SignalGrade["A"] = "A";
    SignalGrade["B"] = "B";
    SignalGrade["C"] = "C";
    SignalGrade["NO_TRADE"] = "NO_TRADE";
})(SignalGrade || (exports.SignalGrade = SignalGrade = {}));
var MarketRegimeType;
(function (MarketRegimeType) {
    MarketRegimeType["BULLISH_TREND"] = "BULLISH_TREND";
    MarketRegimeType["BEARISH_TREND"] = "BEARISH_TREND";
    MarketRegimeType["RANGE"] = "RANGE";
    MarketRegimeType["HIGH_VOLATILITY"] = "HIGH_VOLATILITY";
    MarketRegimeType["LOW_VOLATILITY"] = "LOW_VOLATILITY";
})(MarketRegimeType || (exports.MarketRegimeType = MarketRegimeType = {}));
var StructureType;
(function (StructureType) {
    StructureType["SWING_HIGH"] = "SWING_HIGH";
    StructureType["SWING_LOW"] = "SWING_LOW";
    StructureType["HIGHER_HIGH"] = "HIGHER_HIGH";
    StructureType["HIGHER_LOW"] = "HIGHER_LOW";
    StructureType["LOWER_HIGH"] = "LOWER_HIGH";
    StructureType["LOWER_LOW"] = "LOWER_LOW";
})(StructureType || (exports.StructureType = StructureType = {}));
var LiquidityType;
(function (LiquidityType) {
    LiquidityType["EQUAL_HIGHS"] = "EQUAL_HIGHS";
    LiquidityType["EQUAL_LOWS"] = "EQUAL_LOWS";
    LiquidityType["BUY_SIDE"] = "BUY_SIDE";
    LiquidityType["SELL_SIDE"] = "SELL_SIDE";
})(LiquidityType || (exports.LiquidityType = LiquidityType = {}));
var AlertChannel;
(function (AlertChannel) {
    AlertChannel["WEB_PUSH"] = "WEB_PUSH";
    AlertChannel["EMAIL"] = "EMAIL";
    AlertChannel["TELEGRAM"] = "TELEGRAM";
})(AlertChannel || (exports.AlertChannel = AlertChannel = {}));
var BOSConfirmationType;
(function (BOSConfirmationType) {
    BOSConfirmationType["WICK_BREAK"] = "WICK_BREAK";
    BOSConfirmationType["CANDLE_CLOSE"] = "CANDLE_CLOSE";
    BOSConfirmationType["CANDLE_CLOSE_AND_DISPLACEMENT"] = "CANDLE_CLOSE_AND_DISPLACEMENT";
})(BOSConfirmationType || (exports.BOSConfirmationType = BOSConfirmationType = {}));
var MTFMode;
(function (MTFMode) {
    MTFMode["STRICT"] = "STRICT";
    MTFMode["BALANCED"] = "BALANCED";
    MTFMode["AGGRESSIVE"] = "AGGRESSIVE";
})(MTFMode || (exports.MTFMode = MTFMode = {}));
var OrderState;
(function (OrderState) {
    OrderState["CREATED"] = "CREATED";
    OrderState["RISK_CHECKED"] = "RISK_CHECKED";
    OrderState["REJECTED"] = "REJECTED";
    OrderState["SUBMITTED"] = "SUBMITTED";
    OrderState["ACKNOWLEDGED"] = "ACKNOWLEDGED";
    OrderState["PARTIALLY_FILLED"] = "PARTIALLY_FILLED";
    OrderState["FILLED"] = "FILLED";
    OrderState["CANCEL_REQUESTED"] = "CANCEL_REQUESTED";
    OrderState["CANCELLED"] = "CANCELLED";
    OrderState["FAILED"] = "FAILED";
})(OrderState || (exports.OrderState = OrderState = {}));
var PositionState;
(function (PositionState) {
    PositionState["PENDING"] = "PENDING";
    PositionState["OPEN"] = "OPEN";
    PositionState["PARTIALLY_CLOSED"] = "PARTIALLY_CLOSED";
    PositionState["CLOSING"] = "CLOSING";
    PositionState["EXIT_PENDING"] = "EXIT_PENDING";
    PositionState["CLOSED"] = "CLOSED";
    PositionState["INVALIDATED"] = "INVALIDATED";
})(PositionState || (exports.PositionState = PositionState = {}));
var ExecutionPriceSource;
(function (ExecutionPriceSource) {
    ExecutionPriceSource["LIVE_TICK"] = "LIVE_TICK";
    ExecutionPriceSource["LATEST_CANDLE"] = "LATEST_CANDLE";
    ExecutionPriceSource["BACKTEST_CANDLE"] = "BACKTEST_CANDLE";
    ExecutionPriceSource["SIMULATED_FILL"] = "SIMULATED_FILL";
})(ExecutionPriceSource || (exports.ExecutionPriceSource = ExecutionPriceSource = {}));
var RetrainJobStatus;
(function (RetrainJobStatus) {
    RetrainJobStatus["PENDING"] = "PENDING";
    RetrainJobStatus["RUNNING"] = "RUNNING";
    RetrainJobStatus["COMPLETED"] = "COMPLETED";
    RetrainJobStatus["FAILED"] = "FAILED";
})(RetrainJobStatus || (exports.RetrainJobStatus = RetrainJobStatus = {}));
var TradingMode;
(function (TradingMode) {
    TradingMode["BACKTEST"] = "BACKTEST";
    TradingMode["PAPER"] = "PAPER";
    TradingMode["SHADOW"] = "SHADOW";
    TradingMode["LIVE"] = "LIVE";
})(TradingMode || (exports.TradingMode = TradingMode = {}));
var RiskRejectionReason;
(function (RiskRejectionReason) {
    RiskRejectionReason["DAILY_LOSS_LIMIT"] = "DAILY_LOSS_LIMIT";
    RiskRejectionReason["POSITION_SIZE_LIMIT"] = "POSITION_SIZE_LIMIT";
    RiskRejectionReason["POSITION_RISK_LIMIT"] = "POSITION_RISK_LIMIT";
    RiskRejectionReason["EXPOSURE_LIMIT"] = "EXPOSURE_LIMIT";
    RiskRejectionReason["TOTAL_EXPOSURE_LIMIT"] = "TOTAL_EXPOSURE_LIMIT";
    RiskRejectionReason["TRADE_COUNT_LIMIT"] = "TRADE_COUNT_LIMIT";
    RiskRejectionReason["MAX_TRADES_PER_DAY"] = "MAX_TRADES_PER_DAY";
    RiskRejectionReason["MAX_OPEN_POSITIONS"] = "MAX_OPEN_POSITIONS";
    RiskRejectionReason["CONSECUTIVE_LOSS_LIMIT"] = "CONSECUTIVE_LOSS_LIMIT";
    RiskRejectionReason["MAX_CONSECUTIVE_LOSSES"] = "MAX_CONSECUTIVE_LOSSES";
    RiskRejectionReason["MAX_LEVERAGE"] = "MAX_LEVERAGE";
    RiskRejectionReason["INVALID_STOP_LOSS"] = "INVALID_STOP_LOSS";
    RiskRejectionReason["MISSING_STOP_LOSS"] = "MISSING_STOP_LOSS";
    RiskRejectionReason["INVALID_TAKE_PROFIT"] = "INVALID_TAKE_PROFIT";
    RiskRejectionReason["MISSING_TAKE_PROFIT"] = "MISSING_TAKE_PROFIT";
    RiskRejectionReason["INVALID_RISK_REWARD"] = "INVALID_RISK_REWARD";
    RiskRejectionReason["STALE_MARKET_DATA"] = "STALE_MARKET_DATA";
    RiskRejectionReason["MARKET_DATA_UNAVAILABLE"] = "MARKET_DATA_UNAVAILABLE";
    RiskRejectionReason["TRADING_DISABLED"] = "TRADING_DISABLED";
    RiskRejectionReason["DUPLICATE_ORDER"] = "DUPLICATE_ORDER";
    RiskRejectionReason["INSUFFICIENT_MARGIN"] = "INSUFFICIENT_MARGIN";
})(RiskRejectionReason || (exports.RiskRejectionReason = RiskRejectionReason = {}));
function toPrismaTimeframe(tf) {
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
//# sourceMappingURL=index.js.map