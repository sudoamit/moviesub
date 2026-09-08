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
var ScannerProcessor_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScannerProcessor = void 0;
const bullmq_1 = require("@nestjs/bullmq");
const common_1 = require("@nestjs/common");
const shared_1 = require("@quant/shared");
const prisma_service_1 = require("../prisma.service");
const redis_service_1 = require("../redis.service");
const trading_engine_1 = require("@quant/trading-engine");
const library_1 = require("@prisma/client/runtime/library");
let ScannerProcessor = ScannerProcessor_1 = class ScannerProcessor extends bullmq_1.WorkerHost {
    prisma;
    redis;
    logger = new common_1.Logger(ScannerProcessor_1.name);
    constructor(prisma, redis) {
        super();
        this.prisma = prisma;
        this.redis = redis;
    }
    async process(job) {
        this.logger.log(`Starting market scanner execution for job ${job.id}: ${job.name}`);
        const startTime = Date.now();
        const instruments = await this.prisma.instrument.findMany({
            where: { isActive: true },
        });
        const results = [];
        for (const inst of instruments) {
            try {
                const signal = await this.scanInstrument(inst.id, inst.symbol);
                if (signal && signal.direction !== shared_1.Direction.NEUTRAL && signal.score >= 60) {
                    results.push(signal);
                }
            }
            catch (err) {
                this.logger.error(`Error scanning instrument ${inst.symbol}: ${err.message}`);
            }
        }
        const duration = Date.now() - startTime;
        const summary = {
            timestamp: new Date().toISOString(),
            scannedCount: instruments.length,
            signalsFound: results.length,
            durationMs: duration,
            signals: results,
        };
        // Cache latest scanner status in Redis
        await this.redis.set('scanner:status:latest', JSON.stringify(summary), 86400);
        this.logger.log(`Market scan complete in ${duration}ms. Scanned: ${instruments.length} instruments, Generated: ${results.length} valid signals`);
        return summary;
    }
    async scanInstrument(instrumentId, symbol) {
        const prisma15m = (0, shared_1.toPrismaTimeframe)('15m');
        const prisma1h = (0, shared_1.toPrismaTimeframe)('1h');
        const prisma4h = (0, shared_1.toPrismaTimeframe)('4h');
        // Fetch multi-timeframe candles
        const [db15m, db1h, db4h] = await Promise.all([
            this.prisma.candle.findMany({
                where: { instrumentId, timeframe: prisma15m },
                orderBy: { timestamp: 'desc' },
                take: 200,
            }),
            this.prisma.candle.findMany({
                where: { instrumentId, timeframe: prisma1h },
                orderBy: { timestamp: 'desc' },
                take: 150,
            }),
            this.prisma.candle.findMany({
                where: { instrumentId, timeframe: prisma4h },
                orderBy: { timestamp: 'desc' },
                take: 100,
            }),
        ]);
        const toCandles = (dbList) => dbList.reverse().map((c) => ({
            timestamp: c.timestamp,
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close),
            volume: Number(c.volume),
            isClosed: c.isClosed,
        }));
        const execCandles = toCandles(db15m);
        const htf1Candles = toCandles(db1h);
        const htf2Candles = toCandles(db4h);
        if (execCandles.length < 20)
            return null;
        const signal = trading_engine_1.SignalGenerator.generateSignal({
            symbol,
            executionCandles: execCandles,
            executionTimeframe: shared_1.Timeframe.M15,
            htf1Candles,
            htf1Timeframe: shared_1.Timeframe.H1,
            htf2Candles,
            htf2Timeframe: shared_1.Timeframe.H4,
        });
        if (signal.direction === shared_1.Direction.NEUTRAL || signal.score < 60) {
            return null;
        }
        const tfPrisma = (0, shared_1.toPrismaTimeframe)(signal.timeframe);
        const fortyFiveMinutesAgo = new Date(Date.now() - 45 * 60 * 1000);
        // Deduplication check: check if an identical active/pending signal was recorded in the last 45 minutes
        const existing = await this.prisma.signal.findFirst({
            where: {
                instrumentId,
                timeframe: tfPrisma,
                direction: signal.direction,
                state: { in: ['PENDING', 'ACTIVE'] },
                createdAt: { gte: fortyFiveMinutesAgo },
            },
            orderBy: { createdAt: 'desc' },
        });
        let savedSignalId;
        if (existing) {
            // Update existing active setup score & targets instead of duplicating rows
            await this.prisma.signal.update({
                where: { id: existing.id },
                data: {
                    score: signal.score,
                    grade: signal.grade,
                    entryPrice: new library_1.Decimal(signal.entryZone.optimal),
                    stopLoss: new library_1.Decimal(signal.stopLoss),
                    target1: new library_1.Decimal(signal.takeProfits.tp1),
                    target2: new library_1.Decimal(signal.takeProfits.tp2),
                    target3: new library_1.Decimal(signal.takeProfits.tp3),
                    reasonsJson: signal.reasoning.confirmedChecklist,
                },
            });
            savedSignalId = existing.id;
        }
        else {
            // Persist new signal to PostgreSQL
            const savedSignal = await this.prisma.signal.create({
                data: {
                    instrumentId,
                    direction: signal.direction,
                    state: signal.state,
                    grade: signal.grade,
                    score: signal.score,
                    timeframe: tfPrisma,
                    entryPrice: new library_1.Decimal(signal.entryZone.optimal),
                    stopLoss: new library_1.Decimal(signal.stopLoss),
                    target1: new library_1.Decimal(signal.takeProfits.tp1),
                    target2: new library_1.Decimal(signal.takeProfits.tp2),
                    target3: new library_1.Decimal(signal.takeProfits.tp3),
                    riskRewardRatio: new library_1.Decimal(signal.riskRewardRatios.rr2),
                    reasonsJson: signal.reasoning.confirmedChecklist,
                    risksJson: [signal.reasoning.invalidationReason],
                },
            });
            savedSignalId = savedSignal.id;
        }
        signal.id = savedSignalId;
        signal.instrumentId = instrumentId;
        // Publish event over Redis PubSub
        await this.redis.publish(shared_1.WS_EVENTS.SIGNAL_GENERATED, JSON.stringify(signal));
        // High conviction alert event (Score >= 80)
        if (signal.score >= 80) {
            await this.redis.publish(shared_1.WS_EVENTS.ALERT_TRIGGERED, JSON.stringify({
                alertId: `alert-${signal.id}`,
                symbol,
                score: signal.score,
                grade: signal.grade,
                direction: signal.direction,
                summary: signal.reasoning.summary,
                timestamp: new Date().toISOString(),
            }));
        }
        return signal;
    }
};
exports.ScannerProcessor = ScannerProcessor;
exports.ScannerProcessor = ScannerProcessor = ScannerProcessor_1 = __decorate([
    (0, bullmq_1.Processor)(shared_1.BULLMQ_QUEUES.SIGNAL_GENERATION),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService])
], ScannerProcessor);
//# sourceMappingURL=scanner.processor.js.map