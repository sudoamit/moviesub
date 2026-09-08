"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BacktestsModule = void 0;
const common_1 = require("@nestjs/common");
const backtests_controller_1 = require("./backtests.controller");
const backtests_service_1 = require("./backtests.service");
const candles_module_1 = require("../candles/candles.module");
let BacktestsModule = class BacktestsModule {
};
exports.BacktestsModule = BacktestsModule;
exports.BacktestsModule = BacktestsModule = __decorate([
    (0, common_1.Module)({
        imports: [candles_module_1.CandlesModule],
        controllers: [backtests_controller_1.BacktestsController],
        providers: [backtests_service_1.BacktestsService],
        exports: [backtests_service_1.BacktestsService],
    })
], BacktestsModule);
//# sourceMappingURL=backtests.module.js.map