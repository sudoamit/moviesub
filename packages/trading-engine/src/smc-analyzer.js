"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SMCAnalyzer = void 0;
const shared_1 = require("@quant/shared");
const swing_detector_1 = require("./swing-detector");
const bos_engine_1 = require("./bos-engine");
const choch_engine_1 = require("./choch-engine");
const liquidity_engine_1 = require("./liquidity-engine");
const fvg_engine_1 = require("./fvg-engine");
const order_block_engine_1 = require("./order-block-engine");
const dealing_range_1 = require("./dealing-range");
const market_regime_1 = require("./market-regime");
const candle_normalizer_1 = require("./candle-normalizer");
class SMCAnalyzer {
    /**
     * Performs full deterministic Smart Money Concepts (SMC) analysis on candle series
     * with strict point-in-time correctness.
     */
    static analyze(rawCandles, config = {}) {
        if (!rawCandles || rawCandles.length === 0) {
            return {
                candlesCount: 0,
                swingPoints: [],
                confirmedSwingHighs: [],
                confirmedSwingLows: [],
                breaksOfStructure: [],
                changesOfCharacter: [],
                liquidityPools: [],
                liquiditySweeps: [],
                fairValueGaps: [],
                activeFVGs: [],
                orderBlocks: [],
                activeOrderBlocks: [],
                dealingRange: null,
                marketRegime: {
                    regime: 'RANGE',
                    atr: 0,
                    adx: 0,
                    volatility: 0,
                    timestamp: new Date(),
                },
                currentTrend: shared_1.Direction.NEUTRAL,
            };
        }
        let candles = candle_normalizer_1.CandleNormalizer.normalize(rawCandles);
        if (config.asOfTimestamp) {
            candles = candle_normalizer_1.CandleNormalizer.getClosedCandlesAsOf(candles, config.timeframe, config.asOfTimestamp);
        }
        if (candles.length === 0) {
            return {
                candlesCount: 0,
                swingPoints: [],
                confirmedSwingHighs: [],
                confirmedSwingLows: [],
                breaksOfStructure: [],
                changesOfCharacter: [],
                liquidityPools: [],
                liquiditySweeps: [],
                fairValueGaps: [],
                activeFVGs: [],
                orderBlocks: [],
                activeOrderBlocks: [],
                dealingRange: null,
                marketRegime: {
                    regime: 'RANGE',
                    atr: 0,
                    adx: 0,
                    volatility: 0,
                    timestamp: config.asOfTimestamp || new Date(),
                },
                currentTrend: shared_1.Direction.NEUTRAL,
            };
        }
        // 1. Detect Swings (Zero look-ahead bias)
        const swingPoints = swing_detector_1.SwingDetector.detectSwings(candles, {
            leftBars: config.swingLeftBars,
            rightBars: config.swingRightBars,
            minDistanceAtrMultiplier: config.minSwingDistanceAtrMultiplier,
        });
        const confirmedSwingHighs = swingPoints.filter((s) => s.type === shared_1.StructureType.SWING_HIGH ||
            s.type === shared_1.StructureType.HIGHER_HIGH ||
            s.type === shared_1.StructureType.LOWER_HIGH);
        const confirmedSwingLows = swingPoints.filter((s) => s.type === shared_1.StructureType.SWING_LOW ||
            s.type === shared_1.StructureType.HIGHER_LOW ||
            s.type === shared_1.StructureType.LOWER_LOW);
        // 2. Detect Breaks of Structure (BOS)
        const breaksOfStructure = bos_engine_1.BOSEngine.detectBOS(candles, swingPoints, {
            displacementThresholdAtr: config.displacementThresholdAtr,
        });
        // 3. Detect Change of Character (CHoCH)
        const changesOfCharacter = choch_engine_1.CHOCHEngine.detectCHOCH(candles, swingPoints);
        // 4. Detect Liquidity Pools & Sweeps
        const { pools: liquidityPools, sweeps: liquiditySweeps } = liquidity_engine_1.LiquidityEngine.detectLiquidity(candles, swingPoints, {
            equalHighLowToleranceAtr: config.equalHighLowToleranceAtr,
        });
        // 5. Detect Fair Value Gaps (FVG)
        const { allFVGs: fairValueGaps, activeFVGs } = fvg_engine_1.FVGEngine.detectFVGs(candles, {
            minGapAtrMultiplier: config.fvgMinGapAtr,
            asOfTimestamp: config.asOfTimestamp,
            timeframe: String(config.timeframe || ''),
        });
        // 6. Detect Order Blocks (OB)
        const { allOrderBlocks: orderBlocks, activeOrderBlocks } = order_block_engine_1.OrderBlockEngine.detectOrderBlocks(candles, breaksOfStructure, fairValueGaps, {
            displacementThresholdAtr: config.displacementThresholdAtr,
            asOfTimestamp: config.asOfTimestamp,
            timeframe: String(config.timeframe || ''),
        });
        // 7. Calculate Dealing Range (Premium/Discount)
        const dealingRange = dealing_range_1.DealingRangeEngine.calculateDealingRange(swingPoints);
        // 8. Classify Market Regime
        const marketRegime = market_regime_1.MarketRegimeEngine.classifyRegime(candles, swingPoints);
        // Determine current structural trend from confirmed structure breaks at or before asOfTimestamp
        let currentTrend = shared_1.Direction.NEUTRAL;
        if (breaksOfStructure.length > 0) {
            currentTrend = breaksOfStructure[breaksOfStructure.length - 1].direction;
        }
        else if (changesOfCharacter.length > 0) {
            currentTrend = changesOfCharacter[changesOfCharacter.length - 1].direction;
        }
        return {
            candlesCount: candles.length,
            swingPoints,
            confirmedSwingHighs,
            confirmedSwingLows,
            breaksOfStructure,
            changesOfCharacter,
            liquidityPools,
            liquiditySweeps,
            fairValueGaps,
            activeFVGs,
            orderBlocks,
            activeOrderBlocks,
            dealingRange,
            marketRegime,
            currentTrend,
        };
    }
}
exports.SMCAnalyzer = SMCAnalyzer;
//# sourceMappingURL=smc-analyzer.js.map