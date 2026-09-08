"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SMCModule = void 0;
const common_1 = require("@nestjs/common");
const smc_controller_1 = require("./smc.controller");
const smc_service_1 = require("./smc.service");
const candles_module_1 = require("../candles/candles.module");
let SMCModule = class SMCModule {
};
exports.SMCModule = SMCModule;
exports.SMCModule = SMCModule = __decorate([
    (0, common_1.Module)({
        imports: [candles_module_1.CandlesModule],
        controllers: [smc_controller_1.SMCController],
        providers: [smc_service_1.SMCService],
        exports: [smc_service_1.SMCService],
    })
], SMCModule);
//# sourceMappingURL=smc.module.js.map