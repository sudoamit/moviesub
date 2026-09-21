import { AlertIdempotencyService } from '../alert-idempotency.service';
import { AlertsService } from '../alerts.service';
import { ISignalSetup, SignalGrade, SignalState, Direction, TradeAlertPayload, OutboxEvent } from '@quant/shared';

describe('Phase 20 — Alert Idempotency & Delivery Ledger', () => {
  let idempotencyService: AlertIdempotencyService;
  let alertsService: AlertsService;

  let mockPrisma: any;
  let mockTelegram: any;
  let mockWebhook: any;
  let mockRateLimiter: any;
  let mockSignalsService: any;
  let mockOutboxService: any;

  beforeEach(() => {
    idempotencyService = new AlertIdempotencyService();

    mockPrisma = {
      alert: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'rule-tg-1',
            channel: 'TELEGRAM',
            target: '-1001928374',
            minScore: 75,
            minGrade: 'A',
            isActive: true,
          },
          {
            id: 'rule-wh-1',
            channel: 'WEBHOOK',
            target: 'https://discord.com/api/webhooks/123/xyz',
            minScore: 75,
            minGrade: 'A',
            isActive: true,
          },
        ]),
        findUnique: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({ id: 'user-admin' }),
      },
    };

    mockTelegram = {
      dispatchAlert: jest.fn().mockResolvedValue({ success: true, messageId: 'tg_msg_999' }),
      dispatchTradeAlert: jest.fn().mockResolvedValue({ success: true, messageId: 'tg_trade_888' }),
    };

    mockWebhook = {
      dispatchWebhook: jest.fn().mockResolvedValue({ success: true, status: 200 }),
      dispatchTradeAlert: jest.fn().mockResolvedValue({ success: true, status: 200 }),
    };

    mockRateLimiter = {
      canDispatch: jest.fn().mockResolvedValue({ allowed: true }),
      recordDispatch: jest.fn().mockResolvedValue(undefined),
    };

    mockSignalsService = {
      generateSignalForSymbol: jest.fn(),
    };

    mockOutboxService = {
      registerHandler: jest.fn(),
    };

    alertsService = new AlertsService(
      mockPrisma,
      mockTelegram,
      mockWebhook,
      mockRateLimiter,
      mockSignalsService,
      idempotencyService,
      mockOutboxService,
    );
  });

  describe('1. Core Idempotency Invariant: eventId vs positionId', () => {
    it('should deduplicate strictly by eventId: duplicate retry must be suppressed', async () => {
      const eventId = 'evt_trade_entry_1001';
      const channel = 'TELEGRAM';
      const target = '-1001928374';

      // First attempt: should succeed claiming
      const claim1 = await idempotencyService.claimDispatch(eventId, channel, target);
      expect(claim1.canDispatch).toBe(true);
      expect(claim1.existingRecord?.status).toBe('IN_FLIGHT');

      // Record successful delivery
      const delivered = await idempotencyService.recordDelivered(eventId, channel, target, 'msg_1001');
      expect(delivered.status).toBe('DELIVERED');
      expect(delivered.messageId).toBe('msg_1001');

      // Second attempt (retry of same eventId): MUST be suppressed
      const claim2 = await idempotencyService.claimDispatch(eventId, channel, target);
      expect(claim2.canDispatch).toBe(false);
      expect(claim2.reason).toBe('DUPLICATE_DELIVERED');
      expect(claim2.existingRecord?.status).toBe('DELIVERED');
    });

    it('should ALLOW multiple distinct events for the SAME positionId', async () => {
      const positionId = 'pos_nifty_feb_24000_ce';
      const channel = 'TELEGRAM';
      const target = '-1001928374';

      // Event 1: POSITION_OPENED
      const openEventId = 'evt_open_2001';
      const openClaim = await idempotencyService.claimDispatch(openEventId, channel, target);
      expect(openClaim.canDispatch).toBe(true);
      await idempotencyService.recordDelivered(openEventId, channel, target, 'msg_open');

      // Event 2: TP1_REACHED (same positionId, different eventId) -> MUST NOT be suppressed
      const tp1EventId = 'evt_tp1_2002';
      const tp1Claim = await idempotencyService.claimDispatch(tp1EventId, channel, target);
      expect(tp1Claim.canDispatch).toBe(true);
      await idempotencyService.recordDelivered(tp1EventId, channel, target, 'msg_tp1');

      // Event 3: POSITION_CLOSED (same positionId, different eventId) -> MUST NOT be suppressed
      const closeEventId = 'evt_close_2003';
      const closeClaim = await idempotencyService.claimDispatch(closeEventId, channel, target);
      expect(closeClaim.canDispatch).toBe(true);
      await idempotencyService.recordDelivered(closeEventId, channel, target, 'msg_close');

      // But retry of tp1EventId -> MUST be suppressed
      const tp1RetryClaim = await idempotencyService.claimDispatch(tp1EventId, channel, target);
      expect(tp1RetryClaim.canDispatch).toBe(false);
      expect(tp1RetryClaim.reason).toBe('DUPLICATE_DELIVERED');
    });
  });

  describe('2. In-Flight Concurrency Lease & Stale Recovery', () => {
    it('should reject simultaneous concurrent worker claiming same eventId on same channel', async () => {
      const eventId = 'evt_concurrent_3001';
      const channel = 'WEBHOOK';
      const target = 'https://webhook.site/test';

      // Worker 1 claims
      const claimW1 = await idempotencyService.claimDispatch(eventId, channel, target, 60, 'worker-alpha');
      expect(claimW1.canDispatch).toBe(true);

      // Worker 2 attempts claiming while Worker 1 is in-flight
      const claimW2 = await idempotencyService.claimDispatch(eventId, channel, target, 60, 'worker-beta');
      expect(claimW2.canDispatch).toBe(false);
      expect(claimW2.reason).toBe('ALREADY_IN_FLIGHT');
      expect(claimW2.existingRecord?.claimedBy).toBe('worker-alpha');
    });

    it('should reclaim stale expired in-flight lease when worker crashes', async () => {
      const eventId = 'evt_stale_3002';
      const channel = 'TELEGRAM';
      const target = 'chat-999';

      // Inject backdated expired in-flight claim
      idempotencyService._setRecordForTesting({
        id: 'deliv_stale',
        eventId,
        channel,
        target,
        status: 'IN_FLIGHT',
        claimedBy: 'crashed-worker',
        claimedUntil: new Date(Date.now() - 5000), // 5s in past
        createdAt: new Date(Date.now() - 60000),
      });

      // New worker should reclaim the lease
      const reclaim = await idempotencyService.claimDispatch(eventId, channel, target, 60, 'recovery-worker');
      expect(reclaim.canDispatch).toBe(true);
      expect(reclaim.existingRecord?.claimedBy).toBe('recovery-worker');
    });

    it('should release lock upon failure to allow subsequent retry', async () => {
      const eventId = 'evt_fail_retry_3003';
      const channel = 'TELEGRAM';
      const target = 'chat-999';

      const claim1 = await idempotencyService.claimDispatch(eventId, channel, target);
      expect(claim1.canDispatch).toBe(true);

      // Record failure (e.g. network dropped)
      await idempotencyService.recordFailed(eventId, channel, target, 'HTTP 504 Gateway Timeout');

      // Subsequent retry should be allowed because status is FAILED, not DELIVERED or IN_FLIGHT
      const claimRetry = await idempotencyService.claimDispatch(eventId, channel, target);
      expect(claimRetry.canDispatch).toBe(true);
    });
  });

  describe('3. Multi-Channel & Target Independence', () => {
    it('should allow independent delivery to Telegram and Webhook for same eventId', async () => {
      const eventId = 'evt_multichannel_4001';
      const tgTarget = 'chat-111';
      const whTarget = 'https://webhook.site/hook';

      // Claim Telegram
      const tgClaim = await idempotencyService.claimDispatch(eventId, 'TELEGRAM', tgTarget);
      expect(tgClaim.canDispatch).toBe(true);
      await idempotencyService.recordDelivered(eventId, 'TELEGRAM', tgTarget, 'tg_4001');

      // Webhook should STILL be able to claim for same eventId
      const whClaim = await idempotencyService.claimDispatch(eventId, 'WEBHOOK', whTarget);
      expect(whClaim.canDispatch).toBe(true);
      await idempotencyService.recordDelivered(eventId, 'WEBHOOK', whTarget, 'wh_4001');

      // Now both are delivered, any retry to either channel is suppressed
      const tgRetry = await idempotencyService.claimDispatch(eventId, 'TELEGRAM', tgTarget);
      expect(tgRetry.canDispatch).toBe(false);

      const whRetry = await idempotencyService.claimDispatch(eventId, 'WEBHOOK', whTarget);
      expect(whRetry.canDispatch).toBe(false);

      // Verify delivery query
      const deliveries = await idempotencyService.getDeliveriesForEvent(eventId);
      expect(deliveries.length).toBe(2);
      expect(deliveries.map((d) => d.channel).sort()).toEqual(['TELEGRAM', 'WEBHOOK']);
    });
  });

  describe('4. AlertsService.processSignalAlert Idempotency', () => {
    const dummySignal: ISignalSetup = {
      id: 'sig_nifty_setup_5001',
      symbol: 'NIFTY',
      timeframe: '15m',
      direction: Direction.BULLISH,
      state: SignalState.ACTIVE,
      grade: SignalGrade.A,
      score: 85,
      entryZone: { min: 24000, max: 24050, optimal: 24025 },
      stopLoss: 23950,
      takeProfits: { tp1: 24150, tp2: 24250, tp3: 24350 },
      riskRewardRatios: { rr1: 1.67, rr2: 3.0, rr3: 4.33 },
      reasoning: {
        htfStructure: 'Bullish',
        liquidityReason: 'SSL swept',
        triggerReason: 'Bullish OB mitigation',
        invalidationReason: 'Close below 23950',
        confirmedChecklist: ['Order block rejection', 'FVG retest'],
        summary: 'High probability long setup',
      },
      scoreBreakdown: {
        htfBias: 10,
        liquiditySweep: 10,
        bos: 10,
        fvg: 10,
        orderBlock: 10,
        displacement: 10,
        volumeConfirmation: 10,
        premiumDiscount: 5,
        riskReward: 5,
        indicatorAlignment: 5,
        totalScore: 85,
        grade: SignalGrade.A,
      },
      canonicalCandleTime: 1726910000000,
    };

    it('should dispatch on first call and suppress on retry for same signal eventId', async () => {
      // First dispatch
      const res1 = await alertsService.processSignalAlert(dummySignal, 'evt_sig_unique_1');
      expect(res1.dispatched).toBe(2); // TG and Webhook
      expect(res1.suppressed).toBe(0);
      expect(mockTelegram.dispatchAlert).toHaveBeenCalledTimes(1);
      expect(mockWebhook.dispatchWebhook).toHaveBeenCalledTimes(1);

      // Second dispatch (retry of same eventId)
      const res2 = await alertsService.processSignalAlert(dummySignal, 'evt_sig_unique_1');
      expect(res2.dispatched).toBe(0);
      expect(res2.suppressed).toBe(2); // Both suppressed
      // Dispatchers should NOT be invoked again
      expect(mockTelegram.dispatchAlert).toHaveBeenCalledTimes(1);
      expect(mockWebhook.dispatchWebhook).toHaveBeenCalledTimes(1);
    });

    it('should derive deterministic eventId when not provided and prevent re-dispatch', async () => {
      const res1 = await alertsService.processSignalAlert(dummySignal);
      expect(res1.dispatched).toBe(2);
      expect(res1.eventId).toBe('sig_nifty_setup_5001');

      // Call again without eventId (same signal)
      const res2 = await alertsService.processSignalAlert(dummySignal);
      expect(res2.dispatched).toBe(0);
      expect(res2.suppressed).toBe(2);
    });
  });

  describe('5. AlertsService.processTradeAlert Lifecycle Idempotency', () => {
    const baseTradePayload: TradeAlertPayload = {
      eventId: 'evt_trade_open_6001',
      eventType: 'POSITION_OPENED',
      positionId: 'pos_btc_777',
      symbol: 'BTCUSDT',
      direction: 'BUY',
      quantity: 0.5,
      price: 65000,
      timestamp: new Date(),
    };

    it('should dispatch trade alert and suppress retries of same eventId', async () => {
      const res1 = await alertsService.processTradeAlert(baseTradePayload);
      expect(res1.dispatched).toBe(2);
      expect(res1.suppressed).toBe(0);
      expect(mockTelegram.dispatchTradeAlert).toHaveBeenCalledTimes(1);
      expect(mockWebhook.dispatchTradeAlert).toHaveBeenCalledTimes(1);

      // Re-dispatching same eventId
      const res2 = await alertsService.processTradeAlert(baseTradePayload);
      expect(res2.dispatched).toBe(0);
      expect(res2.suppressed).toBe(2);
      expect(mockTelegram.dispatchTradeAlert).toHaveBeenCalledTimes(1);
      expect(mockWebhook.dispatchTradeAlert).toHaveBeenCalledTimes(1);
    });

    it('should allow position exit alert on SAME positionId with different eventId', async () => {
      // 1. Position Open
      await alertsService.processTradeAlert(baseTradePayload);

      // 2. Position Close on SAME positionId
      const closePayload: TradeAlertPayload = {
        eventId: 'evt_trade_close_6002',
        eventType: 'POSITION_CLOSED',
        positionId: 'pos_btc_777', // Identical positionId!
        symbol: 'BTCUSDT',
        direction: 'SELL',
        quantity: 0.5,
        price: 68000,
        realizedPnL: 1500,
        reason: 'TP2 Reached',
        timestamp: new Date(),
      };

      const resClose = await alertsService.processTradeAlert(closePayload);
      expect(resClose.dispatched).toBe(2);
      expect(resClose.suppressed).toBe(0);
      expect(mockTelegram.dispatchTradeAlert).toHaveBeenCalledTimes(2); // 1 open + 1 close
      expect(mockWebhook.dispatchTradeAlert).toHaveBeenCalledTimes(2); // 1 open + 1 close
    });
  });

  describe('6. Outbox Integration & Handler Registration', () => {
    it('should register handlers on module init and process outbox events idempotently', async () => {
      alertsService.onModuleInit();
      expect(mockOutboxService.registerHandler).toHaveBeenCalledWith('POSITION_OPENED', expect.any(Function));
      expect(mockOutboxService.registerHandler).toHaveBeenCalledWith('POSITION_CLOSED', expect.any(Function));

      const outboxEvent: OutboxEvent = {
        id: 'outbox_evt_7001',
        aggregateType: 'POSITION',
        aggregateId: 'pos_sol_888',
        eventType: 'POSITION_OPENED',
        payload: {
          symbol: 'SOLUSDT',
          direction: 'BUY',
          quantity: 10,
          price: 150,
          positionId: 'pos_sol_888',
        },
        deduplicationId: 'dedup_outbox_7001',
        correlationId: 'corr_7001',
        status: 'PROCESSING',
        retryCount: 0,
        maxRetries: 5,
        scheduledFor: new Date(),
        createdAt: new Date(),
      };

      // Handle outbox event first time
      await alertsService.handleOutboxEvent(outboxEvent);
      expect(mockTelegram.dispatchTradeAlert).toHaveBeenCalledTimes(1);

      // Outbox retries the same event (e.g. background worker replay)
      await alertsService.handleOutboxEvent(outboxEvent);
      // Telegram dispatcher should still have been called only once
      expect(mockTelegram.dispatchTradeAlert).toHaveBeenCalledTimes(1);
    });
  });
});
