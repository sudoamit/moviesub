import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  BULLMQ_QUEUES,
  Direction,
  IMarketDataProvider,
  RealLiveMarketDataProvider,
  Timeframe,
  toPrismaTimeframe,
  WS_EVENTS,
} from '@quant/shared';
import { PrismaService } from '../prisma.service';
import { RedisService } from '../redis.service';
import {
  CanonicalMarketSnapshotBuilder,
  SignalGenerator,
} from '@quant/trading-engine';
import { Decimal } from '@prisma/client/runtime/library';

@Processor(BULLMQ_QUEUES.SIGNAL_GENERATION)
export class ScannerProcessor extends WorkerHost {
  private readonly logger = new Logger(ScannerProcessor.name);
  private provider: IMarketDataProvider;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    super();
    this.provider = new RealLiveMarketDataProvider();
  }

  setProvider(provider: IMarketDataProvider) {
    this.provider = provider;
  }

  getProvider(): IMarketDataProvider {
    return this.provider;
  }

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.log(`Starting canonical market scanner execution for job ${job.id}: ${job.name}`);
    const startTime = Date.now();

    const instruments = await this.prisma.instrument.findMany({
      where: { isActive: true },
    });

    const results: any[] = [];

    for (const inst of instruments) {
      try {
        const signal = await this.scanInstrument(inst.id, inst.symbol);
        if (signal && signal.direction !== Direction.NEUTRAL && signal.score >= 60) {
          results.push(signal);
        }
      } catch (err) {
        this.logger.error(`Error scanning instrument ${inst.symbol}: ${(err as Error).message}`);
      }
    }

    const duration = Date.now() - startTime;
    const summary = {
      timestamp: new Date().toISOString(),
      scannedCount: instruments.length,
      signalsFound: results.length,
      durationMs: duration,
      signals: results,
    };

    // Cache latest scanner status in Redis
    await this.redis.set('scanner:status:latest', JSON.stringify(summary), 86400);

    this.logger.log(
      `Canonical market scan complete in ${duration}ms. Scanned: ${instruments.length} instruments, Generated: ${results.length} valid signals`,
    );

    return summary;
  }

  /**
   * Scans a single instrument using strictly canonical point-in-time snapshots and LIVE_DECISION authority.
   * Zero direct Prisma candle queries are performed.
   */
  private async scanInstrument(instrumentId: string, symbol: string) {
    const sym = symbol.toUpperCase();

    // 1. Fetch Multi-Timeframe Candles via Authoritative Live Market Data Provider
    const [rawM15, rawH1, rawH4] = await Promise.all([
      this.provider.getHistoricalCandles(sym, Timeframe.M15, 200),
      this.provider.getHistoricalCandles(sym, Timeframe.H1, 150),
      this.provider.getHistoricalCandles(sym, Timeframe.H4, 100),
    ]);

    if (!rawM15 || rawM15.length < 20) {
      return null;
    }

    // 2. Construct Canonical Market Snapshots under LIVE_DECISION Mode
    const executionSnapshot = CanonicalMarketSnapshotBuilder.build({
      symbol: sym,
      executionCandles: rawM15,
      executionTimeframe: Timeframe.M15,
      dataProvenance: 'LIVE',
    });

    const htf1Snapshot = rawH1 && rawH1.length > 0
      ? CanonicalMarketSnapshotBuilder.build({
          symbol: sym,
          executionCandles: rawH1,
          executionTimeframe: Timeframe.H1,
          asOfTimestamp: executionSnapshot.decisionTimestamp,
          dataProvenance: 'LIVE',
        })
      : undefined;

    const htf2Snapshot = rawH4 && rawH4.length > 0
      ? CanonicalMarketSnapshotBuilder.build({
          symbol: sym,
          executionCandles: rawH4,
          executionTimeframe: Timeframe.H4,
          asOfTimestamp: executionSnapshot.decisionTimestamp,
          dataProvenance: 'LIVE',
        })
      : undefined;

    // 3. Generate Signal via Canonical Snapshot API
    const signal = SignalGenerator.generateFromSnapshots({
      executionSnapshot,
      htf1Snapshot,
      htf2Snapshot,
    });

    if (signal.direction === Direction.NEUTRAL || signal.score < 60) {
      return null;
    }

    const tfPrisma = toPrismaTimeframe(signal.timeframe);
    const fortyFiveMinutesAgo = new Date(Date.now() - 45 * 60 * 1000);

    // Deduplication check: check if an identical active/pending signal was recorded in the last 45 minutes
    const existing = await this.prisma.signal.findFirst({
      where: {
        instrumentId,
        timeframe: tfPrisma as any,
        direction: signal.direction as any,
        state: { in: ['PENDING', 'ACTIVE'] as any },
        createdAt: { gte: fortyFiveMinutesAgo },
      },
      orderBy: { createdAt: 'desc' },
    });

    let savedSignalId: string;

    if (existing) {
      // Update existing active setup score & targets instead of duplicating rows
      await this.prisma.signal.update({
        where: { id: existing.id },
        data: {
          score: signal.score,
          grade: signal.grade as any,
          entryPrice: new Decimal(signal.entryZone.optimal),
          stopLoss: new Decimal(signal.stopLoss),
          target1: new Decimal(signal.takeProfits.tp1),
          target2: new Decimal(signal.takeProfits.tp2),
          target3: new Decimal(signal.takeProfits.tp3),
          reasonsJson: signal.reasoning.confirmedChecklist as any,
        },
      });
      savedSignalId = existing.id;
    } else {
      // Persist new signal to PostgreSQL
      const savedSignal = await this.prisma.signal.create({
        data: {
          instrumentId,
          direction: signal.direction as any,
          state: signal.state as any,
          grade: signal.grade as any,
          score: signal.score,
          timeframe: tfPrisma as any,
          entryPrice: new Decimal(signal.entryZone.optimal),
          stopLoss: new Decimal(signal.stopLoss),
          target1: new Decimal(signal.takeProfits.tp1),
          target2: new Decimal(signal.takeProfits.tp2),
          target3: new Decimal(signal.takeProfits.tp3),
          riskRewardRatio: new Decimal(signal.riskRewardRatios.rr2),
          reasonsJson: signal.reasoning.confirmedChecklist as any,
          risksJson: [signal.reasoning.invalidationReason] as any,
        },
      });
      savedSignalId = savedSignal.id;
    }

    signal.id = savedSignalId;
    signal.instrumentId = instrumentId;

    // Publish event over Redis PubSub
    await this.redis.publish(WS_EVENTS.SIGNAL_GENERATED, JSON.stringify(signal));

    // High conviction alert event (Score >= 80)
    if (signal.score >= 80) {
      await this.redis.publish(
        WS_EVENTS.ALERT_TRIGGERED,
        JSON.stringify({
          alertId: `alert-${signal.id}`,
          symbol: sym,
          score: signal.score,
          grade: signal.grade,
          direction: signal.direction,
          summary: signal.reasoning.summary,
          timestamp: new Date().toISOString(),
        }),
      );
    }

    return signal;
  }
}
