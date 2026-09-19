import { Module } from '@nestjs/common';
import { MarketDataService } from './market-data.service';
import { RealMarketStreamerService } from './real-market-streamer.service';
import { MarketDataController } from './market-data.controller';

@Module({
  controllers: [MarketDataController],
  providers: [MarketDataService, RealMarketStreamerService],
  exports: [MarketDataService, RealMarketStreamerService],
})
export class MarketDataModule {}

