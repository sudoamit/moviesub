import { Module } from '@nestjs/common';
import { BacktestsController } from './backtests.controller';
import { BacktestsService } from './backtests.service';
import { CandlesModule } from '../candles/candles.module';

@Module({
  imports: [CandlesModule],
  controllers: [BacktestsController],
  providers: [BacktestsService],
  exports: [BacktestsService],
})
export class BacktestsModule {}
