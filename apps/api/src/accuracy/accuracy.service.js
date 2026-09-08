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
var AccuracyService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccuracyService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../common/prisma/prisma.service");
const trading_engine_1 = require("@quant/trading-engine");
let AccuracyService = AccuracyService_1 = class AccuracyService {
    prisma;
    logger = new common_1.Logger(AccuracyService_1.name);
    constructor(prisma) {
        this.prisma = prisma;
    }
    /**
     * 1. Get Live Active ICT Session & Kill Zone Info
     */
    getSessionInfo(symbol = 'NIFTY') {
        return trading_engine_1.SessionFilter.getSessionInfo(new Date(), symbol);
    }
    /**
     * Helper to fetch parsed candles for an instrument
     */
    async getCandlesForInstrument(symbol, timeframe, limit = 60) {
        const inst = await this.prisma.instrument.findUnique({
            where: { symbol: symbol.toUpperCase() },
        });
        if (!inst)
            return [];
        const rows = await this.prisma.candle.findMany({
            where: { instrumentId: inst.id, timeframe: timeframe },
            orderBy: { timestamp: 'desc' },
            take: limit,
        });
        return rows.reverse().map((r) => ({
            timestamp: r.timestamp,
            open: Number(r.open),
            high: Number(r.high),
            low: Number(r.low),
            close: Number(r.close),
            volume: Number(r.volume || 1),
            isClosed: true,
        }));
    }
    /**
     * 2. SMT (Smart Money Technique) Correlation Divergence Engine
     */
    async getSMTDivergence(assetA = 'NIFTY', assetB = 'BANKNIFTY', timeframe = 'M15') {
        const [candlesA, candlesB] = await Promise.all([
            this.getCandlesForInstrument(assetA, timeframe, 50),
            this.getCandlesForInstrument(assetB, timeframe, 50),
        ]);
        return trading_engine_1.SMTDivergenceEngine.analyze(assetA, candlesA, assetB, candlesB, 35);
    }
    /**
     * 2b. Multi-Timeframe SMT Divergence Heatmap Matrix (1m -> 5m -> 15m -> 1h -> 4h -> 1d)
     */
    async getSMTMultiTimeframe(assetA = 'NIFTY', assetB = 'BANKNIFTY') {
        const timeframes = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];
        const results = await Promise.all(timeframes.map(async (tf) => {
            const [candlesA, candlesB] = await Promise.all([
                this.getCandlesForInstrument(assetA, tf, 50),
                this.getCandlesForInstrument(assetB, tf, 50),
            ]);
            const res = trading_engine_1.SMTDivergenceEngine.analyze(assetA, candlesA, assetB, candlesB, 35);
            return {
                timeframe: tf,
                ...res,
            };
        }));
        const activeDivergences = results.filter((r) => r.divergenceType !== 'NEUTRAL');
        const primaryDivergence = results.find((r) => r.timeframe === 'M15') || results[2] || results[0];
        return {
            assetA,
            assetB,
            primary: primaryDivergence,
            divergenceConfluenceCount: activeDivergences.length,
            timeframeResults: results,
            timestamp: new Date().toISOString(),
        };
    }
    /**
     * 3. Multi-Timeframe 4-Tier Order Flow Confluence Radar (4h -> 1h -> 15m -> 5m)
     */
    async getMTFFlowRadar(symbol = 'NIFTY') {
        const [c4h, c1h, c15m, c5m] = await Promise.all([
            this.getCandlesForInstrument(symbol, 'H4', 40),
            this.getCandlesForInstrument(symbol, 'H1', 40),
            this.getCandlesForInstrument(symbol, 'M15', 40),
            this.getCandlesForInstrument(symbol, 'M5', 40),
        ]);
        return trading_engine_1.MTFFlowRadarEngine.analyze(symbol, c4h, c1h, c15m, c5m);
    }
    /**
     * 4. Dynamic Breakeven & Auto-Trailing Stop Engine
     */
    getDynamicTrailingState(entryPrice, stopLoss, tp1, tp2, currentPrice, direction = 'BULLISH', atr = 25) {
        return trading_engine_1.TrailingEngine.evaluate(entryPrice, stopLoss, tp1, tp2, currentPrice, direction, atr);
    }
    /**
     * 5. Institutional Liquidity Heatmap
     */
    async getLiquidityHeatmap(symbol = 'NIFTY') {
        const candles = await this.getCandlesForInstrument(symbol, 'M15', 80);
        return trading_engine_1.LiquidityHeatmapEngine.compute(candles);
    }
};
exports.AccuracyService = AccuracyService;
exports.AccuracyService = AccuracyService = AccuracyService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], AccuracyService);
//# sourceMappingURL=accuracy.service.js.map