import { Controller, Get, Post } from '@nestjs/common';
import { MistakeLearningService } from './mistake-learning.service';

@Controller('api/lessons')
export class MistakeLearningController {
  constructor(private readonly lessons: MistakeLearningService) {}

  /** Trade reviews, the most common mistakes and the lessons drawn from repeated ones. */
  @Get()
  async summary() {
    return this.lessons.summary();
  }

  /** Reviews newly closed trades and draws lessons now (normally hourly). */
  @Post('run')
  async run() {
    return this.lessons.run();
  }
}
