"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AISummaryModule = void 0;
const common_1 = require("@nestjs/common");
const ai_summary_controller_1 = require("./ai-summary.controller");
const ai_summary_service_1 = require("./ai-summary.service");
const signals_module_1 = require("../signals/signals.module");
const smc_module_1 = require("../smc/smc.module");
let AISummaryModule = class AISummaryModule {
};
exports.AISummaryModule = AISummaryModule;
exports.AISummaryModule = AISummaryModule = __decorate([
    (0, common_1.Module)({
        imports: [signals_module_1.SignalsModule, smc_module_1.SMCModule],
        controllers: [ai_summary_controller_1.AISummaryController],
        providers: [ai_summary_service_1.AISummaryService],
        exports: [ai_summary_service_1.AISummaryService],
    })
], AISummaryModule);
//# sourceMappingURL=ai-summary.module.js.map