import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { AILearningService, PredictTradeDto } from './ai-learning.service';

@Controller('api/ai-learning')
export class AILearningController {
  constructor(private readonly aiLearningService: AILearningService) {}

  /**
   * 1. GET /api/ai-learning/model-state
   * Returns active model version, schema version, trained timestamp, metrics, and calibration.
   */
  @Get('model-state')
  async getModelState() {
    return this.aiLearningService.getModelState();
  }

  /**
   * 2. POST /api/ai-learning/retrain
   * Starts a non-blocking background training job.
   */
  @Post('retrain')
  startRetrainJob() {
    return this.aiLearningService.startRetrainJob();
  }

  /**
   * 3. GET /api/ai-learning/retrain/:jobId
   * Returns status, progress percent, stage, and candidate metrics of a training job.
   */
  @Get('retrain/:jobId')
  getRetrainJobStatus(@Param('jobId') jobId: string) {
    return this.aiLearningService.getRetrainJobStatus(jobId);
  }

  /**
   * 4. POST /api/ai-learning/predict
   * Evaluates a trade setup using genuine trading engine features.
   */
  @Post('predict')
  async predictTrade(@Body() dto: PredictTradeDto) {
    return this.aiLearningService.predictTrade(dto);
  }

  /**
   * 5. GET /api/ai-learning/insights
   * Returns feature importance, regime breakdowns, asset performance, and post-mortems.
   */
  @Get('insights')
  async getInsights() {
    return this.aiLearningService.getInsights();
  }
}
