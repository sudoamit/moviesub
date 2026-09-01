import { Controller, Get, Post, Query, Body, UsePipes, ValidationPipe } from '@nestjs/common';
import { CandlesService, ICandlesResponse, IChartDataResponse } from './candles.service';
import { GetCandlesDto, IngestCandlesDto } from './dto/get-candles.dto';
import { ICandle, Timeframe } from '@quant/shared';

@Controller('api/candles')
export class CandlesController {
  constructor(private readonly candlesService: CandlesService) {}

  @Get()
  @UsePipes(new ValidationPipe({ transform: true }))
  async getCandles(@Query() query: GetCandlesDto): Promise<ICandlesResponse> {
    return this.candlesService.getCandles(query);
  }

  @Get('chart-data')
  async getChartData(
    @Query('symbol') symbol: string = 'NIFTY',
    @Query('timeframe') timeframe: Timeframe = Timeframe.M15,
    @Query('limit') limit?: number,
  ): Promise<IChartDataResponse> {
    return this.candlesService.getChartData(symbol, timeframe, limit ? Number(limit) : 200);
  }

  @Get('latest')
  async getLatestCandle(
    @Query('symbol') symbol: string,
    @Query('timeframe') timeframe: Timeframe = Timeframe.M15,
  ): Promise<ICandle> {
    return this.candlesService.getLatestCandle(symbol, timeframe);
  }

  @Post('ingest')
  @UsePipes(new ValidationPipe({ transform: true }))
  async ingestCandles(@Body() body: IngestCandlesDto) {
    return this.candlesService.ingestCandles(body);
  }
}
