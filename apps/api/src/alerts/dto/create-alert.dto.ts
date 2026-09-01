import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { SignalGrade } from '@quant/shared';
import { Type } from 'class-transformer';

export class CreateAlertDto {
  @IsString()
  channel!: string; // 'TELEGRAM' | 'WEBHOOK' | 'EMAIL' | 'WEBPUSH'

  @IsString()
  target!: string; // chat_id, url, email, etc.

  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  @Type(() => Number)
  minScore?: number = 80;

  @IsEnum(SignalGrade)
  @IsOptional()
  minGrade?: SignalGrade = SignalGrade.A;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean = true;
}

export class TestAlertDto {
  @IsString()
  channel!: string;

  @IsString()
  target!: string;

  @IsString()
  @IsOptional()
  symbol?: string = 'NIFTY';
}
