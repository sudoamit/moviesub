import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { LearningController } from './learning.controller';
import { LearningService } from './learning.service';

@Module({
  imports: [PrismaModule],
  controllers: [LearningController],
  providers: [LearningService],
  exports: [LearningService],
})
export class LearningModule {}
