import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  BULLMQ_QUEUES,
  Direction,
  ICandle,
  REDIS_KEYS,
  SignalGrade,
  Timeframe,
  toPrismaTimeframe,
  WS_EVENTS,
} from '@quant/shared';
import { PrismaService } from '../prisma.service';
import { RedisService } from '../redis.service';
import { SignalGenerator } from '@quant/trading-engine';
import { Decimal } from '@prisma/client/runtime/library';

@Processor(BULLMQ_QUEUES.SIGNAL_GENERATION)
export class ScannerProcessor extends WorkerHost {
  private readonly logger = new Logger(ScannerProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.log(`Starting market scanner execution for job ${job.id}: ${job.name}`);
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
      `Market scan complete in ${duration}ms. Scanned: ${instruments.length} instruments, Generated: ${results.length} valid signals`,
    );

    return summary;
  }

  private async scanInstrument(instrumentId: string, symbol: string) {
    const prisma15m = toPrismaTimeframe('15m');
    const prisma1h = toPrismaTimeframe('1h');
    const prisma4h = toPrismaTimeframe('4h');

    // Fetch multi-timeframe candles
    const [db15m, db1h, db4h] = await Promise.all([
      this.prisma.candle.findMany({
        where: { instrumentId, timeframe: prisma15m },
        orderBy: { timestamp: 'desc' },
        take: 200,
      }),
      this.prisma.candle.findMany({
        where: { instrumentId, timeframe: prisma1h },
        orderBy: { timestamp: 'desc' },
        take: 150,
      }),
      this.prisma.candle.findMany({
        where: { instrumentId, timeframe: prisma4h },
        orderBy: { timestamp: 'desc' },
        take: 100,
      }),
    ]);

    const toCandles = (dbList: any[]): ICandle[] =>
      dbList.reverse().map((c) => ({
        timestamp: c.timestamp,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume),
        isClosed: c.isClosed,
      }));

    const execCandles = toCandles(db15m);
    const htf1Candles = toCandles(db1h);
    const htf2Candles = toCandles(db4h);

    if (execCandles.length < 20) return null;

    const signal = SignalGenerator.generateSignal({
      symbol,
      executionCandles: execCandles,
      executionTimeframe: Timeframe.M15,
      htf1Candles,
      htf1Timeframe: Timeframe.H1,
      htf2Candles,
      htf2Timeframe: Timeframe.H4,
    });

    if (signal.direction === Direction.NEUTRAL || signal.score < 60) {
      return null;
    }

    // Persist signal to PostgreSQL
    const savedSignal = await this.prisma.signal.create({
      data: {
        instrumentId,
        direction: signal.direction as any,
        state: signal.state as any,
        grade: signal.grade as any,
        score: signal.score,
        timeframe: toPrismaTimeframe(signal.timeframe),
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

    signal.id = savedSignal.id;
    signal.instrumentId = instrumentId;

    // Publish event over Redis PubSub
    await this.redis.publish(WS_EVENTS.SIGNAL_GENERATED, JSON.stringify(signal));

    // High conviction alert event (Score >= 80)
    if (signal.score >= 80) {
      await this.redis.publish(
        WS_EVENTS.ALERT_TRIGGERED,
        JSON.stringify({
          alertId: `alert-${signal.id}`,
          symbol,
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
