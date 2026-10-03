import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { safeLeverage } from '@quant/strategy-lab';
import { getAuthoritativeInstrument } from '@quant/shared';
import { PrismaService } from '../common/prisma/prisma.service';

const DAY_MS = 86_400_000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const JOB_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * Automatic strategy discovery: weekly (and on demand) runs the strategy-lab discovery job in a separate
 * process, then registers new validated strategies as SHADOW and refreshes the reference statistics of
 * registered ones. Status changes after that are owned by LabStrategiesService (promotion / retirement).
 */
@Injectable()
export class LabDiscoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LabDiscoveryService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  /** Days between scheduled runs (LAB_DISCOVERY_INTERVAL_DAYS, default 7). */
  private readonly intervalDays = Number(process.env.LAB_DISCOVERY_INTERVAL_DAYS || 7);
  private readonly dataDir = process.env.LAB_DATA_DIR || path.resolve(__dirname, '../../../../data/strategy-lab');

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.LAB_DISCOVERY_ENABLED === 'false') return;
    this.timer = setInterval(() => void this.runIfDue(), CHECK_EVERY_MS);
    setTimeout(() => void this.runIfDue(), 60_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async runIfDue() {
    const last = await this.prisma.labDiscoveryRun.findFirst({ where: { status: 'COMPLETED' }, orderBy: { startedAt: 'desc' } });
    if (last && Date.now() - last.startedAt.getTime() < this.intervalDays * DAY_MS) return;
    await this.run('SCHEDULED').catch((e) => this.logger.warn(`[LAB DISCOVERY] ${e.message}`));
  }

  /** Starts a discovery run in the background; returns its id (or the id of the run already in progress). */
  async start(trigger: 'SCHEDULED' | 'MANUAL'): Promise<{ id: string; status: string }> {
    const active = await this.prisma.labDiscoveryRun.findFirst({ where: { status: 'RUNNING' }, orderBy: { startedAt: 'desc' } });
    if (this.running && active) return { id: active.id, status: 'ALREADY_RUNNING' };
    const run = await this.prisma.labDiscoveryRun.create({ data: { trigger, registered: [] } });
    void this.execute(run.id);
    return { id: run.id, status: 'RUNNING' };
  }

  private async run(trigger: 'SCHEDULED' | 'MANUAL') {
    if (this.running) return;
    const run = await this.prisma.labDiscoveryRun.create({ data: { trigger, registered: [] } });
    await this.execute(run.id);
  }

  private async execute(runId: string): Promise<void> {
    if (this.running) {
      await this.prisma.labDiscoveryRun.update({ where: { id: runId }, data: { status: 'FAILED', finishedAt: new Date(), error: 'another run is in progress' } });
      return;
    }
    this.running = true;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-discovery-'));
    try {
      const existing = await this.prisma.labStrategy.findMany();
      const existingFile = path.join(tmp, 'existing.json');
      const outFile = path.join(tmp, 'result.json');
      fs.writeFileSync(existingFile, JSON.stringify(existing.map((s) => ({ id: s.id, symbol: s.symbol, timeframe: s.timeframe, genome: s.genomeJson }))));
      const job = require.resolve('@quant/strategy-lab/dist/jobs/discovery-job.js');
      this.logger.log(`[LAB DISCOVERY] run ${runId} started`);
      await new Promise<void>((resolve, reject) => {
        execFile(process.execPath, [job, '--data-dir', this.dataDir, '--existing', existingFile, '--out', outFile],
          { timeout: JOB_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
          (err, _stdout, stderr) => (err ? reject(new Error(`${err.message} ${stderr?.slice(-500) ?? ''}`)) : resolve()));
      });
      const result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      const registered = await this.apply(result, existing);
      await this.prisma.labDiscoveryRun.update({
        where: { id: runId },
        data: {
          status: 'COMPLETED', finishedAt: new Date(), registered,
          summaryJson: {
            history: result.history,
            // dataset versions and their TRAIN / VALIDATION / GOLDEN partitions
            datasets: result.datasets,
            // what was searched and how strictly (the best of many tested genomes is selection-biased)
            searchConfig: result.searchConfig,
            runs: result.runs,
            developmentCandidates: result.developmentCandidates,
            goldenEvaluations: result.goldenEvaluations,
            candidates: result.candidates.map((c: any) => ({ id: c.id, path: c.path, datasetVersion: c.datasetVersion, golden: c.golden, reference: c.reference })),
          },
        },
      });
      this.logger.log(`[LAB DISCOVERY] run ${runId} completed: ${registered.length} new strategies`);
    } catch (e: any) {
      await this.prisma.labDiscoveryRun.update({ where: { id: runId }, data: { status: 'FAILED', finishedAt: new Date(), error: String(e.message).slice(0, 2000) } });
      this.logger.warn(`[LAB DISCOVERY] run ${runId} failed: ${e.message}`);
    } finally {
      this.running = false;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Registers new candidates (SHADOW) and refreshes references of existing strategies. Returns new ids. */
  async apply(result: any, existing: Array<{ id: string; backtestJson: any }>): Promise<string[]> {
    const registered: string[] = [];
    for (const c of result.candidates ?? []) {
      if (existing.some((e) => e.id === c.id)) continue;
      let maxLev = 20;
      try {
        const inst = getAuthoritativeInstrument(c.symbol);
        maxLev = inst.marginMode === 'SPOT' ? 1 : Number(inst.maxLeverage ?? 1);
      } catch {
        continue; // not an executable instrument
      }
      const leverage = Math.min(maxLev, safeLeverage(c.reference.medianStopPct));
      await this.prisma.labStrategy.create({
        data: {
          id: c.id, name: `${c.symbol} ${c.timeframe}: ${c.description}`, symbol: c.symbol, timeframe: c.timeframe,
          genomeJson: c.genome, status: 'SHADOW', leverage, riskPercentage: Number(process.env.LAB_RISK_PERCENT || 3),
          // reference = DEVELOPMENT-period statistics; golden = one evaluation on the dataset's golden holdout
          backtestJson: { ...c.reference, discoveryPath: c.path, evidence: c.evidence, datasetVersion: c.datasetVersion, golden: c.golden },
          statusReason: `Auto-discovered (${c.path === 'STRICT' ? 'passed all search tests' : 'confirmed on an unseen sibling market'}, golden holdout passed); shadow trading before promotion`,
        },
      });
      registered.push(c.id);
    }
    for (const r of result.refreshedReferences ?? []) {
      const prev = existing.find((e) => e.id === r.id);
      if (!prev) continue;
      // Keep descriptive fields (confirmation, caveat, evidence); refresh the statistics.
      await this.prisma.labStrategy.update({ where: { id: r.id }, data: { backtestJson: { ...(prev.backtestJson as any), ...r.reference, referenceRefreshedAt: new Date().toISOString() } } });
    }
    return registered;
  }

  async listRuns() {
    return this.prisma.labDiscoveryRun.findMany({ orderBy: { startedAt: 'desc' }, take: 10 });
  }
}
