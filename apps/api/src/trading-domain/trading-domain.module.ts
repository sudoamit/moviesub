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
import { InstrumentMasterService } from './instrument-master.service';
import { CurrencyConversionService } from './currency-conversion.service';
import { OutboxService } from './outbox.service';
import { MarketDataSafetyService } from './market-data-safety.service';
import { MarketSessionService } from './market-session.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import { VolatilityService } from './volatility.service';
import { SignalAggregationService } from './signal-aggregation.service';
import { ExecutionCostService } from './execution-cost.service';
import { SmartOrderRoutingService } from './smart-order-routing.service';

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
  InstrumentMasterService,
  CurrencyConversionService,
  OutboxService,
  MarketDataSafetyService,
  MarketSessionService,
  CircuitBreakerService,
  VolatilityService,
  SignalAggregationService,
  ExecutionCostService,
  SmartOrderRoutingService,
];

@Global()
@Module({
  imports: [PrismaModule],
  providers: DOMAIN_SERVICES,
  exports: DOMAIN_SERVICES,
})
export class TradingDomainModule {}

