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
exports.AccuracyController = void 0;
const common_1 = require("@nestjs/common");
const accuracy_service_1 = require("./accuracy.service");
let AccuracyController = class AccuracyController {
    accuracyService;
    constructor(accuracyService) {
        this.accuracyService = accuracyService;
    }
    getSessionInfo(symbol = 'NIFTY') {
        return this.accuracyService.getSessionInfo(symbol);
    }
    getSMTDivergence(assetA = 'NIFTY', assetB = 'BANKNIFTY', timeframe = 'M15') {
        return this.accuracyService.getSMTDivergence(assetA, assetB, timeframe);
    }
    getSMTMultiTimeframe(assetA = 'NIFTY', assetB = 'BANKNIFTY') {
        return this.accuracyService.getSMTMultiTimeframe(assetA, assetB);
    }
    getMTFFlowRadar(symbol = 'NIFTY') {
        return this.accuracyService.getMTFFlowRadar(symbol);
    }
    getDynamicTrailing(entryPrice, stopLoss, tp1, tp2, currentPrice, direction = 'BULLISH') {
        return this.accuracyService.getDynamicTrailingState(Number(entryPrice || 24175), Number(stopLoss || 24100), Number(tp1 || 24250), Number(tp2 || 24320), Number(currentPrice || 24175), direction);
    }
    getLiquidityHeatmap(symbol = 'NIFTY') {
        return this.accuracyService.getLiquidityHeatmap(symbol);
    }
};
exports.AccuracyController = AccuracyController;
__decorate([
    (0, common_1.Get)('session'),
    __param(0, (0, common_1.Query)('symbol')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], AccuracyController.prototype, "getSessionInfo", null);
__decorate([
    (0, common_1.Get)('smt'),
    __param(0, (0, common_1.Query)('assetA')),
    __param(1, (0, common_1.Query)('assetB')),
    __param(2, (0, common_1.Query)('timeframe')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], AccuracyController.prototype, "getSMTDivergence", null);
__decorate([
    (0, common_1.Get)('smt-mtf'),
    __param(0, (0, common_1.Query)('assetA')),
    __param(1, (0, common_1.Query)('assetB')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], AccuracyController.prototype, "getSMTMultiTimeframe", null);
__decorate([
    (0, common_1.Get)('mtf-radar'),
    __param(0, (0, common_1.Query)('symbol')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], AccuracyController.prototype, "getMTFFlowRadar", null);
__decorate([
    (0, common_1.Get)('trailing'),
    __param(0, (0, common_1.Query)('entryPrice')),
    __param(1, (0, common_1.Query)('stopLoss')),
    __param(2, (0, common_1.Query)('tp1')),
    __param(3, (0, common_1.Query)('tp2')),
    __param(4, (0, common_1.Query)('currentPrice')),
    __param(5, (0, common_1.Query)('direction')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String, String, String]),
    __metadata("design:returntype", void 0)
], AccuracyController.prototype, "getDynamicTrailing", null);
__decorate([
    (0, common_1.Get)('liquidity-heatmap'),
    __param(0, (0, common_1.Query)('symbol')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], AccuracyController.prototype, "getLiquidityHeatmap", null);
exports.AccuracyController = AccuracyController = __decorate([
    (0, common_1.Controller)('api/accuracy'),
    __metadata("design:paramtypes", [accuracy_service_1.AccuracyService])
], AccuracyController);
//# sourceMappingURL=accuracy.controller.js.map