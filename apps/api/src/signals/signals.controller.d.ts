import { Response } from 'express';
import { SignalsService, IRecordTradeDto } from './signals.service';
import { Timeframe } from '@quant/shared';
export declare class PositionSizeDto {
    accountBalance: number;
    riskPercentage?: number;
    entryPrice: number;
    stopLoss: number;
    lotSize?: number;
}
export declare class EvaluateTradeDto {
    symbol: string;
    livePrice: number;
    timeframe?: Timeframe;
}
export declare class SignalsController {
    private readonly signalsService;
    constructor(signalsService: SignalsService);
    getAllSignals(timeframe?: Timeframe, strategy?: 'SMC' | 'SAIYAN_OCC' | 'HYBRID'): Promise<import("@quant/shared").ISignalSetup[]>;
    getCompletedTrades(limit?: number): Promise<any>;
    exportTradesCsv(limit: string, res: Response): Promise<Response<any, Record<string, any>>>;
    syncHistoricalTrades(): Promise<any>;
    syncHistoricalTradesGet(): Promise<any>;
    clearAllTrades(): Promise<{
        success: boolean;
        count: number;
    }>;
    clearAllTradesPost(): Promise<{
        success: boolean;
        count: number;
    }>;
    evaluateTrade(body: EvaluateTradeDto): Promise<{
        isCompleted: boolean;
        wouldClose: boolean;
        previewExit: {
            state: "TP1_HIT" | "TP2_HIT" | "TP3_HIT" | "SL_HIT";
            exitPrice: number;
            exitReason: string;
            pnlRMultiple: number;
        } | null;
        activeSignal: import("@quant/shared").ISignalSetup;
    }>;
    recordTrade(body: IRecordTradeDto): Promise<({
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
    getSignalForSymbol(symbol: string, timeframe?: Timeframe): Promise<import("@quant/shared").ISignalSetup>;
    calculatePositionSize(body: PositionSizeDto): Promise<import("@quant/shared").IPositionSizing>;
}
