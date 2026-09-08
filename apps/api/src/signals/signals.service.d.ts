import { OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CandlesService } from '../candles/candles.service';
import { ISignalSetup, Timeframe } from '@quant/shared';
export interface IRecordTradeDto {
    symbol: string;
    contractSymbol?: string;
    instrumentType?: 'SPOT' | 'OPTION';
    strike?: number;
    optionType?: 'CE' | 'PE';
    direction: 'BULLISH' | 'BEARISH';
    state: 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'SL_HIT';
    grade?: string;
    score?: number;
    timeframe?: string;
    quantity?: number;
    entryPrice: number;
    stopLoss: number;
    target1: number;
    target2: number;
    target3?: number;
    exitPrice: number;
    pnlAmount: number;
    pnlRMultiple: number;
    riskRewardRatio?: number;
    tradeReason?: string;
    exitReason: string;
    checklist?: string[];
    activatedAt?: Date | string;
    closedAt?: Date | string;
}
export declare class SignalsService implements OnModuleInit {
    private readonly prisma;
    private readonly candlesService;
    private readonly logger;
    constructor(prisma: PrismaService, candlesService: CandlesService);
    onModuleInit(): Promise<void>;
    generateSignalForSymbol(symbol: string, executionTimeframe?: Timeframe, strategy?: 'SMC' | 'SAIYAN_OCC' | 'HYBRID'): Promise<ISignalSetup>;
    getAllSignals(timeframe?: Timeframe, strategy?: 'SMC' | 'SAIYAN_OCC' | 'HYBRID'): Promise<ISignalSetup[]>;
    /**
     * Evaluates a setup preview against live price.
     *
     * This endpoint intentionally does not persist journal rows. Journal writes must come
     * from an executed position close path, where entry price/time are already immutable.
     */
    evaluateTrade(symbol: string, livePrice: number, timeframe?: Timeframe): Promise<{
        isCompleted: boolean;
        wouldClose: boolean;
        previewExit: {
            state: "TP1_HIT" | "TP2_HIT" | "TP3_HIT" | "SL_HIT";
            exitPrice: number;
            exitReason: string;
            pnlRMultiple: number;
        } | null;
        activeSignal: ISignalSetup;
    }>;
    /**
     * Persists a completed trade into PostgreSQL Signal table
     */
    recordCompletedTrade(data: IRecordTradeDto): Promise<({
        instrument: {
            symbol: string;
            name: string;
            lotSize: number;
            contractSize: import("@prisma/client/runtime/library").Decimal;
            id: string;
            assetType: import(".prisma/client").$Enums.AssetType;
            exchange: string;
            currency: string;
            tickSize: import("@prisma/client/runtime/library").Decimal;
            createdAt: Date;
            updatedAt: Date;
            tradingHoursJson: import("@prisma/client/runtime/library").JsonValue | null;
            isActive: boolean;
        };
    } & {
        timeframe: import(".prisma/client").$Enums.Timeframe;
        direction: import(".prisma/client").$Enums.Direction;
        instrumentId: string;
        entryPrice: import("@prisma/client/runtime/library").Decimal;
        stopLoss: import("@prisma/client/runtime/library").Decimal;
        state: import(".prisma/client").$Enums.SignalState;
        id: string;
        grade: import(".prisma/client").$Enums.SignalGrade;
        riskRewardRatio: import("@prisma/client/runtime/library").Decimal;
        exitPrice: import("@prisma/client/runtime/library").Decimal | null;
        createdAt: Date;
        strategyId: string | null;
        updatedAt: Date;
        target1: import("@prisma/client/runtime/library").Decimal;
        score: number;
        target2: import("@prisma/client/runtime/library").Decimal;
        target3: import("@prisma/client/runtime/library").Decimal | null;
        pnlAmount: import("@prisma/client/runtime/library").Decimal | null;
        pnlRMultiple: import("@prisma/client/runtime/library").Decimal | null;
        reasonsJson: import("@prisma/client/runtime/library").JsonValue;
        risksJson: import("@prisma/client/runtime/library").JsonValue;
        activatedAt: Date | null;
        closedAt: Date | null;
    }) | null>;
    private getPriceTolerance;
    private getTradeDedupKey;
    private coerceAuthoritativeTimestamp;
    /**
     * Clears/removes all completed trades from the journal database
     */
    clearAllCompletedTrades(): Promise<{
        success: boolean;
        count: number;
    }>;
    /**
     * Retrieves all completed/recorded trades with win rate and P&L analytics
     */
    getCompletedTrades(limit?: number): Promise<any>;
    /**
     * Generates a tax-compliant CSV export of completed trades with STT, turnover, GST, and SEBI fee breakdown.
     */
    exportTradesToCsv(limit?: number): Promise<{
        filename: string;
        csvContent: string;
    }>;
    /**
     * Seeds realistic institutional SMC historical closed trades strictly within official market hours (09:15 AM - 03:30 PM IST)
     */
    private seedInitialCompletedTrades;
    calculatePositionSize(accountBalance: number, riskPercentage: number, entryPrice: number, stopLoss: number, lotSize?: number): import("@quant/shared").IPositionSizing;
    /**
     * Scans multi-asset historical price structure and syncs completed strategy trades into the Journal
     */
    syncHistoricalTrades(): Promise<any>;
}
