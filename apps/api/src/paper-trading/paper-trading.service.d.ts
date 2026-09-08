import { PrismaService } from '../common/prisma/prisma.service';
import { CandlesService } from '../candles/candles.service';
import { RealMarketStreamerService } from '../market-data/real-market-streamer.service';
import { IExecutionProvider, IPaperOrderRequest, IPaperPosition, IPaperTradeHistory, IPaperPortfolio, IClosePositionOptions } from './execution-provider.interface';
export * from './execution-provider.interface';
export declare class PaperTradingService implements IExecutionProvider {
    private readonly prisma;
    private readonly candlesService;
    private readonly realMarketStreamer?;
    private readonly logger;
    constructor(prisma: PrismaService, candlesService: CandlesService, realMarketStreamer?: RealMarketStreamerService | undefined);
    /**
     * Retrieves or initializes the primary PaperAccount from PostgreSQL.
     */
    getOrCreateAccount(): Promise<any>;
    /**
     * Retrieves system trading configuration or defaults.
     */
    getSystemConfig(): Promise<any>;
    /**
     * Calculates realistic Indian stock & crypto transaction charges (Brokerage, STT, GST, Exchange turnover)
     */
    calculateCharges(turnover: number, isCrypto: boolean): {
        brokerage: number;
        stt: number;
        exchangeTurnover: number;
        gst: number;
        sebiTurnover: number;
        totalCharges: number;
    };
    private normalizeSymbol;
    private toSignalDirection;
    /**
     * Validates and fetches authoritative live market price without any hardcoded fallback.
     * Throws MarketDataUnavailableError if price is stale or missing.
     */
    getValidatedMarketPrice(symbol: string, maxAgeSeconds?: number): Promise<{
        price: number;
        timestamp: Date;
    }>;
    /**
     * Strictly Read-Only Portfolio Retrieval.
     * Does NOT modify positions or trigger exits on GET.
     */
    getPortfolio(): Promise<IPaperPortfolio>;
    /**
     * Places a paper trading order with deterministic state machine, database persistence, and risk limit checks.
     */
    placeOrder(req: IPaperOrderRequest): Promise<IPaperPosition>;
    private mapDbTradeToInterface;
    /**
     * Closes an existing paper position, books realized P&L, deducts exit charges, and persists PaperTrade in PostgreSQL.
     */
    closePosition(positionId: string, exitReason?: string, options?: IClosePositionOptions | number, correlationIdOverride?: string): Promise<IPaperTradeHistory>;
    /**
     * Resets the entire paper trading account balance and closes all active positions.
     */
    resetPortfolio(initialCapital?: number): Promise<IPaperPortfolio>;
    private rejectOrder;
    private recordAudit;
    private mapDbPositionToInterface;
}
