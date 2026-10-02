import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as path from 'path';
import {
  aggregateBars,
  backtestGenome,
  Bar,
  computeFeatures,
  describeIntraday,
  fixIntradayGenome,
  fixLabGenome,
  INSTRUMENT_PROFILES,
  IntradayGenome,
  intradayGenomeId,
  intradayStats,
  judgeFix,
  loadHistory,
  MISTAKE_TEXT,
  Mistake,
  prepareSeries,
  QUALITY_FEATURES,
  referenceStats,
  repeatedMistakes,
  reviewTrade,
  simulateIntraday,
  StrategyGenome,
  strategyId as labStrategyId,
  TradeReview as Review,
} from '@quant/strategy-lab';
import { Timeframe } from '@quant/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { CandlesService } from '../candles/candles.service';

const HOUR = 3_600_000;
const IST = 5.5 * HOUR;
const TF_MS: Record<string, number> = { '15m': 900_000, '1h': HOUR, '4h': 4 * HOUR };
const FACTOR: Record<string, number> = { '15m': 1, '1h': 4, '4h': 16 };
/** Bars after the exit that the review waits for (crypto lab trades). */
const REVIEW_HORIZON_BARS = 24;

const ema = (x: number[], p: number) => {
  const k = 2 / (p + 1);
  const o: number[] = [];
  x.forEach((v, i) => (o[i] = i ? v * k + o[i - 1] * (1 - k) : v));
  return o;
};
const atrSeries = (b: Bar[]) => {
  const o: number[] = [];
  let a = 0;
  b.forEach((x, i) => {
    const tr = i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : x.h - x.l;
    a = i < 14 ? (a * i + tr) / (i + 1) : (a * 13 + tr) / 14;
    o.push(a);
  });
  return o;
};

/**
 * Learning from mistakes, the disciplined way:
 * 1. every closed trade is reviewed once the market has shown what came next (losses get mistake labels);
 * 2. only a mistake that keeps repeating in a strategy's losses becomes a lesson;
 * 3. the lesson's fix (a rule change) is tested on the strategy's full history - most "mistakes" turn out to be
 *    bad luck, and then nothing changes;
 * 4. a fix that history confirms is tried live as a new shadow / watch variant next to the original, and the
 *    existing live verdicts (promotion / retirement) decide which one survives.
 */
@Injectable()
export class MistakeLearningService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MistakeLearningService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly dataDir = process.env.LAB_DATA_DIR || path.resolve(__dirname, '../../../../data/strategy-lab');

  constructor(
    private readonly prisma: PrismaService,
    private readonly candles: CandlesService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.MISTAKE_LEARNING_ENABLED === 'false') return;
    this.timer = setInterval(() => void this.run(), HOUR);
    setTimeout(() => void this.run(), 60_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async run(): Promise<{ reviewed: number; lessons: number }> {
    if (this.running) return { reviewed: 0, lessons: 0 };
    this.running = true;
    let reviewed = 0, lessons = 0;
    try {
      const touched = new Set<string>();
      for (const r of await this.reviewLabTrades()) { reviewed++; touched.add(`LAB|${r}`); }
      for (const r of await this.reviewNiftyTrades()) { reviewed++; touched.add(`NIFTY|${r}`); }
      for (const key of touched) {
        const [kind, id] = key.split('|');
        lessons += await this.learn(kind as 'LAB' | 'NIFTY', id);
      }
    } catch (e: any) {
      this.logger.warn(`[LESSONS] ${e.message}`);
    } finally {
      this.running = false;
    }
    return { reviewed, lessons };
  }

  private async reviewedIds(): Promise<Set<string>> {
    return new Set((await this.prisma.tradeReview.findMany({ select: { tradeId: true } })).map((r) => r.tradeId));
  }

  private async saveReview(kind: string, tradeId: string, strategyId: string, r: Review) {
    await this.prisma.tradeReview.create({
      data: { kind, tradeId, strategyId, outcome: r.outcome, resultR: r.resultR, maxFavourableR: r.maxFavourableR, mistakes: r.mistakes },
    });
    if (r.mistakes.length) this.logger.log(`[LESSONS] ${kind} ${strategyId}: loss ${r.resultR.toFixed(2)}R - ${r.mistakes.map((m) => MISTAKE_TEXT[m as Mistake]).join('; ')}`);
  }

  /** Crypto lab trades, reviewed REVIEW_HORIZON_BARS bars after the exit. Returns the strategies reviewed. */
  async reviewLabTrades(): Promise<string[]> {
    const done = await this.reviewedIds();
    const trades = await this.prisma.labStrategyTrade.findMany({ where: { status: 'CLOSED' }, include: { strategy: true } });
    const out: string[] = [];
    for (const t of trades.filter((x) => !done.has(x.id) && x.exitTime && x.exitPrice !== null)) {
      const st: any = t.strategy;
      const barMs = TF_MS[st.timeframe];
      if (!barMs || Date.now() < t.exitTime!.getTime() + REVIEW_HORIZON_BARS * barMs) continue;
      const res = await this.candles.getCandles({ symbol: st.symbol, timeframe: st.timeframe as Timeframe, limit: 500 } as any);
      const bars: Bar[] = (res.candles || [])
        .map((c: any) => ({ t: new Date(c.timestamp).getTime(), o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: +(c.volume || 0) }))
        .filter((b: Bar) => b.t + barMs <= Date.now())
        .sort((a: Bar, b: Bar) => a.t - b.t);
      const signalT = t.signalBarTime.getTime();
      const si = bars.findIndex((b) => b.t === signalT);
      if (si < 20) continue; // trade older than the candles available: cannot be reviewed
      const exitT = t.exitTime!.getTime();
      const during = bars.filter((b) => b.t > signalT && b.t <= exitT);
      const after = bars.filter((b) => b.t > exitT).slice(0, REVIEW_HORIZON_BARS);
      const g = st.genomeJson as StrategyGenome;
      const side = t.side === 'LONG' ? 1 : -1;
      const risk = Math.abs(t.entryPrice - t.initialStop);
      const e20 = ema(bars.map((b) => b.c), 20), atr = atrSeries(bars);
      const feats: number[] = Array.isArray(t.featuresJson) ? (t.featuresJson as number[]) : [];
      const fi = (name: string) => feats[(QUALITY_FEATURES as readonly string[]).indexOf(name)];
      const htf = fi('htfTrendAligned');
      const review = reviewTrade({
        side,
        entry: t.entryPrice,
        stop: t.initialStop,
        exit: t.exitPrice!,
        exitReason: t.exitReason === 'TARGET' ? 'TARGET' : t.exitReason === 'STOP' || t.exitReason === 'POSITION_CLOSED' ? 'STOP' : String(t.exitReason),
        target: g.exit !== 'TRAIL' && g.rewardRisk > 0 ? t.entryPrice + side * g.rewardRisk * risk : null,
        during,
        after,
        context: {
          emaDistanceAtr: atr[si] > 0 ? (bars[si].c - e20[si]) / atr[si] : 0,
          bigTrend: Number.isFinite(htf) ? (htf > 0 ? side : htf < 0 ? -side : 0) : undefined,
          highVolatility: Number.isFinite(fi('volatilityPercentile')) ? fi('volatilityPercentile') > 0.8 : false,
        },
      });
      await this.saveReview('LAB', t.id, t.strategyId, review);
      out.push(t.strategyId);
    }
    return [...new Set(out)];
  }

  /** NIFTY watch trades, reviewed after the session (the rest of the session shows what came next). */
  async reviewNiftyTrades(): Promise<string[]> {
    const done = await this.reviewedIds();
    const today = new Date(Date.now() + IST).toISOString().slice(0, 10);
    const istMins = (() => { const d = new Date(Date.now() + IST); return d.getUTCHours() * 60 + d.getUTCMinutes(); })();
    const trades = (await this.prisma.intradayTrade.findMany({ where: { status: 'CLOSED' }, include: { strategy: true } }))
      .filter((t) => !done.has(t.id) && (t.date < today || istMins >= 15 * 60 + 35));
    if (!trades.length) return [];
    const s = prepareSeries(await this.niftyBars(), 900_000);
    const out: string[] = [];
    for (const t of trades) {
      const ses = s.sessions.find((x) => x.date === t.date);
      if (!ses || t.indexExit === null || !t.exitTime) continue;
      const entryClose = t.signalTime.getTime();
      const j = ses.bars.findIndex((b) => b.t + 900_000 === entryClose);
      if (j < 0) continue;
      const i = ses.offset + j;
      const exitT = t.exitTime.getTime();
      const review = reviewTrade({
        side: t.side > 0 ? 1 : -1,
        entry: t.indexEntry,
        stop: t.indexStop,
        exit: t.indexExit,
        exitReason: t.exitReason ?? 'EOD',
        target: t.indexTarget,
        during: ses.bars.filter((b) => b.t + 900_000 > entryClose && b.t < exitT),
        after: ses.bars.filter((b) => b.t >= exitT),
        context: {
          emaDistanceAtr: s.atr[i] > 0 ? (t.indexEntry - s.ema21[i]) / s.atr[i] : 0,
          bigTrend: ses.dailyTrend,
          isExpiry: ses.isExpiry,
        },
      });
      await this.saveReview('NIFTY', t.id, t.strategyId, review);
      out.push(t.strategyId);
    }
    return [...new Set(out)];
  }

  private async niftyBars(): Promise<Bar[]> {
    const byT = new Map<number, Bar>();
    for (const b of loadHistory(this.dataDir, 'NIFTY')) byT.set(b.t, b);
    try {
      const res = await this.candles.getCandles({ symbol: 'NIFTY', timeframe: Timeframe.M15, limit: 500 } as any);
      for (const c of res.candles || []) {
        const t = new Date(c.timestamp).getTime();
        if (t + 900_000 <= Date.now()) byT.set(t, { t, o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: 0 });
      }
    } catch {
      // history alone
    }
    return [...byT.values()].sort((a, b) => a.t - b.t);
  }

  /** Turns repeated mistakes of a strategy into lessons. Returns the number of new lessons. */
  async learn(kind: 'LAB' | 'NIFTY', strategyId: string): Promise<number> {
    const rows = await this.prisma.tradeReview.findMany({ where: { kind, strategyId } });
    const reviews: Review[] = rows.map((r) => ({ outcome: r.outcome as 'WIN' | 'LOSS', resultR: r.resultR, maxFavourableR: r.maxFavourableR, mistakes: r.mistakes as Mistake[] }));
    let n = 0;
    for (const rep of repeatedMistakes(reviews)) {
      const exists = await this.prisma.tradeLesson.findUnique({ where: { kind_strategyId_mistake: { kind, strategyId, mistake: rep.mistake } } });
      if (exists) continue;
      const lesson = kind === 'LAB' ? await this.labLesson(strategyId, rep.mistake) : await this.niftyLesson(strategyId, rep.mistake);
      if (!lesson) continue;
      await this.prisma.tradeLesson.create({
        data: {
          kind,
          strategyId,
          mistake: rep.mistake,
          evidenceJson: { count: rep.count, losses: rep.losses, share: rep.share },
          ...lesson,
        },
      });
      this.logger.log(`[LESSONS] ${kind} ${strategyId}: "${MISTAKE_TEXT[rep.mistake]}" (${rep.count} of ${rep.losses} losses) -> ${lesson.status}: ${lesson.reason}`);
      n++;
    }
    return n;
  }

  private async labLesson(strategyId: string, mistake: Mistake) {
    const st = await this.prisma.labStrategy.findUnique({ where: { id: strategyId } });
    if (!st) return null;
    const g = st.genomeJson as unknown as StrategyGenome;
    const fix = fixLabGenome(g, mistake);
    if (!fix) return { status: 'NO_FIX_AVAILABLE', reason: 'the strategy rules cannot express a fix for this mistake' };
    const bars15 = loadHistory(this.dataDir, st.symbol);
    const base = INSTRUMENT_PROFILES[st.symbol];
    if (!bars15.length || !base) return { status: 'NO_FIX_AVAILABLE', reason: `no history to test a fix for ${st.symbol}` };
    const factor = FACTOR[st.timeframe] ?? 1;
    const bars = factor > 1 ? aggregateBars(bars15, factor, base.barMs) : bars15;
    const profile = { ...base, barMs: base.barMs * factor };
    const f = computeFeatures(bars, profile);
    const test = judgeFix(backtestGenome(g, bars, f, profile).map((t) => t.netR), backtestGenome(fix.genome, bars, f, profile).map((t) => t.netR));
    let childStrategyId: string | null = null;
    if (test.adopt) {
      childStrategyId = labStrategyId(st.symbol, st.timeframe, fix.genome);
      if (!(await this.prisma.labStrategy.findUnique({ where: { id: childStrategyId } }))) {
        await this.prisma.labStrategy.create({
          data: {
            id: childStrategyId,
            name: `${st.name} [learned: ${fix.description}]`,
            symbol: st.symbol,
            timeframe: st.timeframe,
            genomeJson: fix.genome as any,
            status: 'SHADOW',
            leverage: st.leverage,
            riskPercentage: st.riskPercentage,
            backtestJson: { ...referenceStats(fix.genome, bars15, st.symbol, st.timeframe as any), lessonFrom: st.id, mistake } as any,
            statusReason: `Learned from repeated mistake "${MISTAKE_TEXT[mistake]}" of ${st.id}; shadow trading next to the original`,
          },
        });
      }
    }
    return {
      fixDescription: fix.description,
      fixGenomeJson: fix.genome as any,
      testJson: test as any,
      status: test.adopt ? 'ADOPTED' : 'REJECTED_BY_HISTORY',
      reason: test.reason,
      childStrategyId,
    };
  }

  private async niftyLesson(strategyId: string, mistake: Mistake) {
    const st = await this.prisma.intradayStrategy.findUnique({ where: { id: strategyId } });
    if (!st) return null;
    const g = st.genomeJson as unknown as IntradayGenome;
    const fix = fixIntradayGenome(g, mistake);
    if (!fix) return { status: 'NO_FIX_AVAILABLE', reason: 'the strategy rules cannot express a fix for this mistake' };
    const s = prepareSeries(loadHistory(this.dataDir, 'NIFTY'), 900_000);
    const parentTr = simulateIntraday(g, s), fixTr = simulateIntraday(fix.genome, s);
    const test = judgeFix(parentTr.map((t) => t.pnl.ITM_OPTION), fixTr.map((t) => t.pnl.ITM_OPTION));
    let childStrategyId: string | null = null;
    if (test.adopt) {
      childStrategyId = intradayGenomeId(fix.genome);
      if (!(await this.prisma.intradayStrategy.findUnique({ where: { id: childStrategyId } }))) {
        await this.prisma.intradayStrategy.create({
          data: {
            id: childStrategyId,
            name: `${describeIntraday(fix.genome)} [learned: ${fix.description}]`,
            genomeJson: fix.genome as any,
            studyJson: { full: intradayStats(fixTr, 'ITM_OPTION'), lessonFrom: st.id, mistake } as any,
            statusReason: `Learned from repeated mistake "${MISTAKE_TEXT[mistake]}" of ${st.name}; watching live next to the original`,
          },
        });
      }
    }
    return {
      fixDescription: fix.description,
      fixGenomeJson: fix.genome as any,
      testJson: test as any,
      status: test.adopt ? 'ADOPTED' : 'REJECTED_BY_HISTORY',
      reason: test.reason,
      childStrategyId,
    };
  }

  async summary() {
    const reviews = await this.prisma.tradeReview.findMany();
    const counts: Record<string, number> = {};
    for (const r of reviews) for (const m of r.mistakes) counts[m] = (counts[m] ?? 0) + 1;
    return {
      reviewed: reviews.length,
      losses: reviews.filter((r) => r.outcome === 'LOSS').length,
      mistakes: Object.entries(counts)
        .map(([mistake, count]) => ({ mistake, text: MISTAKE_TEXT[mistake as Mistake], count }))
        .sort((a, b) => b.count - a.count),
      lessons: await this.prisma.tradeLesson.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
    };
  }
}
