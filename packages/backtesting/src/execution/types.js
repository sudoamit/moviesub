"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SameCandleAmbiguityMode = exports.FillModel = void 0;
var FillModel;
(function (FillModel) {
    FillModel["NEXT_BAR_MARKET"] = "NEXT_BAR_MARKET";
    FillModel["LIMIT_TOUCH"] = "LIMIT_TOUCH";
    FillModel["LIMIT_WITH_SLIPPAGE"] = "LIMIT_WITH_SLIPPAGE";
    FillModel["OHLC_PATH"] = "OHLC_PATH";
    FillModel["LOWER_TIMEFRAME"] = "LOWER_TIMEFRAME";
})(FillModel || (exports.FillModel = FillModel = {}));
var SameCandleAmbiguityMode;
(function (SameCandleAmbiguityMode) {
    SameCandleAmbiguityMode["CONSERVATIVE"] = "CONSERVATIVE";
    SameCandleAmbiguityMode["OPTIMISTIC"] = "OPTIMISTIC";
    SameCandleAmbiguityMode["OHLC_PATH"] = "OHLC_PATH";
    SameCandleAmbiguityMode["LOWER_TIMEFRAME"] = "LOWER_TIMEFRAME";
})(SameCandleAmbiguityMode || (exports.SameCandleAmbiguityMode = SameCandleAmbiguityMode = {}));
//# sourceMappingURL=types.js.map