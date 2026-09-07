import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ResearchService } from './research.service';

@Controller('api/research')
export class ResearchController {
  constructor(private readonly researchService: ResearchService) {}

  @Get('scorecard')
  async getScorecard() {
    return this.researchService.getScorecard();
  }

  @Get('hypotheses')
  async getHypotheses() {
    return this.researchService.getHypotheses();
  }

  @Get('experiments')
  async getExperiments() {
    return this.researchService.getExperiments();
  }

  @Post('run-experiment')
  async runExperiment(
    @Body()
    body: {
      hypothesisId?: string;
      symbol?: string;
      timeframe?: string;
      rulesDefinition?: any;
    },
  ) {
    return this.researchService.runExperiment(body);
  }

  @Get('knowledge-graph')
  async getKnowledgeGraph() {
    return this.researchService.getKnowledgeGraph();
  }

  @Post('ablation')
  async runAblation(@Body() body: { symbol?: string; timeframe?: string }) {
    return this.researchService.runAblation(body?.symbol || 'NIFTY', body?.timeframe || '15m');
  }

  @Get('counterfactuals')
  async getCounterfactuals() {
    return this.researchService.getCounterfactuals();
  }
}
