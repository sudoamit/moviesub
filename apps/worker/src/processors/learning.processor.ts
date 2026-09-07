import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { BULLMQ_QUEUES } from '@quant/shared';
import { LearningEngine, ResearchEngine, ExperienceStore } from '@quant/learning-engine';
import { PrismaService } from '../prisma.service';

@Processor(BULLMQ_QUEUES.LEARNING_TASKS)
export class LearningProcessor extends WorkerHost {
  private readonly logger = new Logger(LearningProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.log(`Processing async learning job ${job.id} [${job.name}]...`);

    switch (job.name) {
      case 'LEARNING_CYCLE': {
        const report = await LearningEngine.runLearningCycle({
          autoPromote: job.data?.autoPromote ?? false,
        });
        this.logger.log(
          `✓ Learning cycle completed. Evaluated ${report.experiencesUsed} experiences.`,
        );
        return report;
      }

      case 'RESEARCH_EXPERIMENT': {
        const experiences = ExperienceStore.query();
        const candles = job.data?.candles || [];
        const result = await ResearchEngine.runResearchCycle(experiences, candles, {
          instrument: job.data?.symbol || 'NIFTY',
          timeframe: job.data?.timeframe || '15m',
        });
        this.logger.log(
          `✓ Research experiment completed with ${result.experiments.length} experiments.`,
        );
        return result;
      }

      default:
        this.logger.warn(`Unknown job name '${job.name}' received in LearningProcessor`);
        return { status: 'IGNORED' };
    }
  }
}
