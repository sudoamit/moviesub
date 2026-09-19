import { Controller, Get, Post, Delete, Body, Param, Query } from '@nestjs/common';
import { AlgoBotsService, IAlgoBot } from './algo-bots.service';

@Controller('api/algo-bots')
export class AlgoBotsController {
  constructor(private readonly algoBotsService: AlgoBotsService) {}

  @Get()
  async listBots() {
    return this.algoBotsService.listBots();
  }

  @Get('executions')
  async listExecutions(@Query('limit') limit?: number) {
    return this.algoBotsService.listExecutions(limit);
  }

  @Get('health')
  async getHealth() {
    return this.algoBotsService.getAlgoExecutionHealth();
  }

  @Get(':id/diagnostics')
  async getBotDiagnostics(@Param('id') id: string) {
    return this.algoBotsService.getBotDiagnostics(id);
  }

  @Post()
  async createBot(@Body() body: Partial<IAlgoBot>) {
    return this.algoBotsService.createBot(body);
  }

  @Post(':id/toggle')
  async toggleBot(@Param('id') id: string) {
    return this.algoBotsService.toggleBot(id);
  }

  @Delete(':id')
  async deleteBot(@Param('id') id: string) {
    return this.algoBotsService.deleteBot(id);
  }
}
