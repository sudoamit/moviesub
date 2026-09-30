import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
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
    // No fabricated NIFTY levels: every level must be supplied by the caller.
    const levels = [entryPrice, stopLoss, tp1, tp2, currentPrice].map((v) => Number(v));
    if (levels.some((v) => !Number.isFinite(v) || v <= 0)) {
      throw new BadRequestException(
        'entryPrice, stopLoss, tp1, tp2 and currentPrice are required positive numbers.',
      );
    }
    const [entry, sl, t1, t2, current] = levels;
    return this.accuracyService.getDynamicTrailingState(entry, sl, t1, t2, current, direction);
  }

  @Get('liquidity-heatmap')
  getLiquidityHeatmap(@Query('symbol') symbol: string = 'NIFTY') {
    return this.accuracyService.getLiquidityHeatmap(symbol);
  }
}
