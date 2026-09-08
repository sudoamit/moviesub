"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CANONICAL_V2_DIMENSION = exports.CANONICAL_FEATURE_NAMES_V2 = exports.CANONICAL_FEATURE_SCHEMA_VERSION = void 0;
/**
 * Canonical Feature Schema Version
 * Increment this version whenever features or their ordering change.
 */
exports.CANONICAL_FEATURE_SCHEMA_VERSION = '2.0';
/**
 * 28 Canonical V2 Features strictly ordered.
 */
exports.CANONICAL_FEATURE_NAMES_V2 = [
    // 1-17 Core SMC & Market Context
    'smcScore',
    'obStrength',
    'fvgSize',
    'mtfAlignment',
    'killZoneSession',
    'smtDivergence',
    'volatilityAtr',
    'riskRewardRatio',
    'trendRegime',
    'liquiditySweep',
    'bosStrength',
    'chochStrength',
    'relativeVolume',
    'distanceToHTFLevel',
    'distanceToLiquidity',
    'marketSession',
    'dayOfWeek',
    // 18-28 Quantitative & Statistical Features
    'return1Bar',
    'return5Bar',
    'return20Bar',
    'returnSkewness',
    'parkinsonVolatility',
    'garmanKlassVolatility',
    'forecastVolatility',
    'volatilityPercentile',
    'distanceToVwap',
    'bollingerPosition',
    'multiHorizonConfluence',
];
exports.CANONICAL_V2_DIMENSION = exports.CANONICAL_FEATURE_NAMES_V2.length;
//# sourceMappingURL=quant-types.js.map