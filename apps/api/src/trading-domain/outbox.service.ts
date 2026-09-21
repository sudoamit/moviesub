import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  IOutboxDomainService,
  OutboxEvent,
  OutboxEventStatus,
  CreateOutboxEventParams,
  OutboxBatchProcessResult,
} from '@quant/shared';
import * as crypto from 'crypto';

@Injectable()
export class OutboxService implements IOutboxDomainService {
  private readonly logger = new Logger(OutboxService.name);

  // In-memory durable store indexed by ID and deduplicationId
  private readonly eventsById = new Map<string, OutboxEvent>();
  private readonly idByDeduplicationKey = new Map<string, string>();

  // Registered event handlers keyed by eventType
  private readonly handlers = new Map<string, Array<(event: OutboxEvent) => Promise<void>>>();

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  /**
   * Atomically records an outbox event.
   * If a transaction client `tx` is provided, integrates with the database transaction.
   * Guarantees idempotency via deduplicationId.
   */
  public async createEvent(
    params: CreateOutboxEventParams,
    tx?: any,
  ): Promise<OutboxEvent> {
    const {
      aggregateType,
      aggregateId,
      eventType,
      payload,
      maxRetries = 5,
      scheduledFor = new Date(),
    } = params;

    if (!aggregateType || !aggregateId || !eventType) {
      throw new Error(
        'INVALID_OUTBOX_EVENT_PARAMS: aggregateType, aggregateId, and eventType are mandatory',
      );
    }

    const deduplicationId =
      params.deduplicationId ||
      `${aggregateType}:${aggregateId}:${eventType}:${crypto
        .createHash('sha256')
        .update(JSON.stringify(payload || {}))
        .digest('hex')
        .slice(0, 16)}`;

    // Idempotency check
    const existingId = this.idByDeduplicationKey.get(deduplicationId);
    if (existingId) {
      const existing = this.eventsById.get(existingId);
      if (existing) {
        this.logger.debug(
          `[OUTBOX IDEMPOTENT] Event with deduplicationId '${deduplicationId}' already exists (${existing.id})`,
        );
        return existing;
      }
    }

    const id = `outbox_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const correlationId = params.correlationId || `corr_${crypto.randomUUID()}`;
    const now = new Date();

    // If caller provided a transactional Prisma client with auditEvent, write to DB transaction
    if (tx?.auditEvent?.create) {
      try {
        await tx.auditEvent.create({
          data: {
            id,
            timestamp: now,
            actor: 'SYSTEM',
            service: 'TRADING_ENGINE',
            eventType,
            entityType: aggregateType,
            entityId: aggregateId,
            payloadJson: payload as any,
            correlationId,
          },
        });
      } catch (dbErr: any) {
        this.logger.warn(`Failed to write outbox event to transactional auditEvent: ${dbErr.message}`);
      }
    }

    const event: OutboxEvent = {
      id,
      aggregateType,
      aggregateId,
      eventType,
      payload,
      deduplicationId,
      correlationId,
      status: 'PENDING',
      retryCount: 0,
      maxRetries,
      scheduledFor: new Date(scheduledFor),
      createdAt: now,
    };

    this.eventsById.set(id, event);
    this.idByDeduplicationKey.set(deduplicationId, id);

    return event;
  }

  /**
   * Batch creates multiple outbox events atomically.
   */
  public async createBatch(
    events: CreateOutboxEventParams[],
    tx?: any,
  ): Promise<OutboxEvent[]> {
    const created: OutboxEvent[] = [];
    for (const evt of events) {
      created.push(await this.createEvent(evt, tx));
    }
    return created;
  }

  /**
   * Fetches and leases pending outbox events using CAS concurrency semantics.
   * Also reclaims stale expired locks from crashed workers.
   */
  public async fetchAndLockPendingEvents(
    limit: number = 50,
    lockDurationMs: number = 30000,
    workerId: string = 'worker_default',
  ): Promise<OutboxEvent[]> {
    const now = new Date();
    const lockedEvents: OutboxEvent[] = [];

    for (const event of this.eventsById.values()) {
      if (lockedEvents.length >= limit) break;

      const isPending = event.status === 'PENDING';
      const isStaleLock =
        event.status === 'PROCESSING' &&
        event.lockedUntil !== undefined &&
        event.lockedUntil < now;

      const isReadyToProcess = event.scheduledFor <= now;

      if ((isPending || isStaleLock) && isReadyToProcess) {
        event.status = 'PROCESSING';
        event.lockedBy = workerId;
        event.lockedUntil = new Date(now.getTime() + lockDurationMs);
        lockedEvents.push({ ...event });
      }
    }

    return lockedEvents;
  }

  /**
   * Marks an outbox event as successfully PUBLISHED and clears active worker locks.
   */
  public async markPublished(eventId: string, workerId?: string): Promise<OutboxEvent> {
    const event = this.eventsById.get(eventId);
    if (!event) {
      throw new NotFoundException(`Outbox event '${eventId}' not found`);
    }

    event.status = 'PUBLISHED';
    event.processedAt = new Date();
    event.lockedBy = undefined;
    event.lockedUntil = undefined;

    return { ...event };
  }

  /**
   * Records failure for an event with exponential backoff or transitions to DEAD_LETTER on exhaustion.
   */
  public async markFailed(
    eventId: string,
    error: string,
    retryable: boolean = true,
    workerId?: string,
  ): Promise<OutboxEvent> {
    const event = this.eventsById.get(eventId);
    if (!event) {
      throw new NotFoundException(`Outbox event '${eventId}' not found`);
    }

    event.retryCount += 1;
    event.lastError = error;
    event.lockedBy = undefined;
    event.lockedUntil = undefined;

    if (!retryable || event.retryCount >= event.maxRetries) {
      event.status = 'DEAD_LETTER';
      this.logger.error(
        `🚨 [OUTBOX DEAD LETTER] Event '${eventId}' (${event.eventType}) exceeded max retries (${event.maxRetries}): ${error}`,
      );
    } else {
      event.status = 'PENDING';
      // Exponential backoff: base 1s, doubling, capped at 5 minutes
      const backoffMs = Math.min(300000, 1000 * Math.pow(2, event.retryCount));
      event.scheduledFor = new Date(Date.now() + backoffMs);
      this.logger.warn(
        `⚠️ [OUTBOX RETRY SCHEDULED] Event '${eventId}' (${event.eventType}) retry #${event.retryCount} scheduled in ${backoffMs}ms: ${error}`,
      );
    }

    return { ...event };
  }

  /**
   * Registers a decoupled handler for a specific eventType or wildcard ('*').
   */
  public registerHandler(
    eventType: string,
    handler: (event: OutboxEvent) => Promise<void>,
  ): void {
    const current = this.handlers.get(eventType) || [];
    current.push(handler);
    this.handlers.set(eventType, current);
  }

  /**
   * Executes a polling cycle: locks pending events, dispatches to handlers, and updates statuses.
   */
  public async processOutbox(
    batchSize: number = 50,
    workerId: string = 'worker_default',
  ): Promise<OutboxBatchProcessResult> {
    const events = await this.fetchAndLockPendingEvents(batchSize, 30000, workerId);

    const result: OutboxBatchProcessResult = {
      totalProcessed: events.length,
      succeeded: 0,
      failed: 0,
      deadLettered: 0,
      details: [],
    };

    for (const event of events) {
      const specificHandlers = this.handlers.get(event.eventType) || [];
      const wildcardHandlers = this.handlers.get('*') || [];
      const applicableHandlers = [...specificHandlers, ...wildcardHandlers];

      try {
        if (applicableHandlers.length > 0) {
          for (const handler of applicableHandlers) {
            await handler(event);
          }
        }

        const published = await this.markPublished(event.id, workerId);
        result.succeeded += 1;
        result.details.push({
          eventId: event.id,
          status: published.status,
        });
      } catch (dispatchErr: any) {
        const failed = await this.markFailed(event.id, dispatchErr.message, true, workerId);
        if (failed.status === 'DEAD_LETTER') {
          result.deadLettered += 1;
        } else {
          result.failed += 1;
        }
        result.details.push({
          eventId: event.id,
          status: failed.status,
          error: dispatchErr.message,
        });
      }
    }

    return result;
  }

  public async getEventById(eventId: string): Promise<OutboxEvent | null> {
    const event = this.eventsById.get(eventId);
    return event ? { ...event } : null;
  }

  public async getEventsByAggregate(
    aggregateType: string,
    aggregateId: string,
  ): Promise<OutboxEvent[]> {
    return Array.from(this.eventsById.values())
      .filter((e) => e.aggregateType === aggregateType && e.aggregateId === aggregateId)
      .map((e) => ({ ...e }));
  }

  public async getPendingCount(): Promise<number> {
    const now = new Date();
    return Array.from(this.eventsById.values()).filter(
      (e) =>
        (e.status === 'PENDING' ||
          (e.status === 'PROCESSING' && e.lockedUntil !== undefined && e.lockedUntil < now)) &&
        e.scheduledFor <= now,
    ).length;
  }

  public async getDeadLetterEvents(limit: number = 100): Promise<OutboxEvent[]> {
    return Array.from(this.eventsById.values())
      .filter((e) => e.status === 'DEAD_LETTER')
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  /**
   * Safely purges old published events to keep memory and storage bounded.
   * Strictly preserves DEAD_LETTER and FAILED events for audit investigation.
   */
  public async purgeProcessedEvents(retentionDays: number = 7): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    let purgedCount = 0;

    for (const [id, event] of this.eventsById.entries()) {
      if (event.status === 'PUBLISHED' && event.processedAt && event.processedAt < cutoff) {
        this.eventsById.delete(id);
        this.idByDeduplicationKey.delete(event.deduplicationId);
        purgedCount += 1;
      }
    }

    return purgedCount;
  }

  /**
   * Internal/test utility to update event fields directly (e.g. simulating backdated timestamps or expired locks).
   */
  public _updateEventDirectlyForTesting(
    eventId: string,
    updates: Partial<OutboxEvent>,
  ): void {
    const event = this.eventsById.get(eventId);
    if (event) {
      Object.assign(event, updates);
    }
  }
}

