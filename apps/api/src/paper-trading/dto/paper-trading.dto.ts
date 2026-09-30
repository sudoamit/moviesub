import { Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
} from 'class-validator';

/**
 * External (HTTP) order request.
 *
 * Deliberately excludes server-authoritative fields: allowPriceOverride, executionMode, accountId,
 * sourceBotId, tradeDecisionId, accountBalance and featureSnapshotJson. The global ValidationPipe runs
 * with forbidNonWhitelisted, so a client sending any of them is rejected instead of silently honoured.
 *
 * `price` is never used as a fill price: for MARKET orders it is only a sanity reference for option
 * premiums, and for LIMIT orders it is the limit that must be marketable against the server quote.
 */
export class PlaceOrderDto {
  @IsString()
  @IsNotEmpty()
  symbol!: string;

  @IsIn(['BUY', 'SELL'])
  direction!: 'BUY' | 'SELL';

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  quantity!: number;

  @IsOptional()
  @IsIn(['MARKET', 'LIMIT'])
  orderType: 'MARKET' | 'LIMIT' = 'MARKET';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  price?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  stopLoss?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  target1?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  target2?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  target3?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  leverage?: number;

  @IsOptional()
  @IsIn(['SPOT', 'OPTION'])
  instrumentType?: 'SPOT' | 'OPTION';

  @IsOptional()
  @IsString()
  executionInstrumentType?: string;

  @IsOptional()
  @IsString()
  executionInstrument?: string;

  @IsOptional()
  @IsString()
  contractSymbol?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  strike?: number;

  @IsOptional()
  @IsIn(['CE', 'PE'])
  optionType?: 'CE' | 'PE';

  @IsOptional()
  @IsString()
  expiry?: string;

  @IsOptional()
  @IsString()
  signalId?: string;

  @IsOptional()
  @IsString()
  strategyDirection?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @IsOptional()
  @IsString()
  correlationId?: string;
}

/**
 * External close request. Exits are always priced from the validated live quote on the server,
 * so no exit price or price-override flag is accepted.
 */
export class ClosePositionDto {
  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  @Max(1)
  partialRatio?: number;
}

export class ClosePositionByBodyDto extends ClosePositionDto {
  @IsString()
  @IsNotEmpty()
  positionId!: string;
}

export class ScaleOutDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  @Max(1)
  ratio?: number;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class ScaleOutByBodyDto extends ScaleOutDto {
  @IsString()
  @IsNotEmpty()
  positionId!: string;
}
