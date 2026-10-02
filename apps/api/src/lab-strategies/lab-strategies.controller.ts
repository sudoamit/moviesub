import { Controller, Get, Post } from '@nestjs/common';
import { LabStrategiesService } from './lab-strategies.service';
import { LabDiscoveryService } from './lab-discovery.service';
import { LabQualityService } from './lab-quality.service';
import { PrismaService } from '../common/prisma/prisma.service';

@Controller('api/lab/strategies')
export class LabStrategiesController {
  constructor(private readonly lab: LabStrategiesService) {}

  /** Lab strategies with status (SHADOW / LIVE / RETIRED), recent trades and a summary. */
  @Get()
  async list() {
    return this.lab.list();
  }

  /** Runs one evaluation pass now (normally every minute; work happens only when a new bar has closed). */
  @Post('tick')
  async tick() {
    await this.lab.tick();
    return this.lab.list();
  }
}

@Controller('api/lab/discovery')
export class LabDiscoveryController {
  constructor(private readonly discovery: LabDiscoveryService) {}

  /** Recent discovery runs (scheduled weekly; status, newly registered strategies, per-market search summary). */
  @Get('runs')
  async runs() {
    return this.discovery.listRuns();
  }

  /** Starts a discovery run now in a background process (takes several minutes). */
  @Post('run')
  async run() {
    return this.discovery.start('MANUAL');
  }
}

@Controller('api/lab/quality')
export class LabQualityController {
  constructor(private readonly quality: LabQualityService, private readonly prisma: PrismaService) {}

  /** Latest trade-quality model per strategy (status ACTIVE / INACTIVE and its out-of-sample validation). */
  @Get()
  async latest() {
    const strategies = await this.prisma.labStrategy.findMany({ select: { id: true } });
    const models = await Promise.all(strategies.map((s) => this.quality.latest(s.id)));
    return models.filter(Boolean).map((m: any) => ({ id: m.id, strategyId: m.strategyId, status: m.status, trigger: m.trigger, trainedAt: m.trainedAt, examples: m.examples, labExamples: m.labExamples, validation: m.validationJson }));
  }

  /** Retrains all models now (separate process; takes about a minute). */
  @Post('train')
  async train() {
    const n = await this.quality.train('MANUAL');
    return { trained: n, models: await this.latest() };
  }
}
