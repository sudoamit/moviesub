import { Controller, Get, Post, Delete, Body, Param } from '@nestjs/common';
import { AlgoBotsService, IAlgoBot } from './algo-bots.service';

@Controller('api/algo-bots')
export class AlgoBotsController {
  constructor(private readonly algoBotsService: AlgoBotsService) {}

  @Get()
  async listBots() {
    return this.algoBotsService.listBots();
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
