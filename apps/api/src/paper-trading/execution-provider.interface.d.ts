import { PositionState, TradingMode } from '@quant/shared';
export interface IPaperOrderRequest {
    symbol: string;
    direction: 'BUY' | 'SELL';
    quantity: number;
    orderType: 'MARKET' | 'LIMIT';
    price?: number;
    signalPrice?: number;
    signalTime?: string;
    stopLoss?: number;
    target1?: number;
    target2?: number;
    target3?: number;
    leverage?: number;
    productType?: 'INTRADAY' | 'DELIVERY';
    instrumentType?: 'SPOT' | 'OPTION';
    strike?: number;
    optionType?: 'CE' | 'PE';
    contractSymbol?: string;
    signalId?: string;
    featureSnapshotJson?: any;
    idempotencyKey?: string;
    correlationId?: string;
}
export interface IPaperPosition {
    id: string;
    accountId: string;
    symbol: string;
    contractSymbol: string;
    instrumentType: 'SPOT' | 'OPTION';
    strike?: number;
    optionType?: 'CE' | 'PE';
    direction: 'BUY' | 'SELL';
    quantity: number;
    signalPrice?: number;
    signalTime?: string;
    readonly entryPrice: number;
    readonly entryTime: string;
    averageEntryPrice: number;
    currentPrice: number;
    stopLoss?: number;
    initialStopLoss?: number;
    target1?: number;
    target2?: number;
    target3?: number;
    initialTarget1?: number;
    initialTarget2?: number;
    initialTarget3?: number;
    leverage: number;
    unrealizedPnL: number;
    unrealizedR: number;
    notionalValue: number;
    usedMargin: number;
    maxFavorableExcursion?: number;
    maxAdverseExcursion?: number;
    openedAt: string;
    status: PositionState;
    featureSnapshotJson?: any;
    trailingStopState?: {
        stage: string;
        stageBadge: string;
        currentStopLoss: number;
        isRiskFree: boolean;
        partialBookedPercent: number;
        recommendedAction: string;
    };
    charges: {
        brokerage: number;
        stt: number;
        exchangeTurnover: number;
        gst: number;
        sebiTurnover: number;
        totalCharges: number;
    };
}
export interface IPaperTradeHistory {
    id: string;
    accountId: string;
    positionId?: string;
    symbol: string;
    contractSymbol?: string;
    instrumentType?: 'SPOT' | 'OPTION';
    strike?: number;
    optionType?: 'CE' | 'PE';
    direction: 'BUY' | 'SELL';
    quantity: number;
    entryPrice: number;
    exitPrice: number;
    realizedPnL: number;
    realizedR: number;
    maxFavorableExcursion?: number;
    maxAdverseExcursion?: number;
    holdingDurationSeconds?: number;
    exitReason: string;
    openedAt: string;
    closedAt: string;
    totalCharges: number;
    featureSnapshotJson?: any;
    outcomeSnapshotJson?: any;
    correlationId?: string;
}
export interface IPaperPortfolio {
    accountId: string;
    initialCapital: number;
    cashBalance: number;
    usedMargin: number;
    availableMargin: number;
    totalEquity: number;
    realizedPnL: number;
    unrealizedPnL: number;
    totalChargesPaid: number;
    winRate: number;
    profitFactor: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    tradingMode: TradingMode;
    openPositions: IPaperPosition[];
    tradeHistory: IPaperTradeHistory[];
}
export interface IClosePositionOptions {
    exitPriceOverride?: number;
    allowPriceOverride?: boolean;
    correlationId?: string;
}
export interface IExecutionProvider {
    placeOrder(req: IPaperOrderRequest): Promise<IPaperPosition>;
    closePosition(positionId: string, exitReason?: string, options?: IClosePositionOptions | number, correlationId?: string): Promise<IPaperTradeHistory>;
    getPortfolio(): Promise<IPaperPortfolio>;
    resetPortfolio(initialCapital?: number): Promise<IPaperPortfolio>;
}
