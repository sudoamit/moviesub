import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { CandlesModule } from '../candles/candles.module';
import { MistakeLearningService } from './mistake-learning.service';
import { MistakeLearningController } from './mistake-learning.controller';

@Module({
  imports: [PrismaModule, CandlesModule],
  controllers: [MistakeLearningController],
  providers: [MistakeLearningService],
  exports: [MistakeLearningService],
})
export class MistakeLearningModule {}
