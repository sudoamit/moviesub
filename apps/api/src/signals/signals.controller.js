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
exports.SignalsController = exports.EvaluateTradeDto = exports.PositionSizeDto = void 0;
const common_1 = require("@nestjs/common");
const signals_service_1 = require("./signals.service");
const shared_1 = require("@quant/shared");
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
class PositionSizeDto {
    accountBalance;
    riskPercentage;
    entryPrice;
    stopLoss;
    lotSize;
}
exports.PositionSizeDto = PositionSizeDto;
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsPositive)(),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], PositionSizeDto.prototype, "accountBalance", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsPositive)(),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], PositionSizeDto.prototype, "riskPercentage", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsPositive)(),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], PositionSizeDto.prototype, "entryPrice", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsPositive)(),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], PositionSizeDto.prototype, "stopLoss", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.Min)(1),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], PositionSizeDto.prototype, "lotSize", void 0);
class EvaluateTradeDto {
    symbol;
    livePrice;
    timeframe;
}
exports.EvaluateTradeDto = EvaluateTradeDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], EvaluateTradeDto.prototype, "symbol", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsPositive)(),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], EvaluateTradeDto.prototype, "livePrice", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", String)
], EvaluateTradeDto.prototype, "timeframe", void 0);
let SignalsController = class SignalsController {
    signalsService;
    constructor(signalsService) {
        this.signalsService = signalsService;
    }
    async getAllSignals(timeframe = shared_1.Timeframe.M15, strategy = 'SMC') {
        return this.signalsService.getAllSignals(timeframe, strategy);
    }
    async getCompletedTrades(limit = 50) {
        return this.signalsService.getCompletedTrades(Number(limit) || 50);
    }
    async exportTradesCsv(limit, res) {
        const { filename, csvContent } = await this.signalsService.exportTradesToCsv(Number(limit) || 200);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.status(200).send(csvContent);
    }
    async syncHistoricalTrades() {
        return this.signalsService.syncHistoricalTrades();
    }
    async syncHistoricalTradesGet() {
        return this.signalsService.syncHistoricalTrades();
    }
    async clearAllTrades() {
        return this.signalsService.clearAllCompletedTrades();
    }
    async clearAllTradesPost() {
        return this.signalsService.clearAllCompletedTrades();
    }
    async evaluateTrade(body) {
        return this.signalsService.evaluateTrade(body.symbol, body.livePrice, body.timeframe || shared_1.Timeframe.M15);
    }
    async recordTrade(body) {
        return this.signalsService.recordCompletedTrade(body);
    }
    async getSignalForSymbol(symbol, timeframe = shared_1.Timeframe.M15) {
        return this.signalsService.generateSignalForSymbol(symbol, timeframe);
    }
    async calculatePositionSize(body) {
        return this.signalsService.calculatePositionSize(body.accountBalance, body.riskPercentage ?? 1.0, body.entryPrice, body.stopLoss, body.lotSize ?? 1);
    }
};
exports.SignalsController = SignalsController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, common_1.Query)('timeframe')),
    __param(1, (0, common_1.Query)('strategy')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], SignalsController.prototype, "getAllSignals", null);
__decorate([
    (0, common_1.Get)('completed-trades'),
    __param(0, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], SignalsController.prototype, "getCompletedTrades", null);
__decorate([
    (0, common_1.Get)('export-csv'),
    __param(0, (0, common_1.Query)('limit')),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], SignalsController.prototype, "exportTradesCsv", null);
__decorate([
    (0, common_1.Post)('sync-trades'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], SignalsController.prototype, "syncHistoricalTrades", null);
__decorate([
    (0, common_1.Get)('sync-trades'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], SignalsController.prototype, "syncHistoricalTradesGet", null);
__decorate([
    (0, common_1.Delete)('clear-trades'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], SignalsController.prototype, "clearAllTrades", null);
__decorate([
    (0, common_1.Post)('clear-trades'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], SignalsController.prototype, "clearAllTradesPost", null);
__decorate([
    (0, common_1.Post)('evaluate-trade'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [EvaluateTradeDto]),
    __metadata("design:returntype", Promise)
], SignalsController.prototype, "evaluateTrade", null);
__decorate([
    (0, common_1.Post)('record-trade'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], SignalsController.prototype, "recordTrade", null);
__decorate([
    (0, common_1.Get)(':symbol'),
    __param(0, (0, common_1.Param)('symbol')),
    __param(1, (0, common_1.Query)('timeframe')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], SignalsController.prototype, "getSignalForSymbol", null);
__decorate([
    (0, common_1.Post)('position-size'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [PositionSizeDto]),
    __metadata("design:returntype", Promise)
], SignalsController.prototype, "calculatePositionSize", null);
exports.SignalsController = SignalsController = __decorate([
    (0, common_1.Controller)('api/signals'),
    __metadata("design:paramtypes", [signals_service_1.SignalsService])
], SignalsController);
//# sourceMappingURL=signals.controller.js.map