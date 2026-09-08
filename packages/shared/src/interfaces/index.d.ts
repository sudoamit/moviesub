import { AssetType, Direction, LiquidityType, MarketRegimeType, SignalGrade, SignalState, StructureType, Timeframe } from '../enums';
export interface ICandle {
    timestamp: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    isClosed?: boolean;
}
export interface IInstrument {
    id: string;
    symbol: string;
    name: string;
    exchange: string;
    assetType: AssetType;
    tickSize: number;
    lotSize: number;
    contractSize: number;
    currency: string;
    tradingHoursJson?: Record<string, any> | null;
    isActive: boolean;
    createdAt?: Date;
    updatedAt?: Date;
}
export interface ISwingPoint {
    index: number;
    type: StructureType;
    price: number;
    timestamp: Date;
    confirmedAtIndex: number;
    confirmedAtTimestamp: Date;
}
export interface IBreakOfStructure {
    direction: Direction;
    brokenLevel: number;
    brokenSwingPoint: ISwingPoint;
    breakPrice: number;
    candleIndex: number;
    timestamp: Date;
    isConfirmed: boolean;
    displacementRatio: number;
}
export interface IChangeOfCharacter {
    direction: Direction;
    previousTrend: Direction;
    brokenLevel: number;
    candleIndex: number;
    timestamp: Date;
    strength: number;
}
export interface ILiquidityPool {
    id: string;
    type: LiquidityType;
    priceLevel: number;
    firstTimestamp: Date;
    lastTimestamp: Date;
    touchCount: number;
    isSwept: boolean;
    sweptAtIndex?: number;
    sweptTimestamp?: Date;
    sweptPrice?: number;
    displacement?: number;
    availableAtIndex?: number;
    availableAtTimestamp?: Date;
}
export interface IFairValueGap {
    id: string;
    direction: Direction;
    upperBound: number;
    lowerBound: number;
    candleIndex: number;
    timestamp: Date;
    isFilled: boolean;
    fillPercentage: number;
    isInvalidated: boolean;
    status?: 'ACTIVE' | 'PARTIALLY_FILLED' | 'FILLED' | 'INVALIDATED';
    createdAt?: Date;
    confirmedAt?: Date;
    filledAtIndex?: number;
    filledAtTimestamp?: Date;
    invalidatedAtIndex?: number;
    invalidatedAtTimestamp?: Date;
    filledAt?: Date;
    invalidatedAt?: Date;
}
export interface IOrderBlock {
    id: string;
    direction: Direction;
    high: number;
    low: number;
    candleIndex: number;
    timestamp: Date;
    isMitigated: boolean;
    mitigatedAtIndex?: number;
    isInvalidated: boolean;
    strength: number;
    status?: 'CANDIDATE' | 'CONFIRMED' | 'ACTIVE' | 'MITIGATED' | 'INVALIDATED';
    createdAt?: Date;
    confirmedAtIndex?: number;
    confirmedAtTimestamp?: Date;
    mitigatedAtTimestamp?: Date;
    invalidatedAtIndex?: number;
    invalidatedAtTimestamp?: Date;
    confirmedAt?: Date;
    mitigatedAt?: Date;
    invalidatedAt?: Date;
}
export interface IDealingRange {
    high: number;
    low: number;
    equilibrium: number;
    premiumZone: {
        min: number;
        max: number;
    };
    discountZone: {
        min: number;
        max: number;
    };
}
export interface IMarketRegime {
    regime: MarketRegimeType;
    atr: number;
    adx: number;
    volatility: number;
    timestamp: Date;
}
export interface IScoreBreakdown {
    htfBias: number;
    liquiditySweep: number;
    bos: number;
    fvg: number;
    orderBlock: number;
    displacement: number;
    volumeConfirmation: number;
    premiumDiscount: number;
    riskReward: number;
    indicatorAlignment: number;
    totalScore: number;
    grade: SignalGrade;
}
export interface ISignalReasoning {
    htfStructure: string;
    liquidityReason: string;
    triggerReason: string;
    invalidationReason: string;
    confirmedChecklist: string[];
    summary: string;
}
export interface ISignalSetup {
    id?: string;
    instrumentId?: string;
    symbol: string;
    timeframe: Timeframe | string;
    direction: Direction;
    state: SignalState;
    grade: SignalGrade;
    score: number;
    htfBias?: Direction;
    entryZone: {
        min: number;
        max: number;
        optimal: number;
    };
    stopLoss: number;
    takeProfits: {
        tp1: number;
        tp2: number;
        tp3: number;
    };
    riskRewardRatios: {
        rr1: number;
        rr2: number;
        rr3: number;
    };
    reasoning: ISignalReasoning;
    reasons?: string[];
    risks?: string[];
    scoreBreakdown: IScoreBreakdown;
    activatedAt?: Date;
    closedAt?: Date;
    exitPrice?: number;
    pnlAmount?: number;
    pnlRMultiple?: number;
    timestamp?: Date;
    createdAt?: Date;
    quantSnapshot?: any;
    quantScore?: any;
    regime?: string;
    volatilityPercentile?: number;
    forecastVolatility?: number;
    mlProbability?: number | null;
    expectedR?: number | null;
    decisionTrace?: any;
}
export interface IPositionSizing {
    accountBalance: number;
    riskPercentage: number;
    riskAmount: number;
    entryPrice: number;
    stopLoss: number;
    riskPerUnit: number;
    calculatedUnits: number;
    lotSize: number;
    roundedUnits: number;
    totalPositionValue: number;
    maximumLoss: number;
    isValid: boolean;
    rejectionReason?: string;
}
export interface IMarketDataProvider {
    readonly providerName: string;
    getHistoricalCandles(symbol: string, timeframe: Timeframe, limit: number, endTime?: Date): Promise<ICandle[]>;
    getLatestCandle(symbol: string, timeframe: Timeframe): Promise<ICandle>;
    subscribeToMarketData(symbol: string, timeframe: Timeframe, onCandle: (candle: ICandle) => void): Promise<void>;
    unsubscribeFromMarketData(symbol: string, timeframe: Timeframe): Promise<void>;
}
export interface IBacktestConfig {
    instrumentId: string;
    symbol: string;
    timeframe: Timeframe;
    startDate: Date;
    endDate: Date;
    initialCapital: number;
    riskPerTradePercent: number;
    minScore: number;
    strategyConfig: Record<string, any>;
}
export interface IBacktestResult {
    id: string;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    profitFactor: number;
    netPnL: number;
    averageR: number;
    expectancy: number;
    maxDrawdownPercent: number;
    maxConsecutiveLosses: number;
    sharpeRatio?: number;
    trades: IBacktestTrade[];
}
export interface IEntryExecutionSnapshot {
    entryPrice: number;
    referencePrice: number;
    quantity: number;
    fee: number;
    slippage: number;
    signalTimestamp: number;
    executionTimestamp: number;
    orderCreatedAt?: number;
    orderSubmittedAt?: number;
    orderId?: string;
    clientOrderId?: string;
    side: 'BUY' | 'SELL';
    initialStopLoss: number;
    tp1: number;
    tp2: number;
    tp3: number;
}
export interface IBacktestTrade {
    id: string;
    direction: Direction;
    entryTime: Date;
    entryPrice: number;
    exitTime: Date;
    exitPrice: number;
    stopLoss: number;
    takeProfit: number;
    positionSize: number;
    marginRequired?: number;
    riskAmount?: number;
    pnl: number;
    pnlRMultiple: number;
    exitReason: SignalState;
    signalTimestamp?: Date;
    orderCreatedAt?: Date;
    orderSubmittedAt?: Date;
    entryFillTimestamp?: Date;
    entryReferencePrice?: number;
    entryFillPrice?: number;
    entryFees?: number;
    entrySlippage?: number;
    exitOrderTimestamp?: Date;
    exitOrderCreatedAt?: Date;
    exitOrderSubmittedAt?: Date;
    exitTriggerTimestamp?: Date;
    exitFillTimestamp?: Date;
    exitFillPrice?: number;
    exitFees?: number;
    exitSlippage?: number;
    grossPnL?: number;
    netPnL?: number;
    realizedR?: number;
    fillModel?: string;
    ambiguityMode?: string;
    entrySnapshot?: IEntryExecutionSnapshot;
}
/**
 * Production Market Data Quality & Integrity Validation Result
 */
export interface IMarketDataQualityResult {
    isValid: boolean;
    symbol: string;
    timeframe: string;
    checkedAt: Date;
    staleData: boolean;
    missingCandlesCount: number;
    duplicateCandlesCount: number;
    abnormalPriceJumpsCount: number;
    zeroVolumeCount: number;
    feedDisconnected: boolean;
    reasons: string[];
}
/**
 * Standardized Autonomous SMC Confluence Setup Payload
 */
export interface ISMCConfluenceSetup {
    instrument: string;
    direction: 'LONG' | 'SHORT' | 'BULLISH' | 'BEARISH';
    entry_zone: {
        min: number;
        max: number;
        optimal: number;
    };
    stop_loss: {
        price: number;
        risk_pts: number;
        risk_percent: number;
    };
    tp1: {
        price: number;
        reward_r: number;
    };
    tp2: {
        price: number;
        reward_r: number;
    };
    tp3: {
        price: number;
        reward_r: number;
    };
    risk_reward: number;
    setup_timestamp: string;
    smc_score: number;
    confluenceChecklist: string[];
}
/**
 * 17-Dimensional Normalized Quantitative Feature Vector with Full Audit Trail
 */
export interface IFeatureVector17D {
    htfTrendAlignment: number;
    trend4H: number;
    trend1H: number;
    structure15M: number;
    bosChochQuality: number;
    orderBlockStrength: number;
    fvgSize: number;
    fvgFillPct: number;
    liquiditySweepDepth: number;
    displacementIntensity: number;
    atrVolatility: number;
    volumeImbalance: number;
    cvd: number;
    volumeProfilePocProximity: number;
    sessionKillZone: number;
    marketRegime: number;
    smtDivergence: number;
    feature_timestamp: string;
    source_candle_timestamp: string;
    calculation_timestamp: string;
}
/**
 * 12-Factor Execution Safety Gate Decision
 */
