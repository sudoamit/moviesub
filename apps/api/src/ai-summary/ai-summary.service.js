"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var AISummaryService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AISummaryService = void 0;
const common_1 = require("@nestjs/common");
const signals_service_1 = require("../signals/signals.service");
const smc_service_1 = require("../smc/smc.service");
const shared_1 = require("@quant/shared");
let AISummaryService = AISummaryService_1 = class AISummaryService {
    signalsService;
    smcService;
    logger = new common_1.Logger(AISummaryService_1.name);
    constructor(signalsService, smcService) {
        this.signalsService = signalsService;
        this.smcService = smcService;
    }
    async generateSymbolSummary(symbol, timeframe = shared_1.Timeframe.M15) {
        const sym = symbol.toUpperCase();
        const signal = await this.signalsService.generateSignalForSymbol(sym, timeframe);
        const smc = await this.smcService.getSMCAnalysis(sym, timeframe);
        const isBull = signal.direction === 'BULLISH';
        const isBear = signal.direction === 'BEARISH';
        const bias = isBull ? 'BULLISH' : isBear ? 'BEARISH' : 'NEUTRAL';
        const executiveSummary = isBull
            ? `${sym} is demonstrating clear structural strength on the ${timeframe} timeframe with institutional accumulation in the 50% Discount zone. The quantitative setup score is ${signal.score}/100 (Grade ${signal.grade}).`
            : isBear
                ? `${sym} exhibits institutional distribution on the ${timeframe} timeframe following buy-side liquidity sweeps in the 50% Premium zone. The quantitative setup score is ${signal.score}/100 (Grade ${signal.grade}).`
                : `${sym} is currently consolidating in a neutral dealing range without high-conviction institutional displacement. No active trade trigger is confirmed.`;
        const marketStructureNarrative = [
            `Market Regime: ${smc.marketRegime.regime.replace('_', ' ')} with ATR volatility at ${smc.marketRegime.atr.toFixed(2)} pts.`,
            `Higher Timeframe Alignment: 1H trend is ${signal.htfBias}, ${signal.scoreBreakdown.htfBias >= 15 ? 'strictly aligning with intraday execution.' : 'divergent from execution timeframe.'}`,
            signal.reasoning.liquidityReason,
        ].join(' ');
        const institutionalFootprint = [
            signal.reasoning.triggerReason,
            `Unmitigated Fair Value Gaps: ${(smc.fairValueGaps || []).filter((f) => !f.isFilled).length} active zones.`,
            `Order Block Zones: ${(smc.orderBlocks || []).filter((o) => !o.isMitigated).length} institutional anchors.`,
        ].join(' ');
        const riskParameters = {
            optimalEntry: signal.entryZone.optimal,
            entryRange: `[${signal.entryZone.min} - ${signal.entryZone.max}]`,
            invalidationStopLoss: signal.stopLoss,
            riskDistancePts: Number(Math.abs(signal.entryZone.optimal - signal.stopLoss).toFixed(2)),
            targets: {
                tp1: signal.takeProfits.tp1,
                tp2: signal.takeProfits.tp2,
                tp3: signal.takeProfits.tp3,
            },
            riskRewardRatio: `1:${signal.riskRewardRatios.rr2}`,
        };
        return {
            symbol: sym,
            timeframe,
            bias,
            score: signal.score,
            grade: signal.grade,
            executiveSummary,
            marketStructureNarrative,
            institutionalFootprint,
            riskParameters,
            confirmedChecklist: signal.reasoning.confirmedChecklist,
            generatedAt: new Date().toISOString(),
            disclaimer: 'Deterministic quantitative market intelligence. Generated strictly from mathematical structural engines with zero LLM hallucination.',
        };
    }
    async generateDailyBriefing(timeframe = shared_1.Timeframe.M15) {
        const symbols = ['NIFTY', 'BANKNIFTY', 'BTCUSDT', 'RELIANCE', 'HDFCBANK', 'INFY'];
        const summaries = await Promise.all(symbols.map((sym) => this.generateSymbolSummary(sym, timeframe)));
        const highConviction = summaries.filter((s) => s.score >= 80);
        const bullishCount = summaries.filter((s) => s.bias === 'BULLISH').length;
        const bearishCount = summaries.filter((s) => s.bias === 'BEARISH').length;
        return {
            title: 'Daily Institutional Market Intelligence Briefing',
            date: new Date().toISOString().split('T')[0],
            marketBreadth: {
                totalAnalyzed: symbols.length,
                bullishAssets: bullishCount,
                bearishAssets: bearishCount,
                highConvictionSetups: highConviction.length,
            },
            topOpportunities: highConviction.map((h) => ({
                symbol: h.symbol,
                direction: h.bias,
                score: h.score,
                grade: h.grade,
                summary: h.executiveSummary,
                optimalEntry: h.riskParameters.optimalEntry,
                stopLoss: h.riskParameters.invalidationStopLoss,
                tp2: h.riskParameters.targets.tp2,
                rr: h.riskParameters.riskRewardRatio,
            })),
            assetSummaries: summaries,
        };
    }
};
exports.AISummaryService = AISummaryService;
exports.AISummaryService = AISummaryService = AISummaryService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [signals_service_1.SignalsService,
        smc_service_1.SMCService])
], AISummaryService);
//# sourceMappingURL=ai-summary.service.js.map