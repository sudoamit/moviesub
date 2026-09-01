import { Module } from '@nestjs/common';
import { SMCController } from './smc.controller';
import { SMCService } from './smc.service';
import { CandlesModule } from '../candles/candles.module';

@Module({
  imports: [CandlesModule],
  controllers: [SMCController],
  providers: [SMCService],
  exports: [SMCService],
})
export class SMCModule {}
