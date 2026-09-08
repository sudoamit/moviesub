"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AILearningModule = void 0;
const common_1 = require("@nestjs/common");
const ai_learning_service_1 = require("./ai-learning.service");
const ai_learning_controller_1 = require("./ai-learning.controller");
const prisma_module_1 = require("../common/prisma/prisma.module");
const signals_module_1 = require("../signals/signals.module");
const smc_module_1 = require("../smc/smc.module");
const accuracy_module_1 = require("../accuracy/accuracy.module");
let AILearningModule = class AILearningModule {
};
exports.AILearningModule = AILearningModule;
exports.AILearningModule = AILearningModule = __decorate([
    (0, common_1.Module)({
        imports: [prisma_module_1.PrismaModule, signals_module_1.SignalsModule, smc_module_1.SMCModule, accuracy_module_1.AccuracyModule],
        controllers: [ai_learning_controller_1.AILearningController],
        providers: [ai_learning_service_1.AILearningService],
        exports: [ai_learning_service_1.AILearningService],
    })
], AILearningModule);
//# sourceMappingURL=ai-learning.module.js.map