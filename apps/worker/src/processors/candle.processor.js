"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var CandleProcessor_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.CandleProcessor = void 0;
const bullmq_1 = require("@nestjs/bullmq");
const common_1 = require("@nestjs/common");
const shared_1 = require("@quant/shared");
let CandleProcessor = CandleProcessor_1 = class CandleProcessor extends bullmq_1.WorkerHost {
    logger = new common_1.Logger(CandleProcessor_1.name);
    async process(job) {
        this.logger.debug(`Processing candle job ${job.id}: ${job.name}`);
        // Candle pipeline processing will be connected to SMC engines in subsequent phases
        return { success: true, processedAt: new Date().toISOString() };
    }
};
exports.CandleProcessor = CandleProcessor;
exports.CandleProcessor = CandleProcessor = CandleProcessor_1 = __decorate([
    (0, bullmq_1.Processor)(shared_1.BULLMQ_QUEUES.CANDLE_PROCESSING)
], CandleProcessor);
//# sourceMappingURL=candle.processor.js.map