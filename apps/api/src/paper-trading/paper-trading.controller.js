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
exports.PaperTradingController = void 0;
const common_1 = require("@nestjs/common");
const paper_trading_service_1 = require("./paper-trading.service");
let PaperTradingController = class PaperTradingController {
    paperTradingService;
    constructor(paperTradingService) {
        this.paperTradingService = paperTradingService;
    }
    async getPortfolio() {
        return this.paperTradingService.getPortfolio();
    }
    async placeOrder(orderDto) {
        return this.paperTradingService.placeOrder(orderDto);
    }
    async closePosition(body) {
        return this.paperTradingService.closePosition(body.positionId, body.reason);
    }
    async resetPortfolio(body) {
        return this.paperTradingService.resetPortfolio(body?.initialCapital);
    }
};
exports.PaperTradingController = PaperTradingController;
__decorate([
    (0, common_1.Get)('portfolio'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], PaperTradingController.prototype, "getPortfolio", null);
__decorate([
    (0, common_1.Post)('order'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], PaperTradingController.prototype, "placeOrder", null);
__decorate([
    (0, common_1.Post)('close-position'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], PaperTradingController.prototype, "closePosition", null);
__decorate([
    (0, common_1.Post)('reset'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], PaperTradingController.prototype, "resetPortfolio", null);
exports.PaperTradingController = PaperTradingController = __decorate([
    (0, common_1.Controller)('api/paper-trading'),
    __metadata("design:paramtypes", [paper_trading_service_1.PaperTradingService])
], PaperTradingController);
//# sourceMappingURL=paper-trading.controller.js.map