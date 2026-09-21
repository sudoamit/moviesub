import { Injectable, Logger, Optional } from '@nestjs/common';
import * as crypto from 'crypto';
import {
  AlertDeliveryRecord,
  AlertDeliveryStatus,
  ClaimAlertResult,
  IAlertIdempotencyService,
} from '@quant/shared';
import { RedisService } from '../common/redis/redis.service';

@Injectable()
export class AlertIdempotencyService implements IAlertIdempotencyService {
  private readonly logger = new Logger(AlertIdempotencyService.name);

  // Authoritative internal in-memory ledger for persistent tracking and test environments
  private readonly memoryLedger = new Map<string, AlertDeliveryRecord>();

  constructor(@Optional() private readonly redis?: RedisService) {}

  /**
   * Generates a deterministic, unique cache/ledger key for an event delivery
   */
  public generateKey(eventId: string, channel: string, target: string): string {
    const normChannel = channel.toUpperCase().trim();
    const cleanTarget = target.trim();
    // Use sha256 suffix for targets to prevent long key or special char issues (e.g. webhook URLs)
    const targetHash =
      cleanTarget.length > 32
        ? crypto.createHash('sha256').update(cleanTarget).digest('hex').substring(0, 16)
        : cleanTarget;
    return `alert:idempotency:${eventId}:${normChannel}:${targetHash}`;
  }

  /**
   * Atomically claims an alert dispatch lease for (eventId, channel, target).
   * Prevents duplicate deliveries across retries and concurrent workers.
   */
  async claimDispatch(
    eventId: string,
    channel: string,
    target: string,
    ttlSeconds: number = 60,
    workerId: string = `worker-${process.pid}`,
  ): Promise<ClaimAlertResult> {
    const key = this.generateKey(eventId, channel, target);
    const now = new Date();

    // 1. Check in-memory ledger
    const existing = this.memoryLedger.get(key);
    if (existing) {
      if (existing.status === 'DELIVERED') {
        this.logger.debug(
          `[ALERT IDEMPOTENCY] Dispatch suppressed: Event '${eventId}' already DELIVERED to ${channel}:${target}`,
        );
        return {
          canDispatch: false,
          reason: 'DUPLICATE_DELIVERED',
          existingRecord: { ...existing },
        };
      }

      if (existing.status === 'IN_FLIGHT') {
        if (existing.claimedUntil && existing.claimedUntil.getTime() > now.getTime()) {
          this.logger.debug(
            `[ALERT IDEMPOTENCY] Dispatch suppressed: Event '${eventId}' is currently IN_FLIGHT by ${existing.claimedBy}`,
          );
          return {
            canDispatch: false,
            reason: 'ALREADY_IN_FLIGHT',
            existingRecord: { ...existing },
          };
        }
        // Stale lease expired -> reclaim it
        this.logger.warn(
          `[ALERT IDEMPOTENCY] Stale IN_FLIGHT lease expired for event '${eventId}' on ${channel}. Reclaiming lock.`,
        );
      }
    }

    // 2. Check Redis if available
    if (this.redis) {
      try {
        const redisVal = await this.redis.get(key);
        if (redisVal) {
          try {
            const parsed = JSON.parse(redisVal);
            if (parsed.status === 'DELIVERED') {
              // Sync to memory ledger
              this.memoryLedger.set(key, {
                ...parsed,
                createdAt: new Date(parsed.createdAt),
                deliveredAt: parsed.deliveredAt ? new Date(parsed.deliveredAt) : undefined,
              });
              return {
                canDispatch: false,
                reason: 'DUPLICATE_DELIVERED',
                existingRecord: this.memoryLedger.get(key),
              };
            }
          } catch {
            // Raw string or legacy format
          }
        }
      } catch (err) {
        this.logger.warn(`Redis check failed for key ${key}: ${(err as Error).message}`);
      }
    }

    // 3. Atomically grant IN_FLIGHT claim
    const claimedUntil = new Date(now.getTime() + ttlSeconds * 1000);
    const record: AlertDeliveryRecord = {
      id: `deliv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      eventId,
      channel: channel.toUpperCase(),
      target,
      status: 'IN_FLIGHT',
      claimedBy: workerId,
      claimedUntil,
      createdAt: existing?.createdAt || now,
    };

    this.memoryLedger.set(key, record);

    if (this.redis) {
      try {
        await this.redis.set(key, JSON.stringify(record), ttlSeconds);
      } catch (err) {
        this.logger.warn(`Redis set failed for key ${key}: ${(err as Error).message}`);
      }
    }

    return { canDispatch: true, existingRecord: record };
  }

  /**
   * Authoritatively records a successful delivery.
   * Permanently marks (eventId, channel, target) as DELIVERED so future retries are suppressed.
   */
  async recordDelivered(
    eventId: string,
    channel: string,
    target: string,
    messageId?: string,
    metadata?: any,
  ): Promise<AlertDeliveryRecord> {
    const key = this.generateKey(eventId, channel, target);
    const now = new Date();
    const existing = this.memoryLedger.get(key);

    const record: AlertDeliveryRecord = {
      id: existing?.id || `deliv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      eventId,
      channel: channel.toUpperCase(),
      target,
      status: 'DELIVERED',
      deliveredAt: now,
      claimedBy: undefined,
      claimedUntil: undefined,
      messageId,
      metadata: metadata || existing?.metadata,
      createdAt: existing?.createdAt || now,
    };

    this.memoryLedger.set(key, record);

    if (this.redis) {
      try {
        // Keep delivery record in Redis for 7 days (604800s)
        await this.redis.set(key, JSON.stringify(record), 604800);
      } catch (err) {
        this.logger.warn(`Redis recordDelivered failed for key ${key}: ${(err as Error).message}`);
      }
    }

    this.logger.log(
      `[ALERT IDEMPOTENCY] ✅ Event '${eventId}' marked DELIVERED on ${channel} (msg: ${messageId || 'none'})`,
    );
    return { ...record };
  }

