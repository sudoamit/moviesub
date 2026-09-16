import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import { SignalsService } from '../signals/signals.service';
import { AlgoBotsService } from '../algo-bots/algo-bots.service';
import { SignalGrade, SignalState, Timeframe, WS_EVENTS } from '@quant/shared';

@Injectable()
export class ScannerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScannerService.name);
  private autoScanTimer: NodeJS.Timeout | null = null;
  private isScanning = false;

  constructor(
    private readonly redis: RedisService,
    private readonly signalsService: SignalsService,
    private readonly algoBotsService: AlgoBotsService,
  ) {}

  onModuleInit() {
    this.logger.log(
      '[AUTHORITATIVE SCANNER] API ScannerService is the authoritative execution trigger for algo paper execution (10s interval)...',
    );
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
    if (this.isScanning) {
      this.logger.debug(
        `[SCANNER_LOCKED] Previous market scan is still executing. Skipping overlapping scan trigger.`,
      );
      return {
        timestamp: new Date().toISOString(),
        timeframe,
        scannedCount: 0,
        signalsFound: 0,
        durationMs: 0,
        signals: [],
        status: 'SKIPPED_OVERLAPPING',
      };
    }

    // Distributed Leader Election Lock for Multi-Instance API Deployments (8s TTL)
    const lockKey = `scanner:master_lock:${timeframe}`;
    const lockId = `instance_${process.pid}_${Math.random().toString(36).substring(2, 8)}`;
    const redisClient = this.redis.getClient();

    if (redisClient && redisClient.status === 'ready') {
      try {
        const setRes = await redisClient.set(lockKey, lockId, 'PX', 8000, 'NX');
        if (!setRes) {
          this.logger.debug(
            `[SCANNER_FOLLOWER_SKIPPED] Scanner leader lease held by another API instance. Skipping trigger.`,
          );
          return {
            timestamp: new Date().toISOString(),
            timeframe,
            scannedCount: 0,
            signalsFound: 0,
            durationMs: 0,
            signals: [],
            status: 'SKIPPED_FOLLOWER_INSTANCE',
          };
        }
      } catch (err: any) {
        this.logger.warn(`Failed acquiring Redis scanner master lock: ${err?.message || err}`);
      }
    }

    this.isScanning = true;
    this.algoBotsService.recordScanTime();

    try {
      const startTime = Date.now();
      const signals = await this.signalsService.getAllSignals(timeframe);

      let noTradeCount = 0;
      let neutralCount = 0;
      let activeCount = 0;
      let rejectedByScoreCount = 0;
      let rejectedByBotCount = 0;
      let failedCount = 0;
      let skippedCount = 0;
      let executedCount = 0;

      const validSignals: typeof signals = [];

      for (const sig of signals) {
        let botResultSummary = 'N/A';

        if (sig.grade === SignalGrade.NO_TRADE || sig.state === SignalState.INVALIDATED) {
          noTradeCount++;
          botResultSummary = `NO_TRADE (${sig.reasons?.[0] || 'market non-qualification'})`;
        } else if (sig.direction === 'NEUTRAL') {
          neutralCount++;
          botResultSummary = 'NEUTRAL';
        } else {
          activeCount++;
          if (sig.score < 60) {
            rejectedByScoreCount++;
            botResultSummary = 'rejected by score (<60)';
          } else {
            validSignals.push(sig);
            try {
              // Authoritative Single Pass: execute & retrieve per-bot machine-readable execution results
              const executionResults = await this.algoBotsService.evaluateSignalForBots(sig);

              const executed = executionResults.filter((r) => r.status === 'EXECUTED');
              const failed = executionResults.filter((r) => r.status === 'FAILED');
              const rejected = executionResults.filter((r) => r.status === 'REJECTED');
              const skipped = executionResults.filter((r) => r.status === 'SKIPPED');

              if (executed.length > 0) {
                executedCount += executed.length;
                botResultSummary = `EXECUTED (${executed.map((e) => `bot:${e.botId} pos:${e.orderPositionId}`).join(', ')})`;
              } else if (failed.length > 0) {
                failedCount += failed.length;
                botResultSummary = `FAILED (${failed.map((f) => `${f.botId}:${f.reasonCode}`).join(', ')})`;
              } else if (rejected.length > 0) {
                rejectedByBotCount += rejected.length;
                botResultSummary = `REJECTED (${rejected.map((r) => `${r.botId}:${r.reasonCode}`).join(', ')})`;
              } else if (skipped.length > 0) {
                skippedCount += skipped.length;
                botResultSummary = `SKIPPED (${skipped.map((s) => `${s.botId}:${s.reasonCode}`).join(', ')})`;
              }
            } catch (err) {
              botResultSummary = `error (${(err as Error).message})`;
              this.logger.warn(
                `[ALGO BOT EXECUTION ERROR] Failed evaluating signal ${sig.symbol} (${sig.timeframe}): ${(err as Error).message}`,
              );
            }
          }
        }

        const canonicalFormatted = sig.canonicalCandleTime
          ? new Date(sig.canonicalCandleTime).toISOString()
          : 'N/A';

        this.logger.log(
          `[SCANNER CANDIDATE REPORT]\n` +
            `symbol: ${sig.symbol}\n` +
            `direction: ${sig.direction}\n` +
            `score: ${sig.score}\n` +
            `state: ${sig.state}\n` +
            `canonicalCandleTime: ${canonicalFormatted}\n` +
            `SMC evidence: ${JSON.stringify(sig.triggerEvidence || {})}\n` +
            `bot result: ${botResultSummary}`,
        );
      }

      const duration = Date.now() - startTime;
      const summary = {
        timestamp: new Date().toISOString(),
        timeframe,
        scannedCount: signals.length,
        signalsFound: validSignals.length,
        noTradeCount,
        neutralCount,
        activeCount,
        rejectedByScoreCount,
        rejectedByBotCount,
        failedCount,
        skippedCount,
        executedCount,
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
        `[SCANNER SUMMARY] Scanned: ${signals.length} symbols | NO_TRADE: ${noTradeCount} | NEUTRAL: ${neutralCount} | ACTIVE: ${activeCount} | RejectedByScore: ${rejectedByScoreCount} | RejectedByBot: ${rejectedByBotCount} | Executed: ${executedCount} (Duration: ${duration}ms)`,
      );
      return summary;
    } finally {
      this.isScanning = false;
    }
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
