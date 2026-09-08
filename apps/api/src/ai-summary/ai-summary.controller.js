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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AISummaryController = void 0;
const common_1 = require("@nestjs/common");
const ai_summary_service_1 = require("./ai-summary.service");
const shared_1 = require("@quant/shared");
let AISummaryController = class AISummaryController {
    aiSummaryService;
    constructor(aiSummaryService) {
        this.aiSummaryService = aiSummaryService;
    }
    async getMarketSummary(symbol, timeframe = shared_1.Timeframe.M15) {
        return this.aiSummaryService.generateSymbolSummary(symbol, timeframe);
    }
    async getDailyBriefing(timeframe = shared_1.Timeframe.M15) {
        return this.aiSummaryService.generateDailyBriefing(timeframe);
    }
};
exports.AISummaryController = AISummaryController;
__decorate([
    (0, common_1.Get)('market-summary/:symbol'),
    __param(0, (0, common_1.Param)('symbol')),
    __param(1, (0, common_1.Query)('timeframe')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], AISummaryController.prototype, "getMarketSummary", null);
__decorate([
    (0, common_1.Get)('daily-briefing'),
    __param(0, (0, common_1.Query)('timeframe')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AISummaryController.prototype, "getDailyBriefing", null);
exports.AISummaryController = AISummaryController = __decorate([
    (0, common_1.Controller)('api/ai'),
    __metadata("design:paramtypes", [ai_summary_service_1.AISummaryService])
], AISummaryController);
//# sourceMappingURL=ai-summary.controller.js.map