import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { HealthModule } from './health/health.module';
import { InstrumentsModule } from './instruments/instruments.module';
import { MarketDataModule } from './market-data/market-data.module';
import { CandlesModule } from './candles/candles.module';
import { SMCModule } from './smc/smc.module';
import { SignalsModule } from './signals/signals.module';
import { BacktestsModule } from './backtests/backtests.module';
import { ScannerModule } from './scanner/scanner.module';
import { WebsocketModule } from './websocket/websocket.module';
import { AlertsModule } from './alerts/alerts.module';
import { AuthModule } from './auth/auth.module';
import { AISummaryModule } from './ai-summary/ai-summary.module';
import { OptionsModule } from './options/options.module';
import { PaperTradingModule } from './paper-trading/paper-trading.module';
import { AlgoBotsModule } from './algo-bots/algo-bots.module';
import { MacroEventsModule } from './macro-events/macro-events.module';
import { AccuracyModule } from './accuracy/accuracy.module';
import { AILearningModule } from './ai-learning/ai-learning.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
    }),
    PrismaModule,
    RedisModule,
    HealthModule,
    InstrumentsModule,
    MarketDataModule,
    CandlesModule,
    SMCModule,
    SignalsModule,
    BacktestsModule,
    ScannerModule,
    WebsocketModule,
    AlertsModule,
    AuthModule,
    AISummaryModule,
    OptionsModule,
    PaperTradingModule,
    AlgoBotsModule,
    MacroEventsModule,
    AccuracyModule,
    AILearningModule,
  ],
})
export class AppModule {}
