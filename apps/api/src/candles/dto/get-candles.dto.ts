import { IsEnum, IsNumber, IsOptional, IsString, IsDateString, Min, Max } from 'class-validator';
import { Timeframe } from '@quant/shared';
import { Type } from 'class-transformer';

export class GetCandlesDto {
  @IsString()
  symbol!: string;

  @IsOptional()
  @IsEnum(Timeframe)
  timeframe: Timeframe = Timeframe.M15;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(2000)
  limit: number = 100;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsString()
  sourceMode?: 'LIVE_DECISION' | 'BACKTEST' | 'LEARNING' | 'CHART' | 'HISTORICAL';
}

export class IngestCandlesDto {
  @IsString()
  symbol!: string;

  @IsOptional()
  @IsEnum(Timeframe)
  timeframe: Timeframe = Timeframe.M15;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(1000)
  limit: number = 200;
}
