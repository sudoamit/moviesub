import { Controller, Get, Query } from '@nestjs/common';
import { AccuracyService } from './accuracy.service';

@Controller('api/accuracy')
export class AccuracyController {
  constructor(private readonly accuracyService: AccuracyService) {}

  @Get('session')
  getSessionInfo(@Query('symbol') symbol: string = 'NIFTY') {
    return this.accuracyService.getSessionInfo(symbol);
  }

  @Get('smt')
  getSMTDivergence(
    @Query('assetA') assetA: string = 'NIFTY',
    @Query('assetB') assetB: string = 'BANKNIFTY',
    @Query('timeframe') timeframe: string = 'M15',
  ) {
    return this.accuracyService.getSMTDivergence(assetA, assetB, timeframe);
  }

  @Get('smt-mtf')
  getSMTMultiTimeframe(
    @Query('assetA') assetA: string = 'NIFTY',
    @Query('assetB') assetB: string = 'BANKNIFTY',
  ) {
    return this.accuracyService.getSMTMultiTimeframe(assetA, assetB);
  }

  @Get('mtf-radar')
  getMTFFlowRadar(@Query('symbol') symbol: string = 'NIFTY') {
    return this.accuracyService.getMTFFlowRadar(symbol);
  }

  @Get('trailing')
  getDynamicTrailing(
    @Query('entryPrice') entryPrice: string,
    @Query('stopLoss') stopLoss: string,
    @Query('tp1') tp1: string,
    @Query('tp2') tp2: string,
    @Query('currentPrice') currentPrice: string,
    @Query('direction') direction: 'BULLISH' | 'BEARISH' = 'BULLISH',
  ) {
    return this.accuracyService.getDynamicTrailingState(
      Number(entryPrice || 24175),
      Number(stopLoss || 24100),
      Number(tp1 || 24250),
      Number(tp2 || 24320),
      Number(currentPrice || 24175),
      direction,
    );
  }

  @Get('liquidity-heatmap')
  getLiquidityHeatmap(@Query('symbol') symbol: string = 'NIFTY') {
    return this.accuracyService.getLiquidityHeatmap(symbol);
  }
}
