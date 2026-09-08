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
exports.BacktestsController = void 0;
const common_1 = require("@nestjs/common");
const backtests_service_1 = require("./backtests.service");
const run_backtest_dto_1 = require("./dto/run-backtest.dto");
let BacktestsController = class BacktestsController {
    backtestsService;
    constructor(backtestsService) {
        this.backtestsService = backtestsService;
    }
    async runBacktest(body) {
        return this.backtestsService.runBacktest(body);
    }
    async listBacktests() {
        return this.backtestsService.listBacktests();
    }
    async getBacktestById(id) {
        return this.backtestsService.getBacktestById(id);
    }
};
exports.BacktestsController = BacktestsController;
__decorate([
    (0, common_1.Post)('run'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [run_backtest_dto_1.RunBacktestDto]),
    __metadata("design:returntype", Promise)
], BacktestsController.prototype, "runBacktest", null);
__decorate([
    (0, common_1.Get)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], BacktestsController.prototype, "listBacktests", null);
__decorate([
    (0, common_1.Get)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], BacktestsController.prototype, "getBacktestById", null);
exports.BacktestsController = BacktestsController = __decorate([
    (0, common_1.Controller)('api/backtests'),
    __metadata("design:paramtypes", [backtests_service_1.BacktestsService])
], BacktestsController);
//# sourceMappingURL=backtests.controller.js.map