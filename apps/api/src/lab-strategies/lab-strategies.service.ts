import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  Bar,
  computeFeatures,
  INSTRUMENT_PROFILES,
  InstrumentProfile,
  MAX_COST_TO_RISK,
  qualityFeaturesAt,
  signalAt,
  stopFor,
  StrategyGenome,
  labStrategyVersion,
} from '@quant/strategy-lab';
import { isPerpetualSymbol, PointInTimeCurrencyConverter, roundPrice, Timeframe } from '@quant/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { CandlesService } from '../candles/candles.service';
import { PaperTradingService } from '../paper-trading/paper-trading.service';
import { LabQualityService } from './lab-quality.service';
import {
  advanceTrade,
  assertLiveRunnable,
  assessLabEvidence,
  LIFECYCLE_RULES_VERSION,
  DEFAULT_PROMOTION_RULES,
  BacktestReference,
  CAPITAL_PER_INSTRUMENT,
  compoundedBalance,
  sizeFromCoinBalance,
  drawdownR,
  netR,
  OpenLabTrade,
  zVsBacktest,
} from './lab-lifecycle';

const TF_MS: Record<string, number> = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
/** Far "catastrophe" target for trailing positions (the engine requires a target; the trail does the exiting). */
const CATASTROPHE_TARGET_R = 20;
const TICK_MS = 60_000;
/** Portfolio limits across all lab strategies (shadow and live alike, matching the portfolio backtest). */
export const MAX_OPEN_LAB_TRADES = 6;

/**
 * Runs lab strategies (validated in packages/strategy-lab) on live candles:
 * - SHADOW: virtual trades, managed bar by bar with the backtester's rules;
 * - LIVE: paper orders with a trailing stop (positions marked exitPlan TRAIL; the monitor enforces the stop);
 * - automatic promotion (SHADOW -> LIVE) and retirement (-> RETIRED) via assessLabEvidence (evidence states,
 * promotion records; see lab-lifecycle.ts).
 */
@Injectable()
export class LabStrategiesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LabStrategiesService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly candles: CandlesService,
    private readonly paper: PaperTradingService,
    private readonly quality: LabQualityService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.LAB_STRATEGIES_ENABLED === 'false') return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    setTimeout(() => void this.tick(), 15_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const strategies = await this.prisma.labStrategy.findMany({ where: { status: { in: ['SHADOW', 'LIVE'] } } });
      for (const s of strategies) {
        try {
          await this.runStrategy(s);
        } catch (err: any) {
          this.logger.warn(`[LAB] ${s.id}: ${err.message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private profileFor(symbol: string, timeframe: string): InstrumentProfile {
    const base = INSTRUMENT_PROFILES[symbol];
    if (!base) throw new Error(`no lab profile for ${symbol}`);
    return { ...base, barMs: TF_MS[timeframe] ?? base.barMs };
  }

  /** Closed bars for the strategy's timeframe, oldest first. */
  private async closedBars(symbol: string, timeframe: string): Promise<Bar[]> {
    // 500 bars: enough history for the 200 EMA used by quality features to converge
    const res = await this.candles.getCandles({ symbol, timeframe: timeframe as Timeframe, limit: 500 } as any);
    const tfMs = TF_MS[timeframe];
    const now = Date.now();
    return (res.candles || [])
      .map((c: any) => ({ t: new Date(c.timestamp).getTime(), o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: +(c.volume || 0) }))
      .filter((b) => b.t + tfMs <= now)
      .sort((a, b) => a.t - b.t);
  }

  async runStrategy(s: any): Promise<void> {
    const genome = s.genomeJson as StrategyGenome;
    assertLiveRunnable(genome);
    const profile = this.profileFor(s.symbol, s.timeframe);
    // Strategy version: any change of rules, engine, features, costs or sizing starts a new evidence record
    const version = labStrategyVersion({ symbol: s.symbol, timeframe: s.timeframe, genome, riskPercentage: s.riskPercentage, leverage: s.leverage, profile });
    if (s.strategyVersion !== version.strategyVersion) {
      if (s.strategyVersion) this.logger.warn(`[LAB] ${s.id}: new strategy version ${version.strategyVersion} (was ${s.strategyVersion}); earlier trades are no longer evidence`);
      await this.prisma.labStrategy.update({ where: { id: s.id }, data: { strategyVersion: version.strategyVersion, versionJson: version.components as any } });
      s.strategyVersion = version.strategyVersion;
    }
    const bars = await this.closedBars(s.symbol, s.timeframe);
    if (bars.length < 260) throw new Error(`only ${bars.length} closed ${s.timeframe} bars`);
    const last = bars[bars.length - 1];
    const lastProcessed = s.lastProcessedBarTime ? new Date(s.lastProcessedBarTime).getTime() : 0;
    if (last.t <= lastProcessed) return; // no new closed bar

    const f = computeFeatures(bars, profile);
    const newBars = bars
      .map((bar, i) => ({ bar, atr: f.atr[i] }))
      .filter(({ bar }) => bar.t > lastProcessed);

    // 1. Manage the open trade, if any
    const open = await this.prisma.labStrategyTrade.findFirst({ where: { strategyId: s.id, status: 'OPEN' } });
    let hasOpen = Boolean(open);
    if (open) hasOpen = await this.manageOpenTrade(s, open, genome, profile, newBars.filter(({ bar }) => bar.t > new Date(open.signalBarTime).getTime()));

    // 2. New entry on the last closed bar
    if (!hasOpen && s.status !== 'RETIRED') {
      const side = signalAt(genome, f, bars.length - 1);
      if (side) {
        // Portfolio limits: one lab position per coin (across strategies) and at most MAX_OPEN_LAB_TRADES open.
        const openTrades = await this.prisma.labStrategyTrade.findMany({
          where: { status: 'OPEN' },
          include: { strategy: { select: { symbol: true, backtestJson: true } } },
        });
        // A learned variant in shadow (no money) is compared with its original on the same signals, so the
        // portfolio limits (which exist for money at risk) do not block it.
        const learnedShadow = s.status === 'SHADOW' && Boolean((s.backtestJson as any)?.lessonFrom);
        if (learnedShadow) {
          await this.openTrade(s, genome, profile, bars, f, bars.length - 1, side, last.t);
        } else if (openTrades.some((t) => t.strategy.symbol === s.symbol && !(t as any).strategy?.backtestJson?.lessonFrom)) {
          this.logger.log(`[LAB] ${s.id}: ${side} signal skipped - another lab position is open on ${s.symbol}`);
        } else if (
          isPerpetualSymbol(s.symbol) &&
          // Watch-only trades (non-executable instruments such as NIFTY) do not use the portfolio's slots
          openTrades.filter((t) => isPerpetualSymbol(t.strategy.symbol) && !(t.strategy as any).backtestJson?.lessonFrom).length >= MAX_OPEN_LAB_TRADES
        ) {
          this.logger.log(`[LAB] ${s.id}: ${side} signal skipped - portfolio limit of ${MAX_OPEN_LAB_TRADES} open positions`);
        } else {
          await this.openTrade(s, genome, profile, bars, f, bars.length - 1, side, last.t);
        }
      }
    }

    await this.prisma.labStrategy.update({ where: { id: s.id }, data: { lastProcessedBarTime: new Date(last.t) } });

    // 3. Automatic promotion / retirement
    await this.applyLifecycle(s);
  }

  private toOpen(t: any): OpenLabTrade {
    return {
      side: t.side, entryPrice: t.entryPrice, initialStop: t.initialStop, currentStop: t.currentStop,
      extremeClose: t.extremeClose, barsHeld: t.barsHeld,
    };
  }

  /** Returns true while the trade stays open. */
  private async manageOpenTrade(
    s: any, t: any, genome: StrategyGenome, profile: InstrumentProfile, newBars: Array<{ bar: Bar; atr: number }>,
  ): Promise<boolean> {
    if (t.mode === 'LIVE' && t.paperPositionId) {
      // The monitor owns stop execution for live trades; detect a close it performed.
      const pos = await this.prisma.paperPosition.findUnique({ where: { id: t.paperPositionId } });
      if (!pos || pos.status === 'CLOSED') {
        const trade = await this.prisma.paperTrade.findFirst({ where: { positionId: t.paperPositionId }, orderBy: { exitTime: 'desc' } });
        const exitPrice = trade ? Number(trade.exitPrice) : t.currentStop;
        await this.closeTrade(t, profile, exitPrice, trade?.exitTime ?? new Date(), trade ? 'POSITION_CLOSED' : 'POSITION_MISSING');
        return false;
      }
    }
    const res = advanceTrade(this.toOpen(t), newBars, genome);
    if (res.closed) {
      if (t.mode === 'LIVE' && t.paperPositionId) {
        // Bar-close exit (stop crossed between monitor checks, or holding-time limit): close the paper position.
        const why = res.closed.exitReason === 'TIMEOUT' ? 'Lab strategy time exit' : res.closed.exitReason === 'TARGET' ? 'Lab strategy target' : 'Lab strategy stop';
        await this.paper.closePosition(t.paperPositionId, why);
        return true; // recorded on the next tick from the closed position
      }
      await this.closeTrade(t, profile, res.closed.exitPrice, new Date(res.closed.exitTime), res.closed.exitReason);
      return false;
    }
    await this.prisma.labStrategyTrade.update({
      where: { id: t.id },
      data: { currentStop: res.trade.currentStop, extremeClose: res.trade.extremeClose, barsHeld: res.trade.barsHeld },
    });
    if (t.mode === 'LIVE' && t.paperPositionId && res.trade.currentStop !== t.currentStop) {
      await this.paper.tightenStop(t.paperPositionId, roundPrice(s.symbol, res.trade.currentStop), `lab trail ${s.id}`);
    }
    return true;
  }

  private async closeTrade(t: any, profile: InstrumentProfile, exitPrice: number, exitTime: Date, reason: string) {
    const r = netR(this.toOpen(t), exitPrice, profile);
    await this.prisma.labStrategyTrade.update({
      where: { id: t.id },
      data: { status: 'CLOSED', exitPrice, exitTime, exitReason: reason, netR: r.netR, costR: r.costR },
    });
    this.logger.log(`[LAB] ${t.mode} trade ${t.id} closed (${reason}) at ${exitPrice}: ${r.netR.toFixed(2)}R`);
    this.quality.requestRetrain(`${t.strategyId} trade ${t.id}`);
  }

  private async openTrade(
    s: any, genome: StrategyGenome, profile: InstrumentProfile, bars: Bar[], f: any, i: number, side: 'LONG' | 'SHORT', barTime: number,
  ): Promise<void> {
    const quote = await this.paper.getValidatedMarketPrice(s.symbol, 5);
    const ref = quote.price;
    const stop = roundPrice(s.symbol, stopFor(genome, f, i, side, ref));
    const risk = side === 'LONG' ? ref - stop : stop - ref;
    if (!(risk > 0)) return;
    const worstCost = ref * 2 * (profile.takerFeeRate + profile.slippageRate);
    if (worstCost / risk > MAX_COST_TO_RISK) return;

    // Trade-quality assessment: recorded on every trade; applied (size / skip) only by an ACTIVE model on LIVE.
    const features = qualityFeaturesAt(bars, f, i, side);
    const q = await this.quality.assess(s.id, features, Number((s.backtestJson as any)?.expectancyR ?? 0));
    const qualityData = { featuresJson: features, predictedR: q.predictedR, sizeMultiplier: q.sizeMultiplier, qualityModelId: q.modelId };

    if (s.status === 'LIVE' && q.skip) {
      await this.prisma.labStrategyTrade.create({
        data: {
          strategyId: s.id, strategyVersion: s.strategyVersion ?? null, mode: 'LIVE', side, signalBarTime: new Date(barTime), entryTime: new Date(), entryPrice: ref,
          initialStop: stop, currentStop: stop, extremeClose: ref, status: 'SKIPPED', exitReason: 'SKIPPED_BY_QUALITY_MODEL', ...qualityData,
        },
      });
      this.logger.log(`[LAB] LIVE ${side} ${s.symbol} (${s.id}) skipped by quality model (predicted ${q.predictedR?.toFixed(2)}R)`);
      return;
    }

    let entryPrice = ref;
    let paperPositionId: string | null = null;
    let actualStop = stop;
    if (s.status === 'LIVE') {
      // Each instrument trades its own compounding balance (starting capital + realized P&L of its live trades).
      const balance = await this.coinBalance(s.symbol);
      const fx = PointInTimeCurrencyConverter.getInstance().getRate('USDT', 'INR', Date.now()).fxRate;
      const sizing = sizeFromCoinBalance({
        symbol: s.symbol, side, balance, riskPct: s.riskPercentage, sizeMultiplier: q.sizeMultiplier, entry: ref, stopDistance: risk, fx,
        leverage: s.leverage,
      });
      const qty = sizing.qty;
      if (!(qty > 0)) {
        this.logger.warn(`[LAB] ${s.id}: no size (balance ₹${balance.toFixed(0)}${sizing.rejectionReason ? `: ${sizing.rejectionReason}` : ''}) - signal not traded`);
        return;
      }
      this.logger.log(`[LAB] ${s.symbol} balance ₹${balance.toFixed(0)}: risking ₹${sizing.riskInr} (${s.riskPercentage}%), margin ₹${sizing.marginInr}`);
      const target1 = side === 'LONG' ? ref + CATASTROPHE_TARGET_R * risk : ref - CATASTROPHE_TARGET_R * risk;
      const pos: any = await this.paper.placeOrder({
        symbol: s.symbol,
        direction: side === 'LONG' ? 'BUY' : 'SELL',
        quantity: qty,
        orderType: 'MARKET',
        stopLoss: stop,
        target1: roundPrice(s.symbol, target1),
        leverage: s.leverage,
        exitPlan: 'TRAIL',
        idempotencyKey: `lab:${s.id}:${barTime}`,
        correlationId: `lab:${s.id}:${barTime}`,
      } as any);
      paperPositionId = pos.id;
      entryPrice = Number(pos.entryPrice);
      actualStop = Number(pos.stopLoss ?? stop);
    }
    await this.prisma.labStrategyTrade.create({
      data: {
        strategyId: s.id, strategyVersion: s.strategyVersion ?? null, mode: s.status, side, signalBarTime: new Date(barTime), entryTime: new Date(),
        entryPrice, initialStop: actualStop, currentStop: actualStop, extremeClose: entryPrice, paperPositionId,
        ...qualityData,
      },
    });
    this.logger.log(`[LAB] ${s.status} ${side} ${s.symbol} (${s.id}) at ${entryPrice}, stop ${actualStop}`);
  }

  /** Evidence of the CURRENT strategy version in the current mode (other versions are not evidence). */
  private async currentEvidence(s: any) {
    const closed = await this.prisma.labStrategyTrade.findMany({
      where: { strategyId: s.id, status: 'CLOSED', mode: s.status, strategyVersion: s.strategyVersion ?? undefined },
      orderBy: { exitTime: 'asc' },
    });
    // Data-quality violations: results that are not real bar-close outcomes (lost position, missing result)
    const violations = closed.filter((t) => t.exitReason === 'POSITION_MISSING' || t.netR === null || !Number.isFinite(Number(t.netR))).length;
    const results = closed.filter((t) => t.netR !== null && Number.isFinite(Number(t.netR))).map((t) => Number(t.netR));
    return assessLabEvidence(s.status, s.backtestJson as any, results, violations);
  }

  private async applyLifecycle(s: any): Promise<void> {
    if (s.status !== 'SHADOW' && s.status !== 'LIVE') return;
    const a = await this.currentEvidence(s);
    const persist = { evidenceState: a.state, evidenceJson: a as any };
    if (a.action === 'PROMOTE' && !isPerpetualSymbol(s.symbol)) {
      // The runner executes perpetual futures only (NIFTY is traded through options): such strategies are watched
      // in shadow mode and never placed in the paper account.
      await this.prisma.labStrategy.update({ where: { id: s.id }, data: { ...persist, statusReason: `${a.reason}; stays in SHADOW (watch only): live execution for ${s.symbol} is not available` } });
    } else if (a.action === 'PROMOTE') {
      // Promotion and its evidence record are written together (audit trail of exactly what was relied on)
      await this.prisma.$transaction([
        this.prisma.labPromotionRecord.create({
          data: {
            strategyId: s.id,
            strategyVersion: s.strategyVersion ?? 'unversioned',
            datasetVersion: (s.backtestJson as any)?.datasetVersion ?? (s.backtestJson as any)?.golden?.datasetVersion ?? null,
            lifecycleRulesVersion: LIFECYCLE_RULES_VERSION,
            evidenceJson: { ...a, rules: DEFAULT_PROMOTION_RULES, costModel: s.versionJson?.costModelVersion ?? null } as any,
            reason: a.reason,
          },
        }),
        this.prisma.labStrategy.update({ where: { id: s.id }, data: { ...persist, status: 'LIVE', evidenceState: 'LIVE', promotedAt: new Date(), statusReason: a.reason } }),
      ]);
      this.logger.log(`[LAB] ${s.id} PROMOTED to LIVE: ${a.reason}`);
    } else if (a.action === 'RETIRE') {
      await this.prisma.labStrategy.update({ where: { id: s.id }, data: { ...persist, status: 'RETIRED', retiredAt: new Date(), statusReason: a.reason } });
      this.logger.warn(`[LAB] ${s.id} RETIRED: ${a.reason}`);
    } else {
      await this.prisma.labStrategy.update({ where: { id: s.id }, data: { ...persist, statusReason: a.reason } });
    }
  }

  /** Live balance of an instrument: starting capital + realized net P&L of its closed LIVE lab trades. */
  async coinBalance(symbol: string): Promise<number> {
    const live = await this.prisma.labStrategyTrade.findMany({
      where: { mode: 'LIVE', status: 'CLOSED', paperPositionId: { not: null }, strategy: { symbol } },
      select: { paperPositionId: true },
    });
    const ids = live.map((t) => t.paperPositionId!).filter(Boolean);
    if (!ids.length) return CAPITAL_PER_INSTRUMENT;
    const trades = await this.prisma.paperTrade.findMany({ where: { positionId: { in: ids } }, select: { realizedPnL: true } });
    return CAPITAL_PER_INSTRUMENT + trades.reduce((a, t) => a + Number(t.realizedPnL ?? 0), 0);
  }

  /** Shadow balance of an instrument: starting capital compounded by its closed shadow trades (all its strategies). */
  async coinShadowBalance(symbol: string, riskPct: number): Promise<number> {
    const closed = await this.prisma.labStrategyTrade.findMany({
      where: { mode: 'SHADOW', status: 'CLOSED', strategy: { symbol } },
      orderBy: { exitTime: 'asc' },
      select: { netR: true, sizeMultiplier: true },
    });
    return compoundedBalance(CAPITAL_PER_INSTRUMENT, riskPct, closed.map((t) => ({ netR: Number(t.netR ?? 0), sizeMultiplier: t.sizeMultiplier })));
  }

  async list() {
    const strategies = await this.prisma.labStrategy.findMany({ orderBy: { createdAt: 'asc' }, include: { trades: { orderBy: { entryTime: 'desc' }, take: 50 } } });
    const balances = new Map<string, { start: number; liveBalance: number; shadowBalance: number }>();
    for (const sym of new Set(strategies.filter((x) => x.status !== 'RETIRED').map((x) => x.symbol))) {
      const riskPct = strategies.find((x) => x.symbol === sym && x.status !== 'RETIRED')?.riskPercentage ?? 3;
      balances.set(sym, { start: CAPITAL_PER_INSTRUMENT, liveBalance: await this.coinBalance(sym), shadowBalance: await this.coinShadowBalance(sym, riskPct) });
    }
    return strategies.map((s) => {
      const closed = s.trades.filter((t) => t.status === 'CLOSED');
      // Results that drive the automatic decision: closed trades in the current mode.
      const modeResults = closed.filter((t) => t.mode === s.status && (!s.strategyVersion || t.strategyVersion === s.strategyVersion)).map((t) => Number(t.netR ?? 0));
      return {
        ...s,
        summary: {
          closedTrades: closed.length,
          totalR: closed.reduce((a, t) => a + Number(t.netR ?? 0), 0),
          openTrade: s.trades.find((t) => t.status === 'OPEN') ?? null,
        },
        capital: balances.get(s.symbol) ?? null,
        lifecycle: {
          rules: DEFAULT_PROMOTION_RULES,
          rulesVersion: LIFECYCLE_RULES_VERSION,
          strategyVersion: s.strategyVersion,
          evidenceState: s.evidenceState ?? null,
          evidence: s.evidenceJson ?? null,
          closedInCurrentMode: modeResults.length,
          totalRInCurrentMode: modeResults.reduce((a, b) => a + b, 0),
          drawdownR: drawdownR(modeResults),
        },
      };
    });
  }
}
