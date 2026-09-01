"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BULLMQ_QUEUES = exports.WS_EVENTS = exports.REDIS_KEYS = exports.GRADE_THRESHOLDS = exports.DEFAULT_SCORING_WEIGHTS = exports.DEFAULT_TIMEFRAME_HIERARCHY = void 0;
exports.DEFAULT_TIMEFRAME_HIERARCHY = {
    higherTimeframe: '4h',
    intermediateTimeframe: '1h',
    setupTimeframe: '15m',
    entryTimeframe: '5m',
};
exports.DEFAULT_SCORING_WEIGHTS = {
    htfBias: 20,
    liquiditySweep: 15,
    bos: 15,
    fvg: 10,
    orderBlock: 10,
    displacement: 10,
    volumeConfirmation: 5,
    premiumDiscount: 5,
    riskReward: 5,
};
exports.GRADE_THRESHOLDS = {
    A_PLUS: 85,
    A: 80,
    B: 70,
    C: 60,
};
exports.REDIS_KEYS = {
    LATEST_CANDLE: (symbol, tf) => `candle:${symbol}:${tf}:latest`,
    CANDLE_BUFFER: (symbol, tf) => `candles:${symbol}:${tf}:buffer`,
    ACTIVE_SIGNALS: 'signals:active',
    SCANNER_RESULTS: 'scanner:results',
    MARKET_REGIME: (symbol) => `regime:${symbol}`,
};
exports.WS_EVENTS = {
    CANDLE_UPDATED: 'candle.updated',
    SIGNAL_CREATED: 'signal.created',
    SIGNAL_UPDATED: 'signal.updated',
    SIGNAL_CLOSED: 'signal.closed',
    MARKET_REGIME_CHANGED: 'market.regime.changed',
    SCANNER_UPDATED: 'scanner.updated',
};
exports.BULLMQ_QUEUES = {
    MARKET_DATA: 'market-data',
    CANDLE_PROCESSING: 'candle-processing',
    INDICATOR_CALCULATION: 'indicator-calculation',
    SMC_ANALYSIS: 'smc-analysis',
    SIGNAL_GENERATION: 'signal-generation',
    ALERT_PROCESSING: 'alert-processing',
};
//# sourceMappingURL=index.js.map