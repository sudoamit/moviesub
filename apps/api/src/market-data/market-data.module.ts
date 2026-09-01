import { Module } from '@nestjs/common';
import { MarketDataService } from './market-data.service';
import { RealMarketStreamerService } from './real-market-streamer.service';

@Module({
  providers: [MarketDataService, RealMarketStreamerService],
  exports: [MarketDataService, RealMarketStreamerService],
})
export class MarketDataModule {}
