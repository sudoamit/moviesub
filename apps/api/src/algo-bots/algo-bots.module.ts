import { Module } from '@nestjs/common';
import { AlgoBotsService } from './algo-bots.service';
import { AlgoBotsController } from './algo-bots.controller';
import { PaperTradingModule } from '../paper-trading/paper-trading.module';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  imports: [PaperTradingModule, AlertsModule],
  controllers: [AlgoBotsController],
  providers: [AlgoBotsService],
  exports: [AlgoBotsService],
})
export class AlgoBotsModule {}
