import { Module } from '@nestjs/common';
import { AILearningService } from './ai-learning.service';
import { AILearningController } from './ai-learning.controller';
import { PrismaModule } from '../common/prisma/prisma.module';
import { SignalsModule } from '../signals/signals.module';
import { SMCModule } from '../smc/smc.module';
import { AccuracyModule } from '../accuracy/accuracy.module';

@Module({
  imports: [PrismaModule, SignalsModule, SMCModule, AccuracyModule],
  controllers: [AILearningController],
  providers: [AILearningService],
  exports: [AILearningService],
})
export class AILearningModule {}
