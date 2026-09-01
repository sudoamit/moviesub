import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { BULLMQ_QUEUES } from '@quant/shared';

@Processor(BULLMQ_QUEUES.CANDLE_PROCESSING)
export class CandleProcessor extends WorkerHost {
  private readonly logger = new Logger(CandleProcessor.name);

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.debug(`Processing candle job ${job.id}: ${job.name}`);
    // Candle pipeline processing will be connected to SMC engines in subsequent phases
    return { success: true, processedAt: new Date().toISOString() };
  }
}
