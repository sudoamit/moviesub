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
var BacktestsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.BacktestsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../common/prisma/prisma.service");
const candles_service_1 = require("../candles/candles.service");
const backtesting_1 = require("@quant/backtesting");
const shared_1 = require("@quant/shared");
const library_1 = require("@prisma/client/runtime/library");
let BacktestsService = BacktestsService_1 = class BacktestsService {
    prisma;
    candlesService;
    logger = new common_1.Logger(BacktestsService_1.name);
    constructor(prisma, candlesService) {
        this.prisma = prisma;
        this.candlesService = candlesService;
    }
    async runBacktest(dto) {
        const sym = dto.symbol.toUpperCase();
        const timeframe = dto.timeframe || shared_1.Timeframe.M15;
        const inst = await this.prisma.instrument.findUnique({
            where: { symbol: sym },
        });
        if (!inst) {
            throw new common_1.NotFoundException(`Instrument '${sym}' not found`);
        }
        const candlesRes = await this.candlesService.getCandles({
            symbol: sym,
            timeframe,
            limit: dto.limit || 300,
        });
        const simulation = backtesting_1.BacktestSimulator.runSimulation({
            symbol: sym,
            timeframe,
            candles: candlesRes.candles,
            initialCapital: dto.initialCapital || 100000,
            riskPerTradePercent: dto.riskPerTradePercent || 1.0,
            minScore: dto.minScore || 65,
            lotSize: sym === 'BTCUSDT' ? 0.01 : inst.lotSize || 1,
        });
        const startDate = candlesRes.candles[0]?.timestamp || new Date();
        const endDate = candlesRes.candles[candlesRes.candles.length - 1]?.timestamp || new Date();
        const prismaTf = (0, shared_1.toPrismaTimeframe)(timeframe);
        // Save to Database
        const savedRun = await this.prisma.backtest.create({
            data: {
                instrumentId: inst.id,
                timeframe: prismaTf,
                startDate,
                endDate,
                initialCapital: new library_1.Decimal(simulation.initialCapital),
                riskPerTradePercent: new library_1.Decimal(dto.riskPerTradePercent || 1.0),
                netPnL: new library_1.Decimal(simulation.netPnL),
                winRate: new library_1.Decimal(simulation.winRate),
                profitFactor: new library_1.Decimal(simulation.profitFactor),
                maxDrawdownPercent: new library_1.Decimal(simulation.maxDrawdownPercent),
                maxConsecutiveLosses: simulation.maxConsecutiveLosses,
                totalTrades: simulation.totalTrades,
                winningTrades: simulation.winningTrades,
                losingTrades: simulation.losingTrades,
                expectancy: new library_1.Decimal(simulation.expectancy),
                averageR: new library_1.Decimal(simulation.averageR),
                sharpeRatio: simulation.sharpeRatio ? new library_1.Decimal(simulation.sharpeRatio) : null,
                parametersJson: {
                    ...dto,
                    equityCurve: simulation.equityCurve,
                },
            },
        });
        // Save individual trades if any
        for (const tr of simulation.trades) {
            await this.prisma.backtestTrade.create({
                data: {
                    backtestId: savedRun.id,
                    direction: tr.direction,
                    entryTime: tr.entryTime,
                    exitTime: tr.exitTime,
                    entryPrice: new library_1.Decimal(tr.entryPrice),
                    exitPrice: new library_1.Decimal(tr.exitPrice),
                    stopLoss: new library_1.Decimal(tr.stopLoss),
                    takeProfit: new library_1.Decimal(tr.takeProfit),
                    positionSize: new library_1.Decimal(tr.positionSize),
                    pnl: new library_1.Decimal(tr.pnl),
                    pnlRMultiple: new library_1.Decimal(tr.pnlRMultiple),
                    exitReason: tr.exitReason,
                },
            });
        }
        this.logger.log(`Backtest completed for ${sym} [${timeframe}]. Total trades: ${simulation.totalTrades}, Win Rate: ${simulation.winRate}%, Net PnL: ${simulation.netPnL}`);
        return {
            ...simulation,
            id: savedRun.id,
        };
    }
    async listBacktests() {
        return this.prisma.backtest.findMany({
            include: {
                instrument: {
                    select: { symbol: true, name: true, assetType: true },
                },
            },
            orderBy: { createdAt: 'desc' },
            take: 20,
        });
    }
    async getBacktestById(id) {
        const run = await this.prisma.backtest.findUnique({
            where: { id },
            include: {
                instrument: true,
                trades: {
                    orderBy: { entryTime: 'asc' },
                },
            },
        });
        if (!run) {
            throw new common_1.NotFoundException(`Backtest run with id '${id}' not found`);
        }
        return run;
    }
};
exports.BacktestsService = BacktestsService;
exports.BacktestsService = BacktestsService = BacktestsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        candles_service_1.CandlesService])
], BacktestsService);
//# sourceMappingURL=backtests.service.js.map