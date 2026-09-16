import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import { SignalsService } from '../signals/signals.service';
import { AlgoBotsService } from '../algo-bots/algo-bots.service';
import { Timeframe, WS_EVENTS } from '@quant/shared';

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
      let executedCount = 0;

      const validSignals: typeof signals = [];

      for (const sig of signals) {
        let botResultSummary = 'N/A';

        if (sig.grade === ('NO_TRADE' as any)) {
          noTradeCount++;
          botResultSummary = 'NO_TRADE';
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
              const bots = await this.algoBotsService.listBots();
              const relevantBot = bots.find((b) => b.symbol.toUpperCase() === sig.symbol.toUpperCase());

              if (relevantBot) {
                const diag = await this.algoBotsService.evaluateBotForSignalDiagnostics(relevantBot, sig);
                if (diag.matches) {
                  botResultSummary = 'ready_to_execute';
                } else {
                  botResultSummary = `rejected by bot (${diag.reasons.join(', ')})`;
                  rejectedByBotCount++;
                }
              } else {
                botResultSummary = 'no bot configured';
              }

              await this.algoBotsService.evaluateSignalForBots(sig);
              if (relevantBot && botResultSummary === 'ready_to_execute') {
                const health = await this.algoBotsService.getAlgoExecutionHealth();
                if (health.lastExecutionSuccess && Date.now() - new Date(health.lastExecutionSuccess).getTime() < 5000) {
                  botResultSummary = 'executed';
                  executedCount++;
                }
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
