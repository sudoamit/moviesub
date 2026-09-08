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
exports.CandlesController = void 0;
const common_1 = require("@nestjs/common");
const candles_service_1 = require("./candles.service");
const get_candles_dto_1 = require("./dto/get-candles.dto");
const shared_1 = require("@quant/shared");
let CandlesController = class CandlesController {
    candlesService;
    constructor(candlesService) {
        this.candlesService = candlesService;
    }
    async getCandles(query) {
        return this.candlesService.getCandles(query);
    }
    async getChartData(symbol = 'NIFTY', timeframe = shared_1.Timeframe.M15, limit) {
        return this.candlesService.getChartData(symbol, timeframe, limit ? Number(limit) : 200);
    }
    async getLatestCandle(symbol, timeframe = shared_1.Timeframe.M15) {
        return this.candlesService.getLatestCandle(symbol, timeframe);
    }
    async ingestCandles(body) {
        return this.candlesService.ingestCandles(body);
    }
};
exports.CandlesController = CandlesController;
__decorate([
    (0, common_1.Get)(),
    (0, common_1.UsePipes)(new common_1.ValidationPipe({ transform: true })),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [get_candles_dto_1.GetCandlesDto]),
    __metadata("design:returntype", Promise)
], CandlesController.prototype, "getCandles", null);
__decorate([
    (0, common_1.Get)('chart-data'),
    __param(0, (0, common_1.Query)('symbol')),
    __param(1, (0, common_1.Query)('timeframe')),
    __param(2, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Number]),
    __metadata("design:returntype", Promise)
], CandlesController.prototype, "getChartData", null);
__decorate([
    (0, common_1.Get)('latest'),
    __param(0, (0, common_1.Query)('symbol')),
    __param(1, (0, common_1.Query)('timeframe')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], CandlesController.prototype, "getLatestCandle", null);
__decorate([
    (0, common_1.Post)('ingest'),
    (0, common_1.UsePipes)(new common_1.ValidationPipe({ transform: true })),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [get_candles_dto_1.IngestCandlesDto]),
    __metadata("design:returntype", Promise)
], CandlesController.prototype, "ingestCandles", null);
exports.CandlesController = CandlesController = __decorate([
    (0, common_1.Controller)('api/candles'),
    __metadata("design:paramtypes", [candles_service_1.CandlesService])
], CandlesController);
//# sourceMappingURL=candles.controller.js.map