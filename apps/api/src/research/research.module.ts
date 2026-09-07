import { Module } from '@nestjs/common';
import { ResearchController } from './research.controller';
import { ResearchService } from './research.service';
import { CandlesModule } from '../candles/candles.module';

@Module({
  imports: [CandlesModule],
  controllers: [ResearchController],
  providers: [ResearchService],
  exports: [ResearchService],
})
export class ResearchModule {}
