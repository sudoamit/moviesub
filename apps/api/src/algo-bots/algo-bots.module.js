"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AlgoBotsModule = void 0;
const common_1 = require("@nestjs/common");
const algo_bots_service_1 = require("./algo-bots.service");
const algo_bots_controller_1 = require("./algo-bots.controller");
const paper_trading_module_1 = require("../paper-trading/paper-trading.module");
const alerts_module_1 = require("../alerts/alerts.module");
let AlgoBotsModule = class AlgoBotsModule {
};
exports.AlgoBotsModule = AlgoBotsModule;
exports.AlgoBotsModule = AlgoBotsModule = __decorate([
    (0, common_1.Module)({
        imports: [paper_trading_module_1.PaperTradingModule, alerts_module_1.AlertsModule],
        controllers: [algo_bots_controller_1.AlgoBotsController],
        providers: [algo_bots_service_1.AlgoBotsService],
        exports: [algo_bots_service_1.AlgoBotsService],
    })
], AlgoBotsModule);
//# sourceMappingURL=algo-bots.module.js.map