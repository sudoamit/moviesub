import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  Bar,
  IntradayGenome,
  istMinutes,
  itmStrike,
  loadHistory,
  prepareSeries,
  simulateIntraday,
} from '@quant/strategy-lab';
import { Timeframe } from '@quant/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { CandlesService } from '../candles/candles.service';
import { PaperTradingService } from '../paper-trading/paper-trading.service';
import {
  calibrateOptionModel,
  ClosedWatchTrade,
  conditionInsights,
  entryFeatures,
  strategyVerdict,
} from './nifty-lab-learning';

const M15 = 15 * 60_000;
const IST = 5.5 * 3_600_000;
const STUDY_EVERY_MS = 7 * 86_400_000;
const MAX_WATCH = 10;
/** A signal is acted on only while it is fresh (its bar closed at most this long ago). */
const FRESH_MS = 3 * 60_000;

const istDate = (t: number) => new Date(t + IST).toISOString().slice(0, 10);

/**
 * NIFTY intraday lab: forward-tests the study's strategies on live data (WATCH mode: trades are recorded with the
 * real live price of the ITM option, never placed) and learns from each closed trade: the real cost of trading
 * through options, which strategies hold up live, and which entry conditions go with better results.
 */
@Injectable()
export class NiftyLabService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NiftyLabService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private studying = false;
  private readonly dataDir = process.env.LAB_DATA_DIR || path.resolve(__dirname, '../../../../data/strategy-lab');

  constructor(
    private readonly prisma: PrismaService,
    private readonly candles: CandlesService,
    private readonly paper: PaperTradingService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.NIFTY_LAB_ENABLED === 'false') return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    setTimeout(() => void this.studyIfDue(), 30_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private studyFile() {
    return path.join(this.dataDir, 'nifty-study-latest.json');
  }

  private async studyIfDue() {
    try {
      const f = this.studyFile();
      const due = !fs.existsSync(f) || Date.now() - fs.statSync(f).mtimeMs > STUDY_EVERY_MS;
      if (due) await this.runStudy();
    } catch (e: any) {
      this.logger.warn(`[NIFTY LAB] study: ${e.message}`);
    }
  }

  /** Bars for the runner: cached history + today's live candles (closed bars only). */
  private async bars(): Promise<Bar[]> {
    const hist = loadHistory(this.dataDir, 'NIFTY');
    const res = await this.candles.getCandles({ symbol: 'NIFTY', timeframe: Timeframe.M15, limit: 500 } as any);
    const now = Date.now();
    const byT = new Map<number, Bar>();
    for (const b of hist) byT.set(b.t, b);
    for (const c of res.candles || []) {
      const t = new Date(c.timestamp).getTime();
      if (t + M15 <= now) byT.set(t, { t, o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: +(c.volume || 0) });
    }
    return [...byT.values()].sort((a, b) => a.t - b.t);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    const now = Date.now();
    const mins = istMinutes(now);
    const day = new Date(now + IST).getUTCDay();
    if (day === 0 || day === 6 || mins < 9 * 60 + 30 || mins > 15 * 60 + 40) return;
    this.running = true;
    try {
      const strategies = await this.prisma.intradayStrategy.findMany({ where: { status: 'WATCH' } });
      const openTrades = await this.prisma.intradayTrade.findMany({ where: { status: 'OPEN' } });
      if (!strategies.length && !openTrades.length) return;
      const bars = await this.bars();
      const today = istDate(now);
      const s = prepareSeries(bars, M15);
      const session = s.sessions.find((x) => x.date === today);
      if (!session) return; // no live bars today (holiday / feed down)
      for (const st of strategies) {
        try {
          await this.runStrategy(st, s, session, today, now);
        } catch (e: any) {
          this.logger.warn(`[NIFTY LAB] ${st.id}: ${e.message}`);
        }
      }
      // A trade left open past the session (feed gap) is closed at the last known price
      if (mins >= 15 * 60 + 30) {
        for (const t of await this.prisma.intradayTrade.findMany({ where: { status: 'OPEN', date: today } })) {
          const last = session.bars[session.bars.length - 1];
          await this.closeTrade(t, last.c, now, 'EOD_FALLBACK', null, null);
        }
      }
    } catch (e: any) {
      this.logger.warn(`[NIFTY LAB] tick: ${e.message}`);
    } finally {
      this.running = false;
    }
  }

  private async optionPrice(contract: string): Promise<number | null> {
    try {
      const q = await this.paper.getValidatedOptionPrice(contract, 30);
      return q.price > 0 ? q.price : null;
    } catch {
      return null;
    }
  }

  private async runStrategy(st: any, s: ReturnType<typeof prepareSeries>, session: any, today: string, now: number) {
    const [tr] = simulateIntraday(st.genomeJson as IntradayGenome, s, today, `${today}~`);
    const existing = await this.prisma.intradayTrade.findUnique({ where: { strategyId_date: { strategyId: st.id, date: today } } });
    if (!tr) return;
    if (!existing) {
      if (now - tr.entryTime > FRESH_MS) return; // signal from earlier (API was down): not recorded, no real entry price
      const contract = `NIFTY ${itmStrike(tr.entry, tr.side)} ${tr.side > 0 ? 'CE' : 'PE'}`;
      const chain = await this.prisma.marketObservation.findFirst({
        where: { asset: 'NIFTY', kind: 'OPTION_CHAIN', takenAt: { gte: new Date(now - 15 * 60_000) } },
        orderBy: { takenAt: 'desc' },
      });
      const features = entryFeatures({
        side: tr.side,
        minutesFromOpen: istMinutes(tr.entryTime) - (9 * 60 + 15),
        gapPct: session.gap,
        isExpiry: session.isExpiry,
        chain: (chain?.metrics as any) ?? null,
      });
      await this.prisma.intradayTrade.create({
        data: {
          strategyId: st.id,
          date: today,
          side: tr.side,
          signalTime: new Date(tr.entryTime),
          indexEntry: tr.entry,
          indexStop: tr.stop,
          indexTarget: tr.target,
          optionContract: contract,
          optionEntry: await this.optionPrice(contract),
          featuresJson: features,
        },
      });
      this.logger.log(`[NIFTY LAB] WATCH ${tr.side > 0 ? 'LONG' : 'SHORT'} ${st.name}: NIFTY ${tr.entry} via ${contract}`);
      return;
    }
    if (existing.status === 'OPEN' && tr.exitReason !== 'OPEN') {
      const fresh = now - tr.exitTime <= FRESH_MS;
      await this.closeTrade(existing, tr.exit, tr.exitTime, tr.exitReason, fresh ? await this.optionPrice(existing.optionContract) : null, tr.pnl.ITM_OPTION);
    }
  }

  private async closeTrade(t: any, indexExit: number, exitTime: number, reason: string, optionExit: number | null, modelPoints: number | null) {
    const indexPoints = t.side * (indexExit - t.indexEntry);
    const hours = Math.max(0.25, (exitTime - new Date(t.signalTime).getTime()) / 3_600_000);
    await this.prisma.intradayTrade.update({
      where: { id: t.id },
      data: {
        status: 'CLOSED',
        exitTime: new Date(exitTime),
        indexExit,
        exitReason: reason,
        indexPoints,
        optionExit,
        optionPoints: optionExit !== null && t.optionEntry !== null ? optionExit - t.optionEntry : null,
        modelPoints: modelPoints ?? 0.8 * indexPoints - 1.5 * hours - 4,
      },
    });
    this.logger.log(`[NIFTY LAB] closed ${t.optionContract} (${reason}): NIFTY ${indexPoints.toFixed(1)} pts, option ${optionExit !== null && t.optionEntry !== null ? (optionExit - t.optionEntry).toFixed(1) : 'n/a'} pts`);
    await this.review(t.strategyId);
  }

  private async closedTrades(where: any = {}): Promise<ClosedWatchTrade[]> {
    const rows = await this.prisma.intradayTrade.findMany({ where: { status: 'CLOSED', ...where }, orderBy: { exitTime: 'asc' } });
    return rows.map((r) => ({
      strategyId: r.strategyId,
      side: r.side,
      indexPoints: r.indexPoints ?? 0,
      hours: r.exitTime ? (r.exitTime.getTime() - r.signalTime.getTime()) / 3_600_000 : 0,
      optionPoints: r.optionPoints,
      modelPoints: r.modelPoints,
      features: (r.featuresJson as any) ?? null,
    }));
  }

  /** Applies the live verdict to a strategy (retire a strategy that is clearly losing on real trades). */
  private async review(strategyId: string) {
    const v = strategyVerdict(await this.closedTrades({ strategyId }));
    if (v.verdict === 'RETIRE') {
      await this.prisma.intradayStrategy.update({ where: { id: strategyId }, data: { status: 'RETIRED', retiredAt: new Date(), statusReason: v.reason } });
      this.logger.warn(`[NIFTY LAB] ${strategyId} RETIRED: ${v.reason}`);
    } else {
      await this.prisma.intradayStrategy.update({ where: { id: strategyId }, data: { statusReason: v.reason } });
    }
  }

  /** Runs the study (separate process, priced with the learned option model when available) and registers candidates. */
  async runStudy(): Promise<{ registered: string[]; passed: number; watchCandidates: number; optionModel: unknown }> {
    if (this.studying) throw new Error('a study is already running');
    this.studying = true;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nifty-study-'));
    try {
      const fit = calibrateOptionModel(await this.closedTrades());
      const outFile = path.join(tmp, 'out.json');
      const job = require.resolve('@quant/strategy-lab/dist/jobs/nifty-study-job.js');
      const args = [job, '--data-dir', this.dataDir, '--out', outFile];
      if (fit) args.push('--model', JSON.stringify({ delta: fit.delta, thetaPerHour: fit.thetaPerHour, cost: fit.cost }));
      await new Promise<void>((resolve, reject) =>
        execFile(process.execPath, args, { timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 }, (err, _o, stderr) =>
          err ? reject(new Error(`${err.message} ${stderr?.slice(-300) ?? ''}`)) : resolve(),
        ),
      );
      const { result } = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      fs.writeFileSync(this.studyFile(), JSON.stringify({ ranAt: new Date().toISOString(), result }));
      const registered: string[] = [];
      const active = await this.prisma.intradayStrategy.count({ where: { status: 'WATCH' } });
      let slots = MAX_WATCH - active;
      for (const c of [...result.passed, ...result.watchCandidates]) {
        const exists = await this.prisma.intradayStrategy.findUnique({ where: { id: c.id } });
        const studyJson = { full: c.full, search: c.search, holdOut: c.holdOut, passed: c.passed, optionModel: result.optionModel, studiedAt: new Date().toISOString() };
        if (exists) {
          await this.prisma.intradayStrategy.update({ where: { id: c.id }, data: { studyJson } });
          continue;
        }
        if (slots <= 0) continue;
        await this.prisma.intradayStrategy.create({
          data: {
            id: c.id,
            name: c.description,
            genomeJson: c.genome,
            studyJson,
            statusReason: c.passed ? 'passed the study; watching live' : 'best unproven study candidate; watching live (no money)',
          },
        });
        registered.push(c.id);
        slots--;
      }
      this.logger.log(`[NIFTY LAB] study: ${result.passed.length} passed, ${registered.length} new watch strategies`);
      return { registered, passed: result.passed.length, watchCandidates: result.watchCandidates.length, optionModel: result.optionModel };
    } finally {
      this.studying = false;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async summary() {
    const strategies = await this.prisma.intradayStrategy.findMany({ orderBy: { createdAt: 'asc' }, include: { trades: { orderBy: { signalTime: 'desc' }, take: 20 } } });
    const closed = await this.closedTrades();
    const latest = fs.existsSync(this.studyFile()) ? JSON.parse(fs.readFileSync(this.studyFile(), 'utf8')) : null;
    return {
      lastStudy: latest ? { ranAt: latest.ranAt, sessions: latest.result.sessions, from: latest.result.from, to: latest.result.to, tested: latest.result.tested, passed: latest.result.passed.length, optionModel: latest.result.optionModel } : null,
      optionModel: { assumed: { delta: 0.8, thetaPerHour: 1.5, cost: 4 }, learned: calibrateOptionModel(closed) },
      conditions: conditionInsights(closed),
      strategies: strategies.map((st) => ({
        id: st.id,
        name: st.name,
        status: st.status,
        statusReason: st.statusReason,
        study: st.studyJson,
        live: strategyVerdict(closed.filter((c) => c.strategyId === st.id)),
        trades: st.trades,
      })),
    };
  }
}
