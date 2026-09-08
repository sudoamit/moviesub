"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CandlesModule = void 0;
const common_1 = require("@nestjs/common");
const candles_controller_1 = require("./candles.controller");
const candles_service_1 = require("./candles.service");
const market_data_module_1 = require("../market-data/market-data.module");
let CandlesModule = class CandlesModule {
};
exports.CandlesModule = CandlesModule;
exports.CandlesModule = CandlesModule = __decorate([
    (0, common_1.Module)({
        imports: [market_data_module_1.MarketDataModule],
        controllers: [candles_controller_1.CandlesController],
        providers: [candles_service_1.CandlesService],
        exports: [candles_service_1.CandlesService],
    })
], CandlesModule);
//# sourceMappingURL=candles.module.js.map