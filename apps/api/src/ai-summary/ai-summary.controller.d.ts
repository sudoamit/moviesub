import { AISummaryService } from './ai-summary.service';
import { Timeframe } from '@quant/shared';
export declare class AISummaryController {
    private readonly aiSummaryService;
    constructor(aiSummaryService: AISummaryService);
    getMarketSummary(symbol: string, timeframe?: Timeframe): Promise<{
        symbol: string;
        timeframe: Timeframe;
        bias: string;
        score: number;
        grade: import("@quant/shared").SignalGrade;
        executiveSummary: string;
        marketStructureNarrative: string;
        institutionalFootprint: string;
        riskParameters: {
            optimalEntry: number;
            entryRange: string;
            invalidationStopLoss: number;
            riskDistancePts: number;
            targets: {
                tp1: number;
                tp2: number;
                tp3: number;
            };
            riskRewardRatio: string;
        };
        confirmedChecklist: string[];
        generatedAt: string;
        disclaimer: string;
    }>;
    getDailyBriefing(timeframe?: Timeframe): Promise<{
        title: string;
        date: string;
        marketBreadth: {
            totalAnalyzed: number;
            bullishAssets: number;
            bearishAssets: number;
            highConvictionSetups: number;
        };
        topOpportunities: {
            symbol: string;
            direction: string;
            score: number;
            grade: import("@quant/shared").SignalGrade;
            summary: string;
            optimalEntry: number;
            stopLoss: number;
            tp2: number;
            rr: string;
        }[];
        assetSummaries: {
            symbol: string;
            timeframe: Timeframe;
            bias: string;
            score: number;
            grade: import("@quant/shared").SignalGrade;
            executiveSummary: string;
            marketStructureNarrative: string;
            institutionalFootprint: string;
            riskParameters: {
                optimalEntry: number;
                entryRange: string;
                invalidationStopLoss: number;
                riskDistancePts: number;
                targets: {
                    tp1: number;
                    tp2: number;
                    tp3: number;
                };
                riskRewardRatio: string;
            };
            confirmedChecklist: string[];
            generatedAt: string;
            disclaimer: string;
        }[];
    }>;
}
