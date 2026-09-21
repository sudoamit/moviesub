import { Module } from '@nestjs/common';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';
import { TelegramDispatcher } from './dispatcher/telegram.dispatcher';
import { WebhookDispatcher } from './dispatcher/webhook.dispatcher';
import { AlertRateLimiter } from './dispatcher/rate-limiter';
import { AlertIdempotencyService } from './alert-idempotency.service';
import { SignalsModule } from '../signals/signals.module';

@Module({
  imports: [SignalsModule],
  controllers: [AlertsController],
  providers: [
    AlertsService,
    TelegramDispatcher,
    WebhookDispatcher,
    AlertRateLimiter,
    AlertIdempotencyService,
  ],
  exports: [AlertsService, AlertIdempotencyService],
})
export class AlertsModule {}
