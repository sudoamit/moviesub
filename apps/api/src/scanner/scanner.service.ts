import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import { SignalsService } from '../signals/signals.service';
import { AlgoBotsService } from '../algo-bots/algo-bots.service';
import { Timeframe, WS_EVENTS } from '@quant/shared';

@Injectable()
export class ScannerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScannerService.name);
  private autoScanTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly signalsService: SignalsService,
    private readonly algoBotsService: AlgoBotsService,
  ) {}

  onModuleInit() {
    this.logger.log('Starting Automatic Multi-Asset Market Scanner (10s interval)...');
    this.triggerScan(Timeframe.M15).catch((err) => {
      this.logger.warn(`Initial market scan failed: ${err.message}`);
    });

    this.autoScanTimer = setInterval(() => {
      this.triggerScan(Timeframe.M15).catch((err) => {
        this.logger.warn(`Auto market scan failed: ${err.message}`);
      });
    }, 10000);
  }

  onModuleDestroy() {
    if (this.autoScanTimer) {
      clearInterval(this.autoScanTimer);
      this.autoScanTimer = null;
    }
  }

  async triggerScan(timeframe: Timeframe = Timeframe.M15) {
    const startTime = Date.now();
    const signals = await this.signalsService.getAllSignals(timeframe);

    const validSignals = signals.filter((s) => s.direction !== 'NEUTRAL' && s.score >= 60);

    // Evaluate active algo bots against valid high-conviction signals
    for (const sig of validSignals) {
      try {
        await this.algoBotsService.evaluateSignalForBots(sig);
      } catch (err) {
        this.logger.debug(`Algo bot evaluation note: ${(err as Error).message}`);
      }
    }

    const duration = Date.now() - startTime;
    const summary = {
      timestamp: new Date().toISOString(),
      timeframe,
      scannedCount: signals.length,
      signalsFound: validSignals.length,
      durationMs: duration,
      signals: validSignals,
    };

    // Cache latest scan status in Redis
    await this.redis.set('scanner:status:latest', JSON.stringify(summary), 86400);

    // Broadcast event
    const redisClient = this.redis.getClient();
    if (redisClient && redisClient.status === 'ready') {
      await redisClient.publish(WS_EVENTS.SCANNER_UPDATED, JSON.stringify(summary));
    }

    this.logger.log(
      `Multi-asset scan completed in ${duration}ms. Signals found: ${validSignals.length}`,
    );
    return summary;
  }

  async getScannerStatus() {
    const cached = await this.redis.get('scanner:status:latest');
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        // Fallback
      }
    }

    return {
      timestamp: new Date().toISOString(),
      status: 'IDLE',
      message: 'Scanner initialized. No recent scan stored.',
      signalsFound: 0,
      scannedCount: 0,
      signals: [],
    };
  }
}
