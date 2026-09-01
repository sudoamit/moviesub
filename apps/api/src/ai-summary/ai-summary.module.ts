import { Module } from '@nestjs/common';
import { AISummaryController } from './ai-summary.controller';
import { AISummaryService } from './ai-summary.service';
import { SignalsModule } from '../signals/signals.module';
import { SMCModule } from '../smc/smc.module';

@Module({
  imports: [SignalsModule, SMCModule],
  controllers: [AISummaryController],
  providers: [AISummaryService],
  exports: [AISummaryService],
})
export class AISummaryModule {}
