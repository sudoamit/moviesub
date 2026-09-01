"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MTFMode = exports.BOSConfirmationType = exports.AlertChannel = exports.LiquidityType = exports.StructureType = exports.MarketRegimeType = exports.SignalGrade = exports.SignalState = exports.Direction = exports.Timeframe = exports.AssetType = exports.SubscriptionTier = exports.Role = void 0;
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
//# sourceMappingURL=index.js.map