import { Module } from '@nestjs/common';
import { PaperTradingService } from './paper-trading.service';
import { PaperTradingController } from './paper-trading.controller';
import { PrismaModule } from '../common/prisma/prisma.module';
import { CandlesModule } from '../candles/candles.module';
import { MarketDataModule } from '../market-data/market-data.module';

@Module({
  imports: [PrismaModule, CandlesModule, MarketDataModule],
  controllers: [PaperTradingController],
  providers: [PaperTradingService],
  exports: [PaperTradingService],
})
export class PaperTradingModule {}
