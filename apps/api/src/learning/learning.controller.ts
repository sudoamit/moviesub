import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { LearningService } from './learning.service';

@Controller('api/learning')
export class LearningController {
  constructor(private readonly learningService: LearningService) {}

  @Get('overview')
  async getSystemOverview() {
    return this.learningService.getSystemOverview();
  }

  @Get('experiences')
  async getExperiences(@Query('limit') limit?: string, @Query('symbol') symbol?: string) {
    return this.learningService.getExperiences(limit ? parseInt(limit, 10) : 50, symbol);
  }

  @Get('errors')
  async getErrorReport() {
    return this.learningService.getErrorReport();
  }

  @Get('patterns')
  async getPatterns() {
    return this.learningService.getPatterns();
  }

  @Get('candidates')
  async getCandidates() {
    return this.learningService.getCandidates();
  }

  @Post('run-cycle')
  async runLearningCycle(@Body() body: { autoPromote?: boolean }) {
    return this.learningService.triggerLearningCycle(body?.autoPromote ?? false);
  }

  @Post('candidates/:id/promote')
  async promoteCandidate(@Param('id') id: string) {
    return this.learningService.promoteCandidate(id);
  }

  @Post('rollback')
  async rollback(@Body() body: { targetVersion?: string }) {
    return this.learningService.rollback(body?.targetVersion);
  }
}
