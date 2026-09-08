"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkerModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const bullmq_1 = require("@nestjs/bullmq");
const shared_1 = require("@quant/shared");
const candle_processor_1 = require("./processors/candle.processor");
const scanner_processor_1 = require("./processors/scanner.processor");
const learning_processor_1 = require("./processors/learning.processor");
const position_monitor_processor_1 = require("./processors/position-monitor.processor");
const prisma_service_1 = require("./prisma.service");
const redis_service_1 = require("./redis.service");
let WorkerModule = class WorkerModule {
};
exports.WorkerModule = WorkerModule;
exports.WorkerModule = WorkerModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({
                isGlobal: true,
                envFilePath: ['.env', '../../.env'],
            }),
            bullmq_1.BullModule.forRoot({
                connection: {
                    host: process.env.REDIS_HOST || 'localhost',
                    port: Number(process.env.REDIS_PORT) || 6380,
                    password: process.env.REDIS_PASSWORD || undefined,
                },
            }),
            bullmq_1.BullModule.registerQueue({
                name: shared_1.BULLMQ_QUEUES.CANDLE_PROCESSING,
            }),
            bullmq_1.BullModule.registerQueue({
                name: shared_1.BULLMQ_QUEUES.SMC_ANALYSIS,
            }),
            bullmq_1.BullModule.registerQueue({
                name: shared_1.BULLMQ_QUEUES.SIGNAL_GENERATION,
            }),
            bullmq_1.BullModule.registerQueue({
                name: shared_1.BULLMQ_QUEUES.ALERT_PROCESSING,
            }),
            bullmq_1.BullModule.registerQueue({
                name: shared_1.BULLMQ_QUEUES.LEARNING_TASKS,
            }),
            bullmq_1.BullModule.registerQueue({
                name: shared_1.BULLMQ_QUEUES.POSITION_MONITORING,
            }),
        ],
        providers: [
            prisma_service_1.PrismaService,
            redis_service_1.RedisService,
            candle_processor_1.CandleProcessor,
            scanner_processor_1.ScannerProcessor,
            learning_processor_1.LearningProcessor,
            position_monitor_processor_1.PositionMonitorProcessor,
        ],
    })
], WorkerModule);
//# sourceMappingURL=worker.module.js.map