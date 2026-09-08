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
var AlgoBotsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AlgoBotsService = void 0;
const common_1 = require("@nestjs/common");
const paper_trading_service_1 = require("../paper-trading/paper-trading.service");
const alerts_service_1 = require("../alerts/alerts.service");
let AlgoBotsService = AlgoBotsService_1 = class AlgoBotsService {
    paperTradingService;
    alertsService;
    logger = new common_1.Logger(AlgoBotsService_1.name);
    // In-memory store of active algorithmic bots initialized with preset institutional bots
    bots = [
        {
            id: 'bot_nifty_smc_pro',
            name: 'NIFTY 15m Institutional Order Flow Scalper',
            symbol: 'NIFTY',
            direction: 'ANY',
            timeframe: '15m',
            minScore: 80,
            smcCondition: 'ORDER_BLOCK',
            lots: 1,
            autoExecutePaper: false,
            notifyWebhook: true,
            isActive: false,
            createdAt: new Date().toISOString(),
            triggerCount: 0,
        },
        {
            id: 'bot_banknifty_fvg',
            name: 'BANKNIFTY 15m Fair Value Gap Hunter',
            symbol: 'BANKNIFTY',
            direction: 'BEARISH',
            timeframe: '15m',
            minScore: 85,
            smcCondition: 'FVG',
            lots: 1,
            autoExecutePaper: false,
            notifyWebhook: true,
            isActive: false,
            createdAt: new Date().toISOString(),
            triggerCount: 0,
        },
        {
            id: 'bot_btc_liquidity_sweep',
            name: 'BTCUSDT 15m Liquidity Pool Sweeper',
            symbol: 'BTCUSDT',
            direction: 'BULLISH',
            timeframe: '15m',
            minScore: 75,
            smcCondition: 'LIQUIDITY_SWEEP',
            lots: 1,
            autoExecutePaper: false,
            notifyWebhook: false,
            isActive: false,
            createdAt: new Date().toISOString(),
            triggerCount: 0,
        },
    ];
    constructor(paperTradingService, alertsService) {
        this.paperTradingService = paperTradingService;
        this.alertsService = alertsService;
        this.logger.log(`Algo Strategy Studio initialized with ${this.bots.length} active automated bots.`);
    }
    async listBots() {
        return this.bots;
    }
    async createBot(dto) {
        const newBot = {
            id: `bot_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            name: dto.name || `${dto.symbol || 'NIFTY'} Custom SMC Bot`,
            symbol: (dto.symbol || 'NIFTY').toUpperCase(),
            direction: dto.direction || 'ANY',
            timeframe: dto.timeframe || '15m',
            minScore: Number(dto.minScore || 80),
            smcCondition: dto.smcCondition || 'ANY_CONFLUENCE',
            lots: Number(dto.lots || 1),
            autoExecutePaper: dto.autoExecutePaper === true,
            notifyWebhook: dto.notifyWebhook !== false,
            isActive: dto.isActive === true,
            createdAt: new Date().toISOString(),
            triggerCount: 0,
        };
        this.bots.unshift(newBot);
        this.logger.log(`✓ [ALGO BOT CREATED] '${newBot.name}' (${newBot.symbol} ${newBot.direction})`);
        return newBot;
    }
    async toggleBot(id) {
        const bot = this.bots.find((b) => b.id === id);
        if (!bot) {
            throw new common_1.NotFoundException(`Bot '${id}' not found`);
        }
        bot.isActive = !bot.isActive;
        this.logger.log(`✓ Bot '${bot.name}' is now ${bot.isActive ? 'ACTIVE' : 'PAUSED'}`);
        return bot;
    }
    async deleteBot(id) {
        const index = this.bots.findIndex((b) => b.id === id);
        if (index === -1) {
            throw new common_1.NotFoundException(`Bot '${id}' not found`);
        }
        this.bots.splice(index, 1);
        return { success: true };
    }
    /**
     * Evaluates incoming signal against all active bot strategies
     */
    async evaluateSignalForBots(signal) {
        for (const bot of this.bots) {
            if (!bot.isActive)
                continue;
            if (bot.symbol !== signal.symbol)
                continue;
            if (bot.direction !== 'ANY' && bot.direction !== signal.direction)
                continue;
            if (signal.score < bot.minScore)
                continue;
            // Update bot trigger metadata
            bot.triggerCount += 1;
            bot.lastTriggeredAt = new Date().toISOString();
            bot.lastTriggerDetails = `${signal.direction} Trigger @ ₹${signal.entryZone.optimal.toFixed(2)} (Score: ${signal.score}/100)`;
            this.logger.log(`🤖 [BOT TRIGGERED] '${bot.name}' -> ${signal.symbol} ${signal.direction} @ ₹${signal.entryZone.optimal}`);
            // Automated Paper Execution
            if (bot.autoExecutePaper) {
                try {
                    const portfolio = await this.paperTradingService.getPortfolio();
                    const alreadyOpen = portfolio.openPositions.some((p) => p.symbol === bot.symbol);
                    if (alreadyOpen) {
                        continue;
                    }
                    const lotMultiplier = bot.symbol === 'NIFTY'
                        ? 65
                        : bot.symbol === 'BANKNIFTY'
                            ? 15
                            : bot.symbol === 'BTCUSDT'
                                ? 0.2
                                : 100;
                    await this.paperTradingService.placeOrder({
                        symbol: bot.symbol,
                        direction: signal.direction === 'BULLISH' ? 'BUY' : 'SELL',
                        quantity: bot.lots * lotMultiplier,
                        orderType: 'MARKET',
                        signalPrice: signal.entryZone.optimal,
                        signalTime: signal.timestamp ? new Date(signal.timestamp).toISOString() : undefined,
                        stopLoss: signal.stopLoss,
                        target1: signal.takeProfits.tp1,
                        target2: signal.takeProfits.tp2,
                        target3: signal.takeProfits.tp3,
                    });
                }
                catch (e) {
                    this.logger.error(`Bot execution failed: ${e.message}`);
                }
            }
        }
    }
};
exports.AlgoBotsService = AlgoBotsService;
exports.AlgoBotsService = AlgoBotsService = AlgoBotsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [paper_trading_service_1.PaperTradingService,
        alerts_service_1.AlertsService])
], AlgoBotsService);
//# sourceMappingURL=algo-bots.service.js.map