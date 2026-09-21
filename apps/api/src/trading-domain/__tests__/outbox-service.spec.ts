import { NotFoundException } from '@nestjs/common';
import { OutboxService } from '../outbox.service';
import { OutboxEvent } from '@quant/shared';

describe('Phase 19 — Transactional Outbox Engine (OutboxService)', () => {
  let outboxService: OutboxService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      auditEvent: {
        create: jest.fn().mockResolvedValue({ id: 'audit_1' }),
      },
    };
    outboxService = new OutboxService(mockPrisma);
  });

  describe('1. Atomic Event Creation & Deduplication', () => {
    it('should create a pending outbox event with deterministic properties', async () => {
      const event = await outboxService.createEvent({
        aggregateType: 'ORDER',
        aggregateId: 'ord_123',
        eventType: 'ORDER_PLACED',
        payload: { symbol: 'NIFTY', quantity: 50, price: 24000 },
        correlationId: 'corr_test_1',
      });

      expect(event.id).toMatch(/^outbox_/);
      expect(event.aggregateType).toBe('ORDER');
      expect(event.aggregateId).toBe('ord_123');
      expect(event.eventType).toBe('ORDER_PLACED');
      expect(event.status).toBe('PENDING');
      expect(event.retryCount).toBe(0);
      expect(event.maxRetries).toBe(5);
      expect(event.correlationId).toBe('corr_test_1');
      expect(event.scheduledFor).toBeInstanceOf(Date);
      expect(event.createdAt).toBeInstanceOf(Date);
    });

    it('should return existing event idempotently when duplicate deduplicationId is provided', async () => {
      const first = await outboxService.createEvent({
        aggregateType: 'POSITION',
        aggregateId: 'pos_123',
        eventType: 'POSITION_OPENED',
        payload: { units: 100 },
        deduplicationId: 'dedup_pos_open_123',
      });

      const second = await outboxService.createEvent({
        aggregateType: 'POSITION',
        aggregateId: 'pos_123',
        eventType: 'POSITION_OPENED',
        payload: { units: 100 },
        deduplicationId: 'dedup_pos_open_123',
      });

      expect(second.id).toBe(first.id);
      expect(await outboxService.getPendingCount()).toBe(1);
    });

    it('should batch create multiple events', async () => {
      const events = await outboxService.createBatch([
        {
          aggregateType: 'TRADE',
          aggregateId: 'trade_1',
          eventType: 'TRADE_TAKEN',
          payload: { side: 'BUY' },
        },
        {
          aggregateType: 'ALERT',
          aggregateId: 'alert_1',
          eventType: 'TELEGRAM_DISPATCH',
          payload: { channel: 'TG' },
        },
      ]);

      expect(events).toHaveLength(2);
      expect(events[0].eventType).toBe('TRADE_TAKEN');
      expect(events[1].eventType).toBe('TELEGRAM_DISPATCH');
    });

    it('should record transactional auditEvent when tx client is passed', async () => {
      const mockTx = {
        auditEvent: {
          create: jest.fn().mockResolvedValue({ id: 'audit_tx_1' }),
        },
      };

      const event = await outboxService.createEvent(
        {
          aggregateType: 'RISK',
          aggregateId: 'acc_live_1',
          eventType: 'EMERGENCY_STOP_TRIGGERED',
          payload: { reason: 'DRAWDOWN_EXCEEDED' },
        },
        mockTx,
      );

      expect(mockTx.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventType: 'EMERGENCY_STOP_TRIGGERED',
            entityType: 'RISK',
            entityId: 'acc_live_1',
          }),
        }),
      );
      expect(event.status).toBe('PENDING');
    });
  });

  describe('2. CAS Concurrency-Safe Event Leasing & Stale Lock Reclamation', () => {
    it('should lock pending events and prevent concurrent worker double-lease', async () => {
      await outboxService.createEvent({
        aggregateType: 'ORDER',
        aggregateId: 'ord_1',
        eventType: 'ORDER_FILLED',
        payload: { fillPrice: 24100 },
      });

      const workerALocked = await outboxService.fetchAndLockPendingEvents(10, 30000, 'worker_A');
      expect(workerALocked).toHaveLength(1);
      expect(workerALocked[0].status).toBe('PROCESSING');
      expect(workerALocked[0].lockedBy).toBe('worker_A');

      // Worker B should get 0 events because worker A holds an active lock
      const workerBLocked = await outboxService.fetchAndLockPendingEvents(10, 30000, 'worker_B');
      expect(workerBLocked).toHaveLength(0);
    });

    it('should reclaim stale expired lock if a worker crashes mid-flight', async () => {
      const event = await outboxService.createEvent({
        aggregateType: 'ORDER',
        aggregateId: 'ord_stale',
        eventType: 'ORDER_CANCELLED',
        payload: {},
      });

      // Simulate worker crash: event marked PROCESSING with expired lock
      const locked = (await outboxService.fetchAndLockPendingEvents(1, 1000, 'worker_crashed'))[0];
      outboxService._updateEventDirectlyForTesting(locked.id, {
        lockedUntil: new Date(Date.now() - 5000),
      });

      // Worker Recovery should successfully reclaim the stale lock
      const recovered = await outboxService.fetchAndLockPendingEvents(1, 30000, 'worker_recovered');
      expect(recovered).toHaveLength(1);
      expect(recovered[0].id).toBe(event.id);
      expect(recovered[0].lockedBy).toBe('worker_recovered');
    });
  });

  describe('3. Lifecycle Transitions, Exponential Backoff & Dead-Letter Queue (DLQ)', () => {
    it('should mark an event as PUBLISHED and clear worker locks', async () => {
      const event = await outboxService.createEvent({
        aggregateType: 'POSITION',
        aggregateId: 'pos_1',
        eventType: 'POSITION_CLOSED',
        payload: { pnl: 5000 },
      });

      await outboxService.fetchAndLockPendingEvents(1, 30000, 'worker_1');
      const published = await outboxService.markPublished(event.id, 'worker_1');

      expect(published.status).toBe('PUBLISHED');
      expect(published.processedAt).toBeInstanceOf(Date);
      expect(published.lockedBy).toBeUndefined();
      expect(published.lockedUntil).toBeUndefined();
    });

    it('should record retry with exponential backoff on transient failure', async () => {
      const event = await outboxService.createEvent({
        aggregateType: 'ALERT',
        aggregateId: 'alert_1',
        eventType: 'WEBHOOK_DISPATCH',
        payload: { url: 'https://example.com/webhook' },
      });

      await outboxService.fetchAndLockPendingEvents(1, 30000, 'worker_1');
      const failed = await outboxService.markFailed(
        event.id,
        'HTTP 503 Service Unavailable',
        true,
        'worker_1',
      );

      expect(failed.status).toBe('PENDING');
      expect(failed.retryCount).toBe(1);
      expect(failed.lastError).toBe('HTTP 503 Service Unavailable');
      expect(failed.lockedBy).toBeUndefined();
      // Backoff for retry 1: ~2000ms
      expect(failed.scheduledFor.getTime()).toBeGreaterThan(Date.now() + 1000);
    });

    it('should transition to DEAD_LETTER when maxRetries is exhausted', async () => {
      const event = await outboxService.createEvent({
        aggregateType: 'ALERT',
        aggregateId: 'alert_exhaust',
        eventType: 'TELEGRAM_DISPATCH',
        payload: { text: 'test' },
        maxRetries: 2,
      });

      // Retry 1
      await outboxService.fetchAndLockPendingEvents(1, 30000);
      await outboxService.markFailed(event.id, 'Network drop', true);

      // Retry 2 -> Exhausted
      outboxService._updateEventDirectlyForTesting(event.id, {
        scheduledFor: new Date(Date.now() - 1000),
      });
      await outboxService.fetchAndLockPendingEvents(1, 30000);
      const deadLetter = await outboxService.markFailed(event.id, 'Socket closed', true);

      expect(deadLetter.status).toBe('DEAD_LETTER');
      expect(deadLetter.retryCount).toBe(2);
      expect(deadLetter.lastError).toBe('Socket closed');

      const deadLetterEvents = await outboxService.getDeadLetterEvents();
      expect(deadLetterEvents.some((e) => e.id === event.id)).toBe(true);
    });

    it('should immediately transition to DEAD_LETTER on non-retryable failure', async () => {
      const event = await outboxService.createEvent({
        aggregateType: 'ORDER',
        aggregateId: 'ord_bad_auth',
        eventType: 'BROKER_SUBMIT',
        payload: {},
        maxRetries: 5,
      });

      await outboxService.fetchAndLockPendingEvents(1, 30000);
      const deadLetter = await outboxService.markFailed(
        event.id,
        'INVALID_API_CREDENTIALS',
        false,
      );

      expect(deadLetter.status).toBe('DEAD_LETTER');
      expect(deadLetter.lastError).toBe('INVALID_API_CREDENTIALS');
    });
  });

  describe('4. Batch Polling Runner & Decoupled Handlers', () => {
    it('should dispatch to registered handlers and mark succeeded in processOutbox cycle', async () => {
      const handledEvents: OutboxEvent[] = [];

      outboxService.registerHandler('ORDER_FILLED', async (evt) => {
        handledEvents.push(evt);
      });

      await outboxService.createEvent({
        aggregateType: 'ORDER',
        aggregateId: 'ord_cycle_1',
        eventType: 'ORDER_FILLED',
        payload: { qty: 25 },
      });

      const report = await outboxService.processOutbox(10, 'batch_worker');

      expect(report.totalProcessed).toBe(1);
      expect(report.succeeded).toBe(1);
      expect(report.failed).toBe(0);
      expect(report.deadLettered).toBe(0);
      expect(handledEvents).toHaveLength(1);
      expect(handledEvents[0].aggregateId).toBe('ord_cycle_1');

      const updated = await outboxService.getEventById(handledEvents[0].id);
      expect(updated?.status).toBe('PUBLISHED');
    });

    it('should handle handler failure gracefully without crashing the batch cycle', async () => {
      outboxService.registerHandler('FAILING_EVENT', async () => {
        throw new Error('Remote webhook timeout');
      });

      await outboxService.createEvent({
        aggregateType: 'ALERT',
        aggregateId: 'alert_failing',
        eventType: 'FAILING_EVENT',
        payload: {},
      });

      const report = await outboxService.processOutbox(10, 'batch_worker');

      expect(report.totalProcessed).toBe(1);
      expect(report.succeeded).toBe(0);
      expect(report.failed).toBe(1);
      expect(report.details[0].error).toBe('Remote webhook timeout');
    });
  });

  describe('5. Retention Purge & Query Operations', () => {
    it('should purge old PUBLISHED events while retaining DEAD_LETTER events', async () => {
      const oldPublished = await outboxService.createEvent({
        aggregateType: 'ORDER',
        aggregateId: 'ord_old',
        eventType: 'ORDER_FILLED',
        payload: {},
      });
      await outboxService.markPublished(oldPublished.id);

      // Manually date-back processedAt to 10 days ago
      outboxService._updateEventDirectlyForTesting(oldPublished.id, {
        processedAt: new Date(Date.now() - 10 * 86400000),
      });

      const deadLetter = await outboxService.createEvent({
        aggregateType: 'ALERT',
        aggregateId: 'alert_dl',
        eventType: 'FAILED_ALERT',
        payload: {},
      });
      await outboxService.markFailed(deadLetter.id, 'Fatal error', false);

      const purged = await outboxService.purgeProcessedEvents(7);
      expect(purged).toBe(1);

      expect(await outboxService.getEventById(oldPublished.id)).toBeNull();
      expect(await outboxService.getEventById(deadLetter.id)).not.toBeNull();
    });

    it('should query events by aggregateType and aggregateId', async () => {
      await outboxService.createEvent({
        aggregateType: 'POSITION',
        aggregateId: 'pos_agg_99',
        eventType: 'POSITION_OPENED',
        payload: {},
      });
      await outboxService.createEvent({
        aggregateType: 'POSITION',
        aggregateId: 'pos_agg_99',
        eventType: 'POSITION_CLOSED',
        payload: {},
      });
      await outboxService.createEvent({
        aggregateType: 'POSITION',
        aggregateId: 'pos_agg_other',
        eventType: 'POSITION_OPENED',
        payload: {},
      });

      const pos99Events = await outboxService.getEventsByAggregate('POSITION', 'pos_agg_99');
      expect(pos99Events).toHaveLength(2);
    });
  });
});
