import { IsEnum, IsNumber, IsOptional, IsPositive, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { Timeframe } from '@quant/shared';

export class RunBacktestDto {
  @IsString()
  symbol!: string;

  @IsEnum(Timeframe)
  @IsOptional()
  timeframe?: Timeframe = Timeframe.M15;

  @IsNumber()
  @IsOptional()
  @IsPositive()
  @Type(() => Number)
  initialCapital?: number = 100000;

  @IsNumber()
  @IsOptional()
  @IsPositive()
  @Type(() => Number)
  riskPerTradePercent?: number = 1.0;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  minScore?: number = 65;

  @IsNumber()
  @IsOptional()
  @Min(50)
  @Type(() => Number)
  limit?: number = 300;
}
