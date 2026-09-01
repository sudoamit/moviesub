import { Controller, Get, Param, Query } from '@nestjs/common';
import { AISummaryService } from './ai-summary.service';
import { Timeframe } from '@quant/shared';

@Controller('api/ai')
export class AISummaryController {
  constructor(private readonly aiSummaryService: AISummaryService) {}

  @Get('market-summary/:symbol')
  async getMarketSummary(
    @Param('symbol') symbol: string,
    @Query('timeframe') timeframe: Timeframe = Timeframe.M15,
  ) {
    return this.aiSummaryService.generateSymbolSummary(symbol, timeframe);
  }

  @Get('daily-briefing')
  async getDailyBriefing(
    @Query('timeframe') timeframe: Timeframe = Timeframe.M15,
  ) {
    return this.aiSummaryService.generateDailyBriefing(timeframe);
  }
}
