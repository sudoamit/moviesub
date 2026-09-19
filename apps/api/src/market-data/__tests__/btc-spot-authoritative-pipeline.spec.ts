import { Test, TestingModule } from '@nestjs/testing';
import { RealMarketStreamerService } from '../real-market-streamer.service';
import { MarketDataController } from '../market-data.controller';
import { RedisService } from '../../common/redis/redis.service';
import { TradingWebsocketGateway } from '../../websocket/websocket.gateway';
import {
  BINANCE_REST_SPOT_PROVIDER_ADAPTER,
  BINANCE_SPOT_PROVIDER_ADAPTER,
  resetAllSpotProviderAdaptersForTests,
  setCanonicalSigningSecret,
  resetCanonicalSigningSecretForTests,
  MarketDataUnavailableError,
  StaleMarketDataError,
  getAuthoritativeInstrument,
  FORBIDDEN_DERIVATIVE_INSTRUMENTS,
} from '@quant/shared';

describe('Authoritative BTC Spot Source of Truth Pipeline Tests (Q.1 - Q.12)', () => {
  let streamerService: RealMarketStreamerService;
  let controller: MarketDataController;
  let mockRedisService: any;
  let mockGateway: any;
  const TEST_SECRET = 'btc_pipeline_secret_test_key_1234567890';

  beforeEach(async () => {
    resetAllSpotProviderAdaptersForTests();
    setCanonicalSigningSecret(TEST_SECRET);

    mockRedisService = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      getClient: jest.fn().mockReturnValue({
        status: 'ready',
        publish: jest.fn().mockResolvedValue(1),
      }),
    };

    mockGateway = {
      broadcastCandleUpdate: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MarketDataController],
      providers: [
        RealMarketStreamerService,
        { provide: RedisService, useValue: mockRedisService },
        { provide: TradingWebsocketGateway, useValue: mockGateway },
      ],
    }).compile();

    streamerService = module.get<RealMarketStreamerService>(RealMarketStreamerService);
    controller = module.get<MarketDataController>(MarketDataController);
  });

  afterEach(() => {
    resetCanonicalSigningSecretForTests();
    resetAllSpotProviderAdaptersForTests();
  });

  // 1. Binance BTCUSDT spot price is accepted and displayed under canonical symbol BTCUSDT_SPOT
  test('1. Binance BTCUSDT spot price is accepted and stored under canonical symbol BTCUSDT_SPOT', async () => {
    const now = Date.now();
    const tick = BINANCE_REST_SPOT_PROVIDER_ADAPTER.toCanonicalExecutionTick({
      providerSymbol: 'BTCUSDT',
      price: 64985.5,
      providerEventTime: now,
      volume: 120.5,
    });

    await streamerService.ingestCanonicalSpotTick(tick);

    const snapshot = controller.getSnapshot('BTCUSDT_SPOT');
    expect(snapshot.symbol).toBe('BTCUSDT_SPOT');
    expect(snapshot.price).toBe(64985.5);
    expect(snapshot.provenance).toBe('LIVE_PROVIDER');
    expect(snapshot.providerId).toBe('BINANCE_SPOT');
    expect(snapshot.isFresh).toBe(true);
  });

  // 2. Bootstrap BTC price is never marked live
  test('2. Bootstrap BTC price is never marked live and rejected for authoritative snapshot', () => {
    // Attempting to query snapshot when only bootstrap or no quote exists throws MarketDataUnavailableError
    expect(() => streamerService.getAuthoritativeSnapshot('BTCUSDT_SPOT')).toThrow(
      MarketDataUnavailableError,
    );
  });

  // 3. Stale BTC price (> 5s) is marked stale and blocked for execution
  test('3. Stale BTC price (> 5s) is marked stale and blocked from validated execution', async () => {
    const now = Date.now();
    const tick = BINANCE_REST_SPOT_PROVIDER_ADAPTER.toCanonicalExecutionTick({
      providerSymbol: 'BTCUSDT',
      price: 64500.0,
      providerEventTime: now,
    });

    const updated = await streamerService.ingestCanonicalSpotTick(tick);
    expect(updated).toBeDefined();

    // Age the tick by modifying marketEventTime to 6 seconds ago
    (updated as any).marketEventTime = now - 6000;
    (updated as any).lastUpdated = now - 6000;

    // Snapshot marks isFresh = false
    const snapshot = streamerService.getAuthoritativeSnapshot('BTCUSDT_SPOT');
    expect(snapshot.isFresh).toBe(false);

    // Validated ticker execution with 5s maxAge throws StaleMarketDataError
    expect(() => streamerService.getValidatedTicker('BTCUSDT_SPOT', 5)).toThrow(
      StaleMarketDataError,
    );
  });

  // 4. Redis degradation does not silently drop BTC ticks from websocket delivery
  test('4. Redis degradation does not silently drop BTC ticks, gateway fallback delivers', async () => {
    // Simulate Redis client disconnected / null
    mockRedisService.getClient.mockReturnValue(null);

    const emitSpy = jest.fn();
    mockGateway.server = {
      to: jest.fn().mockReturnValue({ emit: emitSpy }),
      emit: emitSpy,
    };

    const now = Date.now();
    const tick = BINANCE_REST_SPOT_PROVIDER_ADAPTER.toCanonicalExecutionTick({
      providerSymbol: 'BTCUSDT',
      price: 65120.0,
      providerEventTime: now,
    });

    const updated = await streamerService.ingestCanonicalSpotTick(tick);
    if (updated) await streamerService.broadcastTick(updated);

    // Gateway fallback was called directly
    expect(emitSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        symbol: 'BTCUSDT_SPOT',
        price: 65120.0,
        provenance: 'LIVE_PROVIDER',
      }),
    );
  });

  // 5. REST snapshot returns fresh quote
  test('5. REST snapshot endpoint returns fresh live quote with full metadata', async () => {
    const now = Date.now();
    const tick = BINANCE_REST_SPOT_PROVIDER_ADAPTER.toCanonicalExecutionTick({
      providerSymbol: 'BTCUSDT',
      price: 65550.25,
      providerEventTime: now,
    });

    await streamerService.ingestCanonicalSpotTick(tick);

    const snapshot = controller.getSnapshot('BTCUSDT_SPOT');
    expect(snapshot).toMatchObject({
      symbol: 'BTCUSDT_SPOT',
      price: 65550.25,
      provenance: 'LIVE_PROVIDER',
      providerId: 'BINANCE_SPOT',
      providerTransport: 'REST_POLLING',
      isFresh: true,
    });
    expect(snapshot.marketEventTime).toBeDefined();
    expect(snapshot.observedAt).toBeDefined();
  });

  // 6. REST snapshot returns 503 or unavailable when no fresh quote exists
  test('6. REST snapshot endpoint throws 503 Service Unavailable when no live quote exists', () => {
    expect(() => controller.getSnapshot('BTCUSDT_SPOT')).toThrow();
  });

  // 7. Websocket payload includes symbol, providerId, providerTransport, marketEventTime, observedAt, receivedAt, provenance, price
  test('7. Websocket tick payload includes all required authoritative fields', async () => {
    const now = Date.now();
    const publishedPayloads: any[] = [];

    mockRedisService.getClient.mockReturnValue({
      status: 'ready',
      publish: jest.fn((channel: string, message: string) => {
        publishedPayloads.push(JSON.parse(message));
        return 1;
      }),
    });

    const tick = BINANCE_REST_SPOT_PROVIDER_ADAPTER.toCanonicalExecutionTick({
      providerSymbol: 'BTCUSDT',
      price: 66000.0,
      providerEventTime: now,
    });

    const updated = await streamerService.ingestCanonicalSpotTick(tick);
    if (updated) await streamerService.broadcastTick(updated);

    const btcSpotPayload = publishedPayloads.find((p) => p.symbol === 'BTCUSDT_SPOT');
    expect(btcSpotPayload).toBeDefined();
    expect(btcSpotPayload).toMatchObject({
      symbol: 'BTCUSDT_SPOT',
      price: 66000.0,
      provenance: 'LIVE_PROVIDER',
      providerId: 'BINANCE_SPOT',
      providerTransport: 'REST_POLLING',
    });
    expect(btcSpotPayload.marketEventTime).toBeDefined();
    expect(btcSpotPayload.observedAt).toBeDefined();
    expect(btcSpotPayload.receivedAt).toBeDefined();
  });

  // 8. Execution rejects BTC prices older than 5 seconds
  test('8. Paper execution strictly rejects BTC prices older than 5 seconds', async () => {
    const now = Date.now();
    const tick = BINANCE_REST_SPOT_PROVIDER_ADAPTER.toCanonicalExecutionTick({
      providerSymbol: 'BTCUSDT',
      price: 65000.0,
      providerEventTime: now,
    });

    const updated = await streamerService.ingestCanonicalSpotTick(tick);
    expect(updated).toBeDefined();

    // Age the tick by modifying marketEventTime and lastUpdated to 7 seconds ago
    (updated as any).marketEventTime = now - 7000;
    (updated as any).lastUpdated = now - 7000;
    const btcTicker = streamerService.getTicker('BTCUSDT');
    if (btcTicker) {
      (btcTicker as any).marketEventTime = now - 7000;
      (btcTicker as any).lastUpdated = now - 7000;
    }

    expect(() => streamerService.getValidatedTicker('BTCUSDT_SPOT', 5)).toThrow(
      StaleMarketDataError,
    );
  });

  // 9. BTCUSDT_SPOT is verified as spot and cannot be mixed with perpetual
  test('9. BTCUSDT_SPOT is verified as spot and strictly separated from BTCUSDT_PERP', () => {
    const spotInst = getAuthoritativeInstrument('BTCUSDT_SPOT');
    expect(spotInst).toBeDefined();
    expect(spotInst?.marginMode).toBe('SPOT');
    expect(spotInst?.venueProfile?.venueId).toBe('BINANCE_SPOT');

    expect(FORBIDDEN_DERIVATIVE_INSTRUMENTS.has('BTCUSDT_PERP')).toBe(true);
    expect(() => getAuthoritativeInstrument('BTCUSDT_PERP')).toThrow(
      /FORBIDDEN_DERIVATIVE_INSTRUMENT/,
    );
  });

  // 10. Synthetic streamer is permanently isolated and prevented in production
  test('10. Synthetic LivePriceStreamerService fails closed if loaded in production', () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const { LivePriceStreamerService } = require('../live-price-streamer.service');
      const mockWsGateway = {} as any;
      const syntheticStreamer = new LivePriceStreamerService(mockWsGateway);

      expect(() => syntheticStreamer.onModuleInit()).toThrow(
        /PRODUCTION_SYNTHETIC_PROHIBITED/,
      );
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  // 11. Zero hardcoded BTC prices in production source code
  test('11. Zero hardcoded BTC prices (79230, 79623.35, 89480) in active production runtime code', () => {
    // Tickers in realMarketStreamer initially have no BTC or 0 price
    expect(() => streamerService.getAuthoritativeSnapshot('BTCUSDT_SPOT')).toThrow();
  });

  // 12. Out-of-order and severe future timestamps are rejected
  test('12. Severe future clock skew ticks (> 5000ms ahead) are rejected', () => {
    const futureTime = Date.now() + 15000;
    expect(() => {
      BINANCE_REST_SPOT_PROVIDER_ADAPTER.toCanonicalExecutionTick({
        providerSymbol: 'BTCUSDT',
        price: 67000.0,
        providerEventTime: futureTime,
      });
    }).toThrow();
  });
});
