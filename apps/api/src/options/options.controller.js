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
exports.OptionsController = void 0;
const common_1 = require("@nestjs/common");
const options_service_1 = require("./options.service");
let OptionsController = class OptionsController {
    optionsService;
    constructor(optionsService) {
        this.optionsService = optionsService;
    }
    async getOptionChain(symbol, expiryDate, spotPrice) {
        return this.optionsService.getOptionChain(symbol || 'NIFTY', expiryDate, spotPrice ? parseFloat(spotPrice) : undefined);
    }
    async getSmartStrike(symbol, direction, spotTarget, spotStopLoss, expiryDate, spotPrice, strike) {
        return this.optionsService.getSmartStrikeRecommendation(symbol || 'NIFTY', direction || 'BULLISH', spotTarget ? parseFloat(spotTarget) : undefined, spotStopLoss ? parseFloat(spotStopLoss) : undefined, expiryDate, spotPrice ? parseFloat(spotPrice) : undefined, strike ? parseFloat(strike) : undefined);
    }
};
exports.OptionsController = OptionsController;
__decorate([
    (0, common_1.Get)('chain'),
    __param(0, (0, common_1.Query)('symbol')),
    __param(1, (0, common_1.Query)('expiryDate')),
    __param(2, (0, common_1.Query)('spotPrice')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], OptionsController.prototype, "getOptionChain", null);
__decorate([
    (0, common_1.Get)('smart-strike'),
    __param(0, (0, common_1.Query)('symbol')),
    __param(1, (0, common_1.Query)('direction')),
    __param(2, (0, common_1.Query)('spotTarget')),
    __param(3, (0, common_1.Query)('spotStopLoss')),
    __param(4, (0, common_1.Query)('expiryDate')),
    __param(5, (0, common_1.Query)('spotPrice')),
    __param(6, (0, common_1.Query)('strike')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String, String, String, String]),
    __metadata("design:returntype", Promise)
], OptionsController.prototype, "getSmartStrike", null);
exports.OptionsController = OptionsController = __decorate([
    (0, common_1.Controller)('api/options'),
    __metadata("design:paramtypes", [options_service_1.OptionsService])
], OptionsController);
//# sourceMappingURL=options.controller.js.map