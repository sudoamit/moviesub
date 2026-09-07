import { IsEnum, IsNumber, IsOptional, IsString, IsDateString, Min, Max } from 'class-validator';
import { Direction, MarketRegimeType, SignalGrade, SignalState, Timeframe } from '../enums';

export class FilterScannerDto {
  @IsOptional()
  @IsEnum(Timeframe)
  timeframe?: Timeframe;

  @IsOptional()
  @IsEnum(Direction)
  direction?: Direction;

  @IsOptional()
  @IsEnum(SignalGrade)
  minGrade?: SignalGrade;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  minScore?: number;

  @IsOptional()
  @IsEnum(MarketRegimeType)
  regime?: MarketRegimeType;
}

export class RunBacktestDto {
  @IsString()
  instrumentId!: string;

  @IsEnum(Timeframe)
  timeframe!: Timeframe;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsNumber()
  @Min(1000)
  initialCapital!: number;

  @IsNumber()
  @Min(0.1)
  @Max(10)
  riskPerTradePercent!: number;

  @IsOptional()
  @IsNumber()
  @Min(50)
  @Max(100)
  minScore?: number;

  @IsOptional()
  strategyConfig?: Record<string, any>;
}

export class CreateAlertDto {
  @IsString()
  channel!: string;

  @IsString()
  target!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  minScore?: number;

  @IsOptional()
  @IsEnum(SignalGrade)
  minGrade?: SignalGrade;
}

export class CreateStrategyDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  isDefault?: boolean;

  configJson!: Record<string, any>;
}
