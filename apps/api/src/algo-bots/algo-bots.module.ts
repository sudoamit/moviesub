import { Module } from '@nestjs/common';
import { AlgoBotsService } from './algo-bots.service';
import { TradeDecisionService } from './trade-decision.service';
import { AlgoBotsController } from './algo-bots.controller';
import { PaperTradingModule } from '../paper-trading/paper-trading.module';
import { AlertsModule } from '../alerts/alerts.module';
import { TradingDomainModule } from '../trading-domain/trading-domain.module';

@Module({
  imports: [PaperTradingModule, AlertsModule, TradingDomainModule],
  controllers: [AlgoBotsController],
  providers: [AlgoBotsService, TradeDecisionService],
  exports: [AlgoBotsService, TradeDecisionService, TradingDomainModule],
})
export class AlgoBotsModule {}

