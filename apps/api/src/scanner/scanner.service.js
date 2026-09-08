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
var ScannerService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScannerService = void 0;
const common_1 = require("@nestjs/common");
const redis_service_1 = require("../common/redis/redis.service");
const signals_service_1 = require("../signals/signals.service");
const algo_bots_service_1 = require("../algo-bots/algo-bots.service");
const shared_1 = require("@quant/shared");
let ScannerService = ScannerService_1 = class ScannerService {
    redis;
    signalsService;
    algoBotsService;
    logger = new common_1.Logger(ScannerService_1.name);
    autoScanTimer = null;
    constructor(redis, signalsService, algoBotsService) {
        this.redis = redis;
        this.signalsService = signalsService;
        this.algoBotsService = algoBotsService;
    }
    onModuleInit() {
        this.logger.log('Starting Automatic Multi-Asset Market Scanner (10s interval)...');
        this.triggerScan(shared_1.Timeframe.M15).catch((err) => {
            this.logger.warn(`Initial market scan failed: ${err.message}`);
        });
        this.autoScanTimer = setInterval(() => {
            this.triggerScan(shared_1.Timeframe.M15).catch((err) => {
                this.logger.warn(`Auto market scan failed: ${err.message}`);
            });
        }, 10000);
    }
    onModuleDestroy() {
        if (this.autoScanTimer) {
            clearInterval(this.autoScanTimer);
            this.autoScanTimer = null;
        }
    }
    async triggerScan(timeframe = shared_1.Timeframe.M15) {
        const startTime = Date.now();
        const signals = await this.signalsService.getAllSignals(timeframe);
        const validSignals = signals.filter((s) => s.direction !== 'NEUTRAL' && s.score >= 60);
        // Evaluate active algo bots against valid high-conviction signals
        for (const sig of validSignals) {
            try {
                await this.algoBotsService.evaluateSignalForBots(sig);
            }
            catch (err) {
                this.logger.debug(`Algo bot evaluation note: ${err.message}`);
            }
        }
        const duration = Date.now() - startTime;
        const summary = {
            timestamp: new Date().toISOString(),
            timeframe,
            scannedCount: signals.length,
            signalsFound: validSignals.length,
            durationMs: duration,
            signals: validSignals,
        };
        // Cache latest scan status in Redis
        await this.redis.set('scanner:status:latest', JSON.stringify(summary), 86400);
        // Broadcast event
        const redisClient = this.redis.getClient();
        if (redisClient && redisClient.status === 'ready') {
            await redisClient.publish(shared_1.WS_EVENTS.SCANNER_UPDATED, JSON.stringify(summary));
        }
        this.logger.log(`Multi-asset scan completed in ${duration}ms. Signals found: ${validSignals.length}`);
        return summary;
    }
    async getScannerStatus() {
        const cached = await this.redis.get('scanner:status:latest');
        if (cached) {
            try {
                return JSON.parse(cached);
            }
            catch (e) {
                // Fallback
            }
        }
        return {
            timestamp: new Date().toISOString(),
            status: 'IDLE',
            message: 'Scanner initialized. No recent scan stored.',
            signalsFound: 0,
            scannedCount: 0,
            signals: [],
        };
    }
};
exports.ScannerService = ScannerService;
exports.ScannerService = ScannerService = ScannerService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [redis_service_1.RedisService,
        signals_service_1.SignalsService,
        algo_bots_service_1.AlgoBotsService])
], ScannerService);
//# sourceMappingURL=scanner.service.js.map