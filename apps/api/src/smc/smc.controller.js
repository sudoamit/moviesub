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
exports.SMCController = void 0;
const common_1 = require("@nestjs/common");
const smc_service_1 = require("./smc.service");
const shared_1 = require("@quant/shared");
let SMCController = class SMCController {
    smcService;
    constructor(smcService) {
        this.smcService = smcService;
    }
    async getFullAnalysis(symbol, timeframe = shared_1.Timeframe.M15) {
        return this.smcService.getSMCAnalysis(symbol, timeframe);
    }
    async getMarketStructure(symbol, timeframe = shared_1.Timeframe.M15) {
        return this.smcService.getMarketStructure(symbol, timeframe);
    }
    async getLiquidity(symbol, timeframe = shared_1.Timeframe.M15) {
        return this.smcService.getLiquidity(symbol, timeframe);
    }
    async getFairValueGaps(symbol, timeframe = shared_1.Timeframe.M15) {
        return this.smcService.getFairValueGaps(symbol, timeframe);
    }
    async getOrderBlocks(symbol, timeframe = shared_1.Timeframe.M15) {
        return this.smcService.getOrderBlocks(symbol, timeframe);
    }
    async getMarketRegime(symbol, timeframe = shared_1.Timeframe.M15) {
        return this.smcService.getMarketRegime(symbol, timeframe);
    }
};
exports.SMCController = SMCController;
__decorate([
    (0, common_1.Get)('smc/analysis'),
    __param(0, (0, common_1.Query)('symbol')),
    __param(1, (0, common_1.Query)('timeframe')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], SMCController.prototype, "getFullAnalysis", null);
__decorate([
    (0, common_1.Get)('market-structure'),
    __param(0, (0, common_1.Query)('symbol')),
    __param(1, (0, common_1.Query)('timeframe')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], SMCController.prototype, "getMarketStructure", null);
__decorate([
    (0, common_1.Get)('liquidity'),
    __param(0, (0, common_1.Query)('symbol')),
    __param(1, (0, common_1.Query)('timeframe')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], SMCController.prototype, "getLiquidity", null);
__decorate([
    (0, common_1.Get)('fvg'),
    __param(0, (0, common_1.Query)('symbol')),
    __param(1, (0, common_1.Query)('timeframe')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], SMCController.prototype, "getFairValueGaps", null);
__decorate([
    (0, common_1.Get)('order-blocks'),
    __param(0, (0, common_1.Query)('symbol')),
    __param(1, (0, common_1.Query)('timeframe')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], SMCController.prototype, "getOrderBlocks", null);
__decorate([
    (0, common_1.Get)('market-regime'),
    __param(0, (0, common_1.Query)('symbol')),
    __param(1, (0, common_1.Query)('timeframe')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], SMCController.prototype, "getMarketRegime", null);
exports.SMCController = SMCController = __decorate([
    (0, common_1.Controller)('api'),
    __metadata("design:paramtypes", [smc_service_1.SMCService])
], SMCController);
//# sourceMappingURL=smc.controller.js.map