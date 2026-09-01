import { Module } from '@nestjs/common';
import { AccuracyService } from './accuracy.service';
import { AccuracyController } from './accuracy.controller';
import { PrismaModule } from '../common/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [AccuracyController],
  providers: [AccuracyService],
  exports: [AccuracyService],
})
export class AccuracyModule {}
