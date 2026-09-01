export const DEFAULT_TIMEFRAME_HIERARCHY = {
  higherTimeframe: '4h',
  intermediateTimeframe: '1h',
  setupTimeframe: '15m',
  entryTimeframe: '5m',
};

export const DEFAULT_SCORING_WEIGHTS = {
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

export const GRADE_THRESHOLDS = {
  A_PLUS: 85,
  A: 80,
  B: 70,
  C: 60,
};

export const REDIS_KEYS = {
  LATEST_CANDLE: (symbol: string, tf: string) => `candle:${symbol}:${tf}:latest`,
  CANDLE_BUFFER: (symbol: string, tf: string) => `candles:${symbol}:${tf}:buffer`,
  ACTIVE_SIGNALS: 'signals:active',
  SCANNER_RESULTS: 'scanner:results',
  MARKET_REGIME: (symbol: string) => `regime:${symbol}`,
};

export const WS_EVENTS = {
  CANDLE_UPDATED: 'candle.updated',
  SIGNAL_CREATED: 'signal.created',
  SIGNAL_GENERATED: 'signal.generated',
  SIGNAL_UPDATED: 'signal.updated',
  SIGNAL_CLOSED: 'signal.closed',
  MARKET_REGIME_CHANGED: 'market.regime.changed',
  SCANNER_UPDATED: 'scanner.updated',
  ALERT_TRIGGERED: 'alert.triggered',
};

export const BULLMQ_QUEUES = {
  MARKET_DATA: 'market-data',
  CANDLE_PROCESSING: 'candle-processing',
  INDICATOR_CALCULATION: 'indicator-calculation',
  SMC_ANALYSIS: 'smc-analysis',
  SIGNAL_GENERATION: 'signal-generation',
  ALERT_PROCESSING: 'alert-processing',
};
