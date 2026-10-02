import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { predictQuality, qualityDecision, QualityModel, QualityValidation } from '@quant/strategy-lab';
import { PrismaService } from '../common/prisma/prisma.service';

const DAY_MS = 86_400_000;
const RETRAIN_DEBOUNCE_MS = 10 * 60 * 1000;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;

export interface QualityAssessment {
  modelId: string | null;
  active: boolean;
  predictedR: number | null;
  skip: boolean;
  sizeMultiplier: number;
}

/**
 * Trade-quality models for lab strategies: trains them in a separate process (strategy-lab quality job),
 * stores every version, and scores new signals with the latest one. A model only changes trading when its
 * walk-forward validation proved out-of-sample lift (status ACTIVE); otherwise assessments are neutral.
 */
@Injectable()
export class LabQualityService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LabQualityService.name);
  private readonly dataDir = process.env.LAB_DATA_DIR || path.resolve(__dirname, '../../../../data/strategy-lab');
  private timer: NodeJS.Timeout | null = null;
  private retrainTimer: NodeJS.Timeout | null = null;
  private training = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.LAB_QUALITY_ENABLED === 'false') return;
    // Weekly retrain (and a first training on startup when a strategy has no model yet)
    this.timer = setInterval(() => void this.retrainIfDue(), 60 * 60 * 1000);
    setTimeout(() => void this.retrainIfDue(), 90_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.retrainTimer) clearTimeout(this.retrainTimer);
  }

  /** Schedules a retrain shortly (debounced), e.g. after a lab trade closed. */
  requestRetrain(reason: string) {
    if (this.retrainTimer) clearTimeout(this.retrainTimer);
    this.retrainTimer = setTimeout(() => void this.train(`TRADE_CLOSED: ${reason}`).catch((e) => this.logger.warn(e.message)), RETRAIN_DEBOUNCE_MS);
  }

  private async retrainIfDue() {
    const strategies = await this.prisma.labStrategy.findMany({ where: { status: { in: ['SHADOW', 'LIVE'] } } });
    for (const s of strategies) {
      const latest = await this.latest(s.id);
      if (!latest || Date.now() - latest.trainedAt.getTime() > 7 * DAY_MS) {
        await this.train(latest ? 'WEEKLY' : 'INITIAL').catch((e) => this.logger.warn(`[LAB QUALITY] ${e.message}`));
        return; // one run trains all strategies
      }
    }
  }

  async latest(strategyId: string) {
    return this.prisma.labQualityModel.findFirst({ where: { strategyId }, orderBy: { trainedAt: 'desc' } });
  }

  /** Trains models for all SHADOW / LIVE strategies. */
  async train(trigger: string): Promise<number> {
    if (this.training) return 0;
    this.training = true;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-quality-'));
    try {
      const strategies = await this.prisma.labStrategy.findMany({
        where: { status: { in: ['SHADOW', 'LIVE'] } },
        include: { trades: { where: { status: 'CLOSED' } } },
      });
      if (!strategies.length) return 0;
      const input = {
        strategies: strategies.map((s) => ({
          id: s.id, symbol: s.symbol, timeframe: s.timeframe, genome: s.genomeJson,
          closedTrades: s.trades
            .filter((t) => Array.isArray(t.featuresJson) && t.netR !== null)
            .map((t) => ({ t: t.signalBarTime.getTime(), x: t.featuresJson, netR: Number(t.netR) })),
        })),
      };
      const inputFile = path.join(tmp, 'input.json'), outFile = path.join(tmp, 'out.json');
      fs.writeFileSync(inputFile, JSON.stringify(input));
      const job = require.resolve('@quant/strategy-lab/dist/jobs/quality-job.js');
      await new Promise<void>((resolve, reject) =>
        execFile(process.execPath, [job, '--data-dir', this.dataDir, '--input', inputFile, '--out', outFile],
          { timeout: JOB_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
          (err, _o, stderr) => (err ? reject(new Error(`${err.message} ${stderr?.slice(-500) ?? ''}`)) : resolve())),
      );
      const out = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      for (const r of out.results) {
        await this.prisma.labQualityModel.create({
          data: {
            strategyId: r.strategyId, status: r.validation.active ? 'ACTIVE' : 'INACTIVE', trigger,
            examples: r.examples, labExamples: r.labExamples, modelJson: r.model, validationJson: { ...r.validation, markets: r.markets },
          },
        });
        this.logger.log(`[LAB QUALITY] ${r.strategyId}: ${r.validation.active ? 'ACTIVE' : 'INACTIVE'} - ${r.validation.reason}`);
      }
      return out.results.length;
    } finally {
      this.training = false;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Scores a signal with the strategy's latest model. Neutral (1x, no skip) when there is no ACTIVE model. */
  async assess(strategyId: string, features: number[], strategyMeanR: number): Promise<QualityAssessment> {
    const m = await this.latest(strategyId);
    if (!m) return { modelId: null, active: false, predictedR: null, skip: false, sizeMultiplier: 1 };
    const predictedR = predictQuality(m.modelJson as unknown as QualityModel, features);
    const validation = m.validationJson as unknown as QualityValidation;
    const d = qualityDecision(predictedR, strategyMeanR, { active: m.status === 'ACTIVE', skipRuleValidated: Boolean(validation.skipRuleValidated) });
    return { modelId: m.id, active: m.status === 'ACTIVE', predictedR, ...d };
  }
}
