import { Body, Controller, Delete, Get, Param, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { SignalsService, IRecordTradeDto } from './signals.service';
import { Timeframe } from '@quant/shared';
import { IsNumber, IsOptional, IsPositive, Min, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class PositionSizeDto {
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  accountBalance!: number;

  @IsNumber()
  @IsOptional()
  @IsPositive()
  @Type(() => Number)
  riskPercentage?: number;

  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  entryPrice!: number;

  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  stopLoss!: number;

  @IsNumber()
  @IsOptional()
  @Min(1)
  @Type(() => Number)
  lotSize?: number;
}

export class EvaluateTradeDto {
  @IsString()
  symbol!: string;

  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  livePrice!: number;

  @IsOptional()
  timeframe?: Timeframe;
}

@Controller('api/signals')
export class SignalsController {
  constructor(private readonly signalsService: SignalsService) {}

  @Get()
  async getAllSignals(
    @Query('timeframe') timeframe: Timeframe = Timeframe.M15,
    @Query('strategy') strategy: 'SMC' | 'SAIYAN_OCC' | 'HYBRID' = 'SMC',
  ) {
    return this.signalsService.getAllSignals(timeframe, strategy);
  }

  @Get('completed-trades')
  async getCompletedTrades(
    @Query('limit') limit = 50,
    @Query('executionData') executionData?: 'VERIFIED' | 'LEGACY' | 'ALL',
    @Query('includeLegacy') includeLegacy?: string | boolean,
  ) {
    let mode: 'VERIFIED' | 'LEGACY' | 'ALL' = executionData || 'VERIFIED';
    if (!executionData && (includeLegacy === 'true' || includeLegacy === true)) {
      mode = 'ALL';
    }
    return this.signalsService.getCompletedTrades(Number(limit) || 50, mode);
  }

  @Get('export-csv')
  async exportTradesCsv(
    @Query('limit') limit: string,
    @Query('executionData') executionData: 'VERIFIED' | 'LEGACY' | 'ALL' = 'ALL',
    @Res() res: Response,
  ) {
    const { filename, csvContent } = await this.signalsService.exportTradesToCsv(
      Number(limit) || 200,
      executionData,
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csvContent);
  }

  @Post('sync-trades')
  async syncHistoricalTrades() {
    return this.signalsService.syncHistoricalTrades();
  }

  @Get('sync-trades')
  async syncHistoricalTradesGet() {
    return this.signalsService.syncHistoricalTrades();
  }

  @Delete('clear-trades')
  async clearAllTrades() {
    return this.signalsService.clearAllCompletedTrades();
  }

  @Post('clear-trades')
  async clearAllTradesPost() {
    return this.signalsService.clearAllCompletedTrades();
  }

  @Post('evaluate-trade')
  async evaluateTrade(@Body() body: EvaluateTradeDto) {
    return this.signalsService.evaluateTrade(
      body.symbol,
      body.livePrice,
      body.timeframe || Timeframe.M15,
    );
  }

  @Post('record-trade')
  async recordTrade(@Body() body: IRecordTradeDto) {
    return this.signalsService.recordCompletedTrade(body);
  }

  @Get(':symbol')
  async getSignalForSymbol(
    @Param('symbol') symbol: string,
    @Query('timeframe') timeframe: Timeframe = Timeframe.M15,
  ) {
    return this.signalsService.generateSignalForSymbol(symbol, timeframe);
  }

  @Post('position-size')
  async calculatePositionSize(@Body() body: PositionSizeDto) {
    return this.signalsService.calculatePositionSize(
      body.accountBalance,
      body.riskPercentage ?? 1.0,
      body.entryPrice,
      body.stopLoss,
      body.lotSize ?? 1,
    );
  }
}
