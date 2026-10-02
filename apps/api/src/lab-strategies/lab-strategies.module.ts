import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { CandlesModule } from '../candles/candles.module';
import { PaperTradingModule } from '../paper-trading/paper-trading.module';
import { LabStrategiesService } from './lab-strategies.service';
import { LabStrategiesController, LabDiscoveryController, LabQualityController } from './lab-strategies.controller';
import { LabDiscoveryService } from './lab-discovery.service';
import { LabQualityService } from './lab-quality.service';

@Module({
  imports: [PrismaModule, CandlesModule, PaperTradingModule],
  controllers: [LabStrategiesController, LabDiscoveryController, LabQualityController],
  providers: [LabStrategiesService, LabDiscoveryService, LabQualityService],
  exports: [LabStrategiesService, LabDiscoveryService, LabQualityService],
})
export class LabStrategiesModule {}
