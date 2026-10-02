import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { PaperTradingModule } from '../paper-trading/paper-trading.module';
import { MarketObserverService } from './market-observer.service';
import { MarketObserverController } from './market-observer.controller';

@Module({
  imports: [PrismaModule, PaperTradingModule],
  controllers: [MarketObserverController],
  providers: [MarketObserverService],
  exports: [MarketObserverService],
})
export class MarketObserverModule {}
