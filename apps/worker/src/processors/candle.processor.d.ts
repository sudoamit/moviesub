import { WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
export declare class CandleProcessor extends WorkerHost {
    private readonly logger;
    process(job: Job<any, any, string>): Promise<any>;
}
