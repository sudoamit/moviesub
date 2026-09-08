import { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import { SignalsService } from '../signals/signals.service';
import { AlgoBotsService } from '../algo-bots/algo-bots.service';
import { Timeframe } from '@quant/shared';
export declare class ScannerService implements OnModuleInit, OnModuleDestroy {
    private readonly redis;
    private readonly signalsService;
    private readonly algoBotsService;
    private readonly logger;
    private autoScanTimer;
    constructor(redis: RedisService, signalsService: SignalsService, algoBotsService: AlgoBotsService);
    onModuleInit(): void;
    onModuleDestroy(): void;
    triggerScan(timeframe?: Timeframe): Promise<{
        timestamp: string;
        timeframe: Timeframe;
        scannedCount: number;
        signalsFound: number;
        durationMs: number;
        signals: import("@quant/shared").ISignalSetup[];
    }>;
    getScannerStatus(): Promise<any>;
}
