export declare const DEFAULT_TIMEFRAME_HIERARCHY: {
    higherTimeframe: string;
    intermediateTimeframe: string;
    setupTimeframe: string;
    entryTimeframe: string;
};
export declare const DEFAULT_SCORING_WEIGHTS: {
    htfBias: number;
    liquiditySweep: number;
    bos: number;
    fvg: number;
    orderBlock: number;
    displacement: number;
    volumeConfirmation: number;
    premiumDiscount: number;
    riskReward: number;
};
export declare const GRADE_THRESHOLDS: {
    A_PLUS: number;
    A: number;
    B: number;
    C: number;
};
export declare const REDIS_KEYS: {
    LATEST_CANDLE: (symbol: string, tf: string) => string;
    CANDLE_BUFFER: (symbol: string, tf: string) => string;
    ACTIVE_SIGNALS: string;
    SCANNER_RESULTS: string;
    MARKET_REGIME: (symbol: string) => string;
};
export declare const WS_EVENTS: {
    CANDLE_UPDATED: string;
    SIGNAL_CREATED: string;
    SIGNAL_UPDATED: string;
    SIGNAL_CLOSED: string;
    MARKET_REGIME_CHANGED: string;
    SCANNER_UPDATED: string;
};
export declare const BULLMQ_QUEUES: {
    MARKET_DATA: string;
    CANDLE_PROCESSING: string;
    INDICATOR_CALCULATION: string;
    SMC_ANALYSIS: string;
    SIGNAL_GENERATION: string;
    ALERT_PROCESSING: string;
};
//# sourceMappingURL=index.d.ts.map