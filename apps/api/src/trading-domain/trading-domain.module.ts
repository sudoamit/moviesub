import { Module, Global } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { DomainTradeDecisionService } from './trade-decision.service';
import { PositionSizingService } from './position-sizing.service';
import { RiskService } from './risk.service';
import { MarginService } from './margin.service';
import { ReservationService } from './reservation.service';
import { ExecutionService } from './execution.service';
import { OrderService } from './order.service';
import { FillService } from './fill.service';
import { PositionService } from './position.service';
import { TradeLifecycleService } from './trade-lifecycle.service';
import { AccountingService } from './accounting.service';
import { JournalService } from './journal.service';
import { ReconciliationService } from './reconciliation.service';

const DOMAIN_SERVICES = [
  DomainTradeDecisionService,
  PositionSizingService,
  RiskService,
  MarginService,
  ReservationService,
  ExecutionService,
  OrderService,
  FillService,
  PositionService,
  TradeLifecycleService,
  AccountingService,
  JournalService,
  ReconciliationService,
];

@Global()
@Module({
  imports: [PrismaModule],
  providers: DOMAIN_SERVICES,
  exports: DOMAIN_SERVICES,
})
export class TradingDomainModule {}
