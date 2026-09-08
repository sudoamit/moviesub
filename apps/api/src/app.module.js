"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const config_1 = require("@nestjs/config");
const throttler_1 = require("@nestjs/throttler");
const prisma_module_1 = require("./common/prisma/prisma.module");
const redis_module_1 = require("./common/redis/redis.module");
const health_module_1 = require("./health/health.module");
const instruments_module_1 = require("./instruments/instruments.module");
const market_data_module_1 = require("./market-data/market-data.module");
const candles_module_1 = require("./candles/candles.module");
const smc_module_1 = require("./smc/smc.module");
const signals_module_1 = require("./signals/signals.module");
const backtests_module_1 = require("./backtests/backtests.module");
const scanner_module_1 = require("./scanner/scanner.module");
const websocket_module_1 = require("./websocket/websocket.module");
const alerts_module_1 = require("./alerts/alerts.module");
const auth_module_1 = require("./auth/auth.module");
const ai_summary_module_1 = require("./ai-summary/ai-summary.module");
const options_module_1 = require("./options/options.module");
const paper_trading_module_1 = require("./paper-trading/paper-trading.module");
const algo_bots_module_1 = require("./algo-bots/algo-bots.module");
const macro_events_module_1 = require("./macro-events/macro-events.module");
const accuracy_module_1 = require("./accuracy/accuracy.module");
const ai_learning_module_1 = require("./ai-learning/ai-learning.module");
const learning_module_1 = require("./learning/learning.module");
const research_module_1 = require("./research/research.module");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({
                isGlobal: true,
                envFilePath: ['.env', '../../.env'],
            }),
            throttler_1.ThrottlerModule.forRoot([
                {
                    ttl: 60000,
                    limit: 180,
                },
            ]),
            prisma_module_1.PrismaModule,
            redis_module_1.RedisModule,
            health_module_1.HealthModule,
            instruments_module_1.InstrumentsModule,
            market_data_module_1.MarketDataModule,
            candles_module_1.CandlesModule,
            smc_module_1.SMCModule,
            signals_module_1.SignalsModule,
            backtests_module_1.BacktestsModule,
            scanner_module_1.ScannerModule,
            websocket_module_1.WebsocketModule,
            alerts_module_1.AlertsModule,
            auth_module_1.AuthModule,
            ai_summary_module_1.AISummaryModule,
            options_module_1.OptionsModule,
            paper_trading_module_1.PaperTradingModule,
            algo_bots_module_1.AlgoBotsModule,
            macro_events_module_1.MacroEventsModule,
            accuracy_module_1.AccuracyModule,
            ai_learning_module_1.AILearningModule,
            learning_module_1.LearningModule,
            research_module_1.ResearchModule,
        ],
        providers: [
            {
                provide: core_1.APP_GUARD,
                useClass: throttler_1.ThrottlerGuard,
            },
        ],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map