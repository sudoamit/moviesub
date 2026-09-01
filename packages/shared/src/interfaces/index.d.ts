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
    totalScore: number;
    grade: SignalGrade;
}
export interface ISignalSetup {
    id: string;
    instrumentId: string;
    symbol: string;
    timeframe: Timeframe;
    direction: Direction;
    state: SignalState;
    grade: SignalGrade;
    score: number;
    entryPrice: number;
    stopLoss: number;
    target1: number;
    target2: number;
    target3?: number;
    riskRewardRatio: number;
    reasons: string[];
    risks: string[];
    scoreBreakdown: IScoreBreakdown;
    activatedAt?: Date;
    closedAt?: Date;
    exitPrice?: number;
    pnlAmount?: number;
    pnlRMultiple?: number;
    createdAt: Date;
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
    pnl: number;
    pnlRMultiple: number;
    exitReason: SignalState;
}
//# sourceMappingURL=index.d.ts.map