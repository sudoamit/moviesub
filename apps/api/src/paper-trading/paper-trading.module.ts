import { Module } from '@nestjs/common';
import { PaperTradingService } from './paper-trading.service';
import { PaperPositionMonitorService } from './paper-position-monitor.service';
import { PaperTradingController } from './paper-trading.controller';
import { PrismaModule } from '../common/prisma/prisma.module';
import { CandlesModule } from '../candles/candles.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { TradingDomainModule } from '../trading-domain/trading-domain.module';

@Module({
  imports: [PrismaModule, CandlesModule, MarketDataModule, TradingDomainModule],
  controllers: [PaperTradingController],
  providers: [PaperTradingService, PaperPositionMonitorService],
  exports: [PaperTradingService, PaperPositionMonitorService, TradingDomainModule],
})
export class PaperTradingModule {}
