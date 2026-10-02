import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { CandlesModule } from '../candles/candles.module';
import { PaperTradingModule } from '../paper-trading/paper-trading.module';
import { NiftyLabService } from './nifty-lab.service';
import { NiftyLabController } from './nifty-lab.controller';

@Module({
  imports: [PrismaModule, CandlesModule, PaperTradingModule],
  controllers: [NiftyLabController],
  providers: [NiftyLabService],
  exports: [NiftyLabService],
})
export class NiftyLabModule {}