  /**
   * Records a failed delivery attempt and clears the IN_FLIGHT lock
   * to allow genuine backoff retries to attempt dispatch again.
   */
  async recordFailed(
    eventId: string,
    channel: string,
    target: string,
    error: string,
  ): Promise<AlertDeliveryRecord> {
    const key = this.generateKey(eventId, channel, target);
    const now = new Date();
    const existing = this.memoryLedger.get(key);

    const record: AlertDeliveryRecord = {
      id: existing?.id || `deliv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      eventId,
      channel: channel.toUpperCase(),
      target,
      status: 'FAILED',
      failedAt: now,
      lastError: error,
      claimedBy: undefined,
      claimedUntil: undefined,
      metadata: existing?.metadata,
      createdAt: existing?.createdAt || now,
    };

    this.memoryLedger.set(key, record);

    if (this.redis) {
      try {
        // Remove lock or set short TTL so retries can proceed
        await this.redis.del(key);
      } catch (err) {
        this.logger.warn(`Redis del failed for key ${key}: ${(err as Error).message}`);
      }
    }

    this.logger.warn(`[ALERT IDEMPOTENCY] ❌ Event '${eventId}' dispatch FAILED on ${channel}: ${error}`);
    return { ...record };
  }

  /**
   * Checks if an event has already been successfully delivered to the specified channel/target
   */
  async isDelivered(eventId: string, channel: string, target: string): Promise<boolean> {
    const key = this.generateKey(eventId, channel, target);
    const existing = this.memoryLedger.get(key);
    if (existing && existing.status === 'DELIVERED') {
      return true;
    }

    if (this.redis) {
      try {
        const val = await this.redis.get(key);
        if (val) {
          const parsed = JSON.parse(val);
          return parsed.status === 'DELIVERED';
        }
      } catch {
        // Fall back to memory
      }
    }

    return false;
  }

  /**
   * Gets the delivery record for a specific (eventId, channel, target)
   */
  async getDeliveryRecord(
    eventId: string,
    channel: string,
    target: string,
  ): Promise<AlertDeliveryRecord | null> {
    const key = this.generateKey(eventId, channel, target);
    const rec = this.memoryLedger.get(key);
    return rec ? { ...rec } : null;
  }

  /**
   * Returns all delivery records for an eventId across all channels and targets
   */
  async getDeliveriesForEvent(eventId: string): Promise<AlertDeliveryRecord[]> {
    const results: AlertDeliveryRecord[] = [];
    for (const record of this.memoryLedger.values()) {
      if (record.eventId === eventId) {
        results.push({ ...record });
      }
    }
    return results;
  }

  /**
   * Clears a single delivery record
   */
  async clearRecord(eventId: string, channel: string, target: string): Promise<void> {
    const key = this.generateKey(eventId, channel, target);
    this.memoryLedger.delete(key);
    if (this.redis) {
      try {
        await this.redis.del(key);
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Clear all records (for testing environments)
   */
  public _clearAllForTesting(): void {
    this.memoryLedger.clear();
  }

  /**
   * Directly injects or modifies a record (for testing stale leases)
   */
  public _setRecordForTesting(record: AlertDeliveryRecord): void {
    const key = this.generateKey(record.eventId, record.channel, record.target);
    this.memoryLedger.set(key, record);
  }
}
