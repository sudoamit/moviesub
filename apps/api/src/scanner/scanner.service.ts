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
  private isLeader = false;
  private lastScanStartedAt?: Date;
  private lastScanCompletedAt?: Date;
  private lastScanDurationMs = 0;

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

    this.autoScanTimer = setInterval(async () => {
      try {
        // Every selectable bot strategy must be scanned, otherwise bots on it can never receive a signal.
        await this.triggerScan(Timeframe.M15, 'SMC');
        await this.triggerScan(Timeframe.M15, 'SAIYAN_OCC');
        await this.triggerScan(Timeframe.M15, 'HYBRID');
      } catch (err: any) {
        this.logger.warn(`Auto market scan failed: ${err.message}`);
      }
    }, 15000);
  }

  onModuleDestroy() {
    if (this.autoScanTimer) {
      clearInterval(this.autoScanTimer);
      this.autoScanTimer = null;
    }
  }

  async triggerScan(
    timeframe: Timeframe = Timeframe.M15,
    strategyOrOptions?: 'SMC' | 'SAIYAN_OCC' | 'HYBRID' | string | { strategyConfig?: Record<string, any> },
    maybeOptions?: { strategyConfig?: Record<string, any> },
  ) {
    let strategy: string = 'SMC';
    let options: { strategyConfig?: Record<string, any> } | undefined = undefined;

    if (typeof strategyOrOptions === 'object' && strategyOrOptions !== null) {
      options = strategyOrOptions;
      if (options.strategyConfig?.strategy) {
        strategy = options.strategyConfig.strategy;
      }
    } else if (typeof strategyOrOptions === 'string') {
      strategy = strategyOrOptions;
      options = maybeOptions;
    }

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

    // Distributed leader lease for multi-instance API deployments. One lease per scan, released when the
    // scan ends so the next strategy scan in the same cycle can run.
    const leaseToken = await this.acquireScanLease();
    if (leaseToken === null) {
      this.isLeader = false;
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
    this.isLeader = true;

    this.isScanning = true;
    this.lastScanStartedAt = new Date();
    this.algoBotsService.recordScanTime();

    try {
      const startTime = Date.now();
      const signals = await this.signalsService.getAllSignals(timeframe, strategy as any, options);

      let noTradeCount = 0;
      let neutralCount = 0;
      let activeCount = 0;
      let h1AvailableCount = 0;
      let h4AvailableCount = 0;
      let scoreThresholdMetCount = 0;
      let scoreRejectedCount = 0;
      let botEvaluatedCount = 0;
      let botMatchedCount = 0;
      let botRejectedCount = 0;
      let botEligibleCount = 0;
      let executionAttemptedCount = 0;
      let executionFailedCount = 0;
      let skippedCount = 0;
      let executedCount = 0;

      const validSignals: typeof signals = [];

      for (const sig of signals) {
        let botResultSummary = 'N/A';

        const isH1Missing =
          sig.reasoning?.htfStructure?.includes('H1') &&
          sig.reasoning?.htfStructure?.includes('unavailable');
        if (!isH1Missing) {
          h1AvailableCount++;
        }
        const isH4Missing =
          sig.reasoning?.htfStructure?.includes('H4') &&
          sig.reasoning?.htfStructure?.includes('unavailable');
        if (!isH4Missing) {
          h4AvailableCount++;
        }

        if (sig.grade === SignalGrade.NO_TRADE || sig.state === SignalState.INVALIDATED) {
          noTradeCount++;
          botResultSummary = `NO_TRADE (${sig.reasons?.[0] || 'market non-qualification'})`;
        } else if (sig.direction === 'NEUTRAL') {
          neutralCount++;
          botResultSummary = 'NEUTRAL';
        } else {
          activeCount++;
          if (sig.score < 60) {
            scoreRejectedCount++;
            botResultSummary = 'rejected by score (<60)';
          } else {
            scoreThresholdMetCount++;
            validSignals.push(sig);
            try {
              botEvaluatedCount++;
              // Authoritative Single Pass: execute & retrieve per-bot machine-readable execution results
              const executionResults = await this.algoBotsService.evaluateSignalForBots(sig);

              if (
                executionResults.length > 0 &&
                executionResults[0].botId !== 'NONE' &&
                executionResults[0].botId !== 'N/A'
              ) {
                botMatchedCount += executionResults.length;
              }

              const executed = executionResults.filter((r) => r.status === 'EXECUTED');
              const failed = executionResults.filter((r) => r.status === 'FAILED');
              const rejected = executionResults.filter((r) => r.status === 'REJECTED');
              const skipped = executionResults.filter((r) => r.status === 'SKIPPED');

              if (executed.length > 0) {
                executionAttemptedCount += executed.length;
                executedCount += executed.length;
                botEligibleCount += executed.length;
                botResultSummary = `EXECUTED (${executed.map((e) => `bot:${e.botId} pos:${e.orderPositionId}`).join(', ')})`;
              } else if (failed.length > 0) {
                executionAttemptedCount += failed.length;
                executionFailedCount += failed.length;
                botEligibleCount += failed.length;
                botResultSummary = `FAILED (${failed.map((f) => `${f.botId}:${f.reasonCode}`).join(', ')})`;
              } else if (rejected.length > 0) {
                botRejectedCount += rejected.length;
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
      this.lastScanCompletedAt = new Date();
      this.lastScanDurationMs = duration;

      const summary = {
        timestamp: this.lastScanCompletedAt.toISOString(),
        timeframe,
        scannedCount: signals.length,
        instrumentsScanned: signals.length,
        signalsGenerated: signals.length,
        signalsFound: validSignals.length,
        noTradeCount,
        neutralCount,
        activeCount,
        h1AvailableCount,
        h4AvailableCount,
        scoreThresholdMetCount,
        scoreRejectedCount,
        botEvaluatedCount,
        botMatchedCount,
        botRejectedCount,
        botEligibleCount,
        skippedCount,
        executionAttemptedCount,
        executionFailedCount,
        failedCount: executionFailedCount,
        executedCount,
        durationMs: duration,
        signals: validSignals,
        scannerRunning: this.isScanning,
        scannerLeader: this.isLeader,
        paperExecutionEnabled: process.env.PAPER_TRADING_ENABLED === 'true',
        lastScanStartedAt: this.lastScanStartedAt?.toISOString(),
        lastScanCompletedAt: this.lastScanCompletedAt.toISOString(),
        lastScanDurationMs: duration,
      };

      // Cache latest scan status in Redis
      await this.redis.set('scanner:status:latest', JSON.stringify(summary), 86400);

      // Broadcast event
      const redisClient = this.redis.getClient();
      if (redisClient && redisClient.status === 'ready') {
        await redisClient.publish(WS_EVENTS.SCANNER_UPDATED, JSON.stringify(summary));
      }

      this.logger.log(
        `[SCANNER SUMMARY] Scanned: ${signals.length} symbols | NO_TRADE: ${noTradeCount} | NEUTRAL: ${neutralCount} | ACTIVE: ${activeCount} | Score>=60: ${scoreThresholdMetCount} | BotMatched: ${botMatchedCount} | ExecAttempted: ${executionAttemptedCount} | Executed: ${executedCount} | Failed: ${executionFailedCount} (Duration: ${duration}ms)`,
      );
      return summary;
    } finally {
      this.isScanning = false;
      await this.releaseScanLease(leaseToken);
    }
  }

  private static readonly SCAN_LEASE_KEY = 'scanner:leader';
  private static readonly SCAN_LEASE_MS = 60_000;

  /**
   * Acquires the scanner leader lease. Returns the lease token, '' when Redis is unavailable (single
   * instance: scan anyway), or null when a live lease is held by another instance.
   *
   * A lease is considered stale, and is taken over, when:
   * - its remaining TTL is longer than any lease can be (the system clock moved backwards after it was set:
   *   Redis stores absolute expiry times, so an 8s lease set "in December" would otherwise block scans for
   *   months), or
   * - its recorded acquisition time is in the future, or older than the lease duration.
   */
  private async acquireScanLease(): Promise<string | null> {
    const redisClient = this.redis.getClient();
    if (!redisClient || redisClient.status !== 'ready') return '';

    const key = ScannerService.SCAN_LEASE_KEY;
    const leaseMs = ScannerService.SCAN_LEASE_MS;
    const token = `instance_${process.pid}_${Math.random().toString(36).substring(2, 8)}`;
    const value = JSON.stringify({ token, acquiredAt: Date.now() });

    try {
      if (await redisClient.set(key, value, 'PX', leaseMs, 'NX')) return token;
    } catch (err: any) {
      // Redis failed on the acquire itself: behave as a single instance and scan (previous behavior).
      this.logger.warn(`Failed acquiring Redis scanner leader lock: ${err?.message || err}`);
      return '';
    }

    // The lease is held. Anything that goes wrong while inspecting it means "held": never scan concurrently.
    try {
      const [held, pttl] = await Promise.all([redisClient.get(key), redisClient.pttl(key)]);
      if (held === null) {
        // Lease expired between our SET and GET: try once more.
        return (await redisClient.set(key, value, 'PX', leaseMs, 'NX')) ? token : null;
      }
      let acquiredAt: number | null = null;
      try {
        acquiredAt = Number(JSON.parse(held || '').acquiredAt) || null;
      } catch {
        acquiredAt = null; // legacy plain-string lease
      }
      const now = Date.now();
      const isStale =
        pttl > leaseMs ||
        (acquiredAt !== null && (acquiredAt > now + 5_000 || now - acquiredAt > leaseMs));
      if (!isStale) return null;

      this.logger.warn(
        `[SCANNER_LEASE_RECOVERED] Discarding stale scanner lease '${held}' (pttl=${pttl}ms). The system clock likely changed.`,
      );
      // Compare-and-delete so we never remove a lease that changed hands in the meantime.
      await redisClient.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        key,
        held,
      );
      return (await redisClient.set(key, value, 'PX', leaseMs, 'NX')) ? token : null;
    } catch (err: any) {
      this.logger.warn(`Could not inspect held scanner lease; skipping this scan: ${err?.message || err}`);
      return null;
    }
  }

  private async releaseScanLease(token: string | null): Promise<void> {
    if (!token) return;
    const redisClient = this.redis.getClient();
    if (!redisClient || redisClient.status !== 'ready') return;
    try {
      const held = await redisClient.get(ScannerService.SCAN_LEASE_KEY);
      if (!held) return;
      let heldToken: string | null = null;
      try {
        heldToken = JSON.parse(held).token;
      } catch {
        heldToken = null;
      }
      if (heldToken === token) {
        await redisClient.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          ScannerService.SCAN_LEASE_KEY,
          held,
        );
      }
    } catch (err: any) {
      this.logger.warn(`Failed releasing scanner leader lock: ${err?.message || err}`);
    }
  }

  async getScannerStatus() {
    const cached = await this.redis.get('scanner:status:latest');
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        return {
          ...parsed,
          scannerRunning: this.isScanning,
          scannerLeader: this.isLeader,
          paperExecutionEnabled: process.env.PAPER_TRADING_ENABLED === 'true',
        };
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
      instrumentsScanned: 0,
      signalsGenerated: 0,
      noTradeCount: 0,
      neutralCount: 0,
      scoreRejectedCount: 0,
      botEvaluatedCount: 0,
      botRejectedCount: 0,
      skippedCount: 0,
      executionAttemptedCount: 0,
      executionFailedCount: 0,
      executedCount: 0,
      scannerRunning: this.isScanning,
      scannerLeader: this.isLeader,
      paperExecutionEnabled: process.env.PAPER_TRADING_ENABLED === 'true',
      lastScanStartedAt: this.lastScanStartedAt?.toISOString(),
      lastScanCompletedAt: this.lastScanCompletedAt?.toISOString(),
      lastScanDurationMs: this.lastScanDurationMs,
      signals: [],
    };
  }
}
