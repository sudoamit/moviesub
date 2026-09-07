import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { BULLMQ_QUEUES } from '@quant/shared';
import { CandleProcessor } from './processors/candle.processor';
import { ScannerProcessor } from './processors/scanner.processor';
import { LearningProcessor } from './processors/learning.processor';
import { PositionMonitorProcessor } from './processors/position-monitor.processor';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
    }),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT) || 6380,
        password: process.env.REDIS_PASSWORD || undefined,
      },
    }),
    BullModule.registerQueue({
      name: BULLMQ_QUEUES.CANDLE_PROCESSING,
    }),
    BullModule.registerQueue({
      name: BULLMQ_QUEUES.SMC_ANALYSIS,
    }),
    BullModule.registerQueue({
      name: BULLMQ_QUEUES.SIGNAL_GENERATION,
    }),
    BullModule.registerQueue({
      name: BULLMQ_QUEUES.ALERT_PROCESSING,
    }),
    BullModule.registerQueue({
      name: BULLMQ_QUEUES.LEARNING_TASKS,
    }),
    BullModule.registerQueue({
      name: BULLMQ_QUEUES.POSITION_MONITORING,
    }),
  ],
  providers: [
    PrismaService,
    RedisService,
    CandleProcessor,
    ScannerProcessor,
    LearningProcessor,
    PositionMonitorProcessor,
  ],
})
export class WorkerModule {}
