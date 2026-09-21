import { Module } from '@nestjs/common';
import { InstrumentsService } from './instruments.service';
import { InstrumentsController } from './instruments.controller';
import { PrismaModule } from '../common/prisma/prisma.module';
import { TradingDomainModule } from '../trading-domain/trading-domain.module';

@Module({
  imports: [PrismaModule, TradingDomainModule],
  controllers: [InstrumentsController],
  providers: [InstrumentsService],
  exports: [InstrumentsService],
})
export class InstrumentsModule {}
