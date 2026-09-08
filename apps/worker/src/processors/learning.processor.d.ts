import { WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma.service';
import { RedisService } from '../redis.service';
export declare class LearningProcessor extends WorkerHost {
    private readonly prisma;
    private readonly redis;
    private readonly logger;
    constructor(prisma: PrismaService, redis: RedisService);
    process(job: Job<any, any, string>): Promise<any>;
    /**
     * Executes the full walk-forward supervised training pipeline inside the background worker.
     */
    private executeRetrainPipeline;
    /**
     * Builds an authentic training dataset from multi-asset candles without lookahead bias.
     */
    private buildTrainingDataset;
}