export interface IExecutionSafetyDecision {
    isApproved: boolean;
    mode: 'PAPER' | 'LIVE';
    checks: Record<string, {
        passed: boolean;
        message: string;
        value?: any;
    }>;
    rejectionReasons: string[];
    checkedAt: Date;
}
/**
 * Comprehensive Post-Trade Audit Record & Outcome Classification
 */
export interface IPostTradeAuditRecord {
    tradeId: string;
    symbol: string;
    direction: Direction;
    setupTimestamp: Date;
    featureVector: IFeatureVector17D;
    modelPrediction: {
        rawPWin: number;
        calibratedPWin: number;
        expectedR: number;
        confidence: string;
    };
    riskDecision: {
        approved: boolean;
        positionUnits: number;
        stopLossPrice: number;
        maxRiskAmount: number;
    };
    execution: {
        entryPrice: number;
        exitPrice: number;
        slippage: number;
        fees: number;
        latencyMs: number;
    };
    outcome: {
        realizedR: number;
        realizedPnL: number;
        mfe: number;
        mae: number;
        classification: 'CORRECT_WIN' | 'CORRECT_LOSS' | 'MODEL_ERROR' | 'EXECUTION_ERROR' | 'DATA_ERROR' | 'STRATEGY_ERROR';
        notes: string;
    };
}
/**
 * Model Drift & Performance Health Report
 */
export interface IModelDriftReport {
    modelVersion: string;
    asset: string;
    evaluatedAt: Date;
    featureDriftDetected: boolean;
    predictionDriftDetected: boolean;
    calibrationDriftDetected: boolean;
    brierScore: number;
    expectedCalibrationError: number;
    maximumCalibrationError: number;
    rollingWinRate: number;
    rollingExpectancyR: number;
    recommendedAction: 'CONTINUE_LIVE' | 'REDUCE_RISK' | 'SWITCH_TO_PAPER' | 'DISABLE_MODEL';
}
