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
var SMCService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SMCService = void 0;
const common_1 = require("@nestjs/common");
const candles_service_1 = require("../candles/candles.service");
const trading_engine_1 = require("@quant/trading-engine");
const shared_1 = require("@quant/shared");
let SMCService = SMCService_1 = class SMCService {
    candlesService;
    logger = new common_1.Logger(SMCService_1.name);
    constructor(candlesService) {
        this.candlesService = candlesService;
    }
    async getSMCAnalysis(symbol, timeframe = shared_1.Timeframe.M15, limit = 200) {
        const candlesRes = await this.candlesService.getCandles({
            symbol,
            timeframe,
            limit,
        });
        const analysis = trading_engine_1.SMCAnalyzer.analyze(candlesRes.candles);
        return {
            symbol: symbol.toUpperCase(),
            timeframe,
            ...analysis,
        };
    }
    async getMarketStructure(symbol, timeframe = shared_1.Timeframe.M15) {
        const analysis = await this.getSMCAnalysis(symbol, timeframe);
        return {
            symbol: analysis.symbol,
            timeframe: analysis.timeframe,
            swingPoints: analysis.swingPoints,
            breaksOfStructure: analysis.breaksOfStructure,
            changesOfCharacter: analysis.changesOfCharacter,
            currentTrend: analysis.currentTrend,
        };
    }
    async getLiquidity(symbol, timeframe = shared_1.Timeframe.M15) {
        const analysis = await this.getSMCAnalysis(symbol, timeframe);
        return {
            symbol: analysis.symbol,
            timeframe: analysis.timeframe,
            liquidityPools: analysis.liquidityPools,
            liquiditySweeps: analysis.liquiditySweeps,
        };
    }
    async getFairValueGaps(symbol, timeframe = shared_1.Timeframe.M15) {
        const analysis = await this.getSMCAnalysis(symbol, timeframe);
        return {
            symbol: analysis.symbol,
            timeframe: analysis.timeframe,
            fairValueGaps: analysis.fairValueGaps,
        };
    }
    async getFVG(symbol, timeframe = shared_1.Timeframe.M15) {
        return this.getFairValueGaps(symbol, timeframe);
    }
    async getOrderBlocks(symbol, timeframe = shared_1.Timeframe.M15) {
        const analysis = await this.getSMCAnalysis(symbol, timeframe);
        return {
            symbol: analysis.symbol,
            timeframe: analysis.timeframe,
            orderBlocks: analysis.orderBlocks,
        };
    }
    async getMarketRegime(symbol, timeframe = shared_1.Timeframe.M15) {
        const analysis = await this.getSMCAnalysis(symbol, timeframe);
        return {
            symbol: analysis.symbol,
            timeframe: analysis.timeframe,
            regime: analysis.marketRegime,
            marketRegime: analysis.marketRegime,
        };
    }
};
exports.SMCService = SMCService;
exports.SMCService = SMCService = SMCService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [candles_service_1.CandlesService])
], SMCService);
//# sourceMappingURL=smc.service.js.map