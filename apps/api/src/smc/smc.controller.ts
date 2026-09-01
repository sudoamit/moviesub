import { Controller, Get, Query } from '@nestjs/common';
import { SMCService } from './smc.service';
import { Timeframe } from '@quant/shared';

@Controller('api')
export class SMCController {
  constructor(private readonly smcService: SMCService) {}

  @Get('smc/analysis')
  async getFullAnalysis(
    @Query('symbol') symbol: string,
    @Query('timeframe') timeframe: Timeframe = Timeframe.M15,
  ) {
    return this.smcService.getSMCAnalysis(symbol, timeframe);
  }

  @Get('market-structure')
  async getMarketStructure(
    @Query('symbol') symbol: string,
    @Query('timeframe') timeframe: Timeframe = Timeframe.M15,
  ) {
    return this.smcService.getMarketStructure(symbol, timeframe);
  }

  @Get('liquidity')
  async getLiquidity(
    @Query('symbol') symbol: string,
    @Query('timeframe') timeframe: Timeframe = Timeframe.M15,
  ) {
    return this.smcService.getLiquidity(symbol, timeframe);
  }

  @Get('fvg')
  async getFairValueGaps(
    @Query('symbol') symbol: string,
    @Query('timeframe') timeframe: Timeframe = Timeframe.M15,
  ) {
    return this.smcService.getFairValueGaps(symbol, timeframe);
  }

  @Get('order-blocks')
  async getOrderBlocks(
    @Query('symbol') symbol: string,
    @Query('timeframe') timeframe: Timeframe = Timeframe.M15,
  ) {
    return this.smcService.getOrderBlocks(symbol, timeframe);
  }

  @Get('market-regime')
  async getMarketRegime(
    @Query('symbol') symbol: string,
    @Query('timeframe') timeframe: Timeframe = Timeframe.M15,
  ) {
    return this.smcService.getMarketRegime(symbol, timeframe);
  }
}
