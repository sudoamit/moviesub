import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const logger = new Logger('WorkerBootstrap');
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  logger.log('====================================================');
  logger.log('⚙️  Quant Background BullMQ Worker started');
  logger.log('====================================================');

  // Handle graceful shutdown
  const shutdown = async () => {
    logger.log('Shutting down BullMQ Worker gracefully...');
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap().catch((err) => {
  console.error('Fatal error starting BullMQ Worker:', err);
  process.exit(1);
});
