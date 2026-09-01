import { Module } from '@nestjs/common';
import { CandlesController } from './candles.controller';
import { CandlesService } from './candles.service';
import { MarketDataModule } from '../market-data/market-data.module';

@Module({
  imports: [MarketDataModule],
  controllers: [CandlesController],
  providers: [CandlesService],
  exports: [CandlesService],
})
export class CandlesModule {}
