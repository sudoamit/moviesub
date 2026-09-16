import { Test, TestingModule } from '@nestjs/testing';
import { RealMarketStreamerService } from '../real-market-streamer.service';
import { RedisService } from '../../common/redis/redis.service';
import {
  NSE_STREAM_OPTION_PROVIDER_ADAPTER,
  NSE_STREAM_SPOT_PROVIDER_ADAPTER,
  BINANCE_SPOT_PROVIDER_ADAPTER,
  BINANCE_OPTION_PROVIDER_ADAPTER,
  NSE_REST_OPTION_PROVIDER_ADAPTER,
  NSE_YAHOO_REST_PROVIDER_ADAPTER,
  NSE_YAHOO_REST_SPOT_PROVIDER_ADAPTER,
  BINANCE_REST_PROVIDER_ADAPTER,
  BINANCE_REST_SPOT_PROVIDER_ADAPTER,
  resetAllOptionProviderAdaptersForTests,
  resetAllSpotProviderAdaptersForTests,
  setCanonicalSigningSecret,
  resetCanonicalSigningSecretForTests,
  ProviderRuntimeState,
} from '@quant/shared';

describe('RealMarketStreamerService — Provider-Runtime Lifecycle Atomicity & Service-Level Failure Injection', () => {
  let streamerService: RealMarketStreamerService;
  let mockRedisService: any;
  const TEST_SECRET = 'test_secret_key_streamer_atomicity_123456';

  beforeEach(async () => {
    resetAllOptionProviderAdaptersForTests();
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [RealMarketStreamerService, { provide: RedisService, useValue: mockRedisService }],
    }).compile();

    streamerService = module.get<RealMarketStreamerService>(RealMarketStreamerService);
  });

  afterEach(() => {
    resetCanonicalSigningSecretForTests();
    resetAllOptionProviderAdaptersForTests();
    resetAllSpotProviderAdaptersForTests();
  });

  describe('1. Service-Level Failure Injection & Old State Preservation', () => {
    test('A. Connection creation failure during stream reconnect leaves old ProviderRuntimeState reference and identity 100% intact', () => {
      const initialRuntime = streamerService.resolveCurrentProviderRuntime(
        'NSE_STREAM_GATEWAY',
        'WEBSOCKET_STREAM',
      );
      const initialConn = initialRuntime.currentConnection;

      // Disconnect stream first
      streamerService.handleStreamProviderDisconnect('NSE_STREAM_GATEWAY');
      const disconnectedRuntime = streamerService.resolveCurrentProviderRuntime(
        'NSE_STREAM_GATEWAY',
        'WEBSOCKET_STREAM',
      );
      expect(disconnectedRuntime.connectionState).toBe('DISCONNECTED');
      expect(disconnectedRuntime.providerConnected).toBe(false);
      expect(disconnectedRuntime.currentConnection).toEqual(initialConn);

      // Failure Injection: Mock createStreamProviderConnection to throw when minting new connection
      jest
        .spyOn(streamerService as any, 'createStreamProviderConnection')
        .mockImplementationOnce(() => {
          throw new Error('[ADAPTER_SIMULATION_FAILURE] WebSocket socket connection failed');
        });

      // Attempt reconnect -> must throw adapter error
      expect(() => {
        streamerService.handleStreamProviderReconnect('NSE_STREAM_GATEWAY');
      }).toThrow('[ADAPTER_SIMULATION_FAILURE]');

      // Verify old runtime state is 100% intact (same reference, same connection identity, state preserved)
      const afterFailureRuntime = streamerService.resolveCurrentProviderRuntime(
        'NSE_STREAM_GATEWAY',
        'WEBSOCKET_STREAM',
      );
      expect(afterFailureRuntime).toBe(disconnectedRuntime);
      expect(afterFailureRuntime.currentConnection).toBe(initialConn);
      expect(afterFailureRuntime.currentConnection.connectionEpoch).toBe(
        initialConn.connectionEpoch,
      );
      expect(afterFailureRuntime.currentConnection.providerConnectionId).toBe(
        initialConn.providerConnectionId,
      );
    });

    test('B. Connection creation failure during rotateProviderRuntime leaves old freshness store 100% intact', () => {
      const initialConn = streamerService.getCurrentStreamProviderConnection('NSE_STREAM_GATEWAY');

      // Ingest a spot tick to establish freshness under initial connection
      const spotTick = NSE_STREAM_SPOT_PROVIDER_ADAPTER.toCanonicalExecutionTick({
        providerSymbol: 'NIFTY',
        price: 24200,
        providerEventTime: Date.now() - 100,
      });
      streamerService.ingestCanonicalSpotTick(spotTick);

      // Verify freshness key exists for old connection
      const isFreshBefore = (streamerService as any).isFreshSymbolPresent(
        'WEBSOCKET_STREAM',
        'NSE_STREAM_GATEWAY',
        initialConn.providerConnectionId,
        'NIFTY',
      );
      expect(isFreshBefore).toBe(true);

      // Inject failure during connection creation
      jest
        .spyOn(streamerService as any, 'createStreamProviderConnection')
        .mockImplementationOnce(() => {
          throw new Error('[ADAPTER_SIMULATION_FAILURE] Dynamic DNS lookup failed');
        });

      expect(() => {
        (streamerService as any).rotateProviderRuntime('NSE_STREAM_GATEWAY', 'WEBSOCKET_STREAM');
      }).toThrow('[ADAPTER_SIMULATION_FAILURE]');

      // Old freshness must STILL be present
      const isFreshAfter = (streamerService as any).isFreshSymbolPresent(
        'WEBSOCKET_STREAM',
        'NSE_STREAM_GATEWAY',
        initialConn.providerConnectionId,
        'NIFTY',
      );
      expect(isFreshAfter).toBe(true);
    });

    test('C. Connection creation failure during REST health recovery leaves old REST ProviderRuntimeState 100% intact', () => {
      const initialRestRuntime = streamerService.resolveCurrentProviderRuntime(
        'NSE_REST_OPTION_PROVIDER',
        'REST_POLLING',
      );
      const initialConn = initialRestRuntime.currentConnection;

      // Mark REST provider unavailable
      streamerService.handleRestProviderUnavailable('NSE_REST_OPTION_PROVIDER');
      const unavailableRuntime = streamerService.resolveCurrentProviderRuntime(
        'NSE_REST_OPTION_PROVIDER',
        'REST_POLLING',
      );
      expect(unavailableRuntime.connectionState).toBe('DISCONNECTED');

      // Inject failure into REST connection creation
      jest
        .spyOn(streamerService as any, 'createRestProviderConnection')
        .mockImplementationOnce(() => {
          throw new Error('[ADAPTER_REST_FAILURE] HTTP 503 Service Unavailable');
        });

      // Attempt recovery to HEALTHY -> must throw
      expect(() => {
        streamerService.handleRestProviderHealthy('NSE_REST_OPTION_PROVIDER');
      }).toThrow('[ADAPTER_REST_FAILURE]');

      // Unavailable runtime must remain unchanged
      const afterFailureRestRuntime = streamerService.resolveCurrentProviderRuntime(
        'NSE_REST_OPTION_PROVIDER',
        'REST_POLLING',
      );
      expect(afterFailureRestRuntime).toBe(unavailableRuntime);
      expect(afterFailureRestRuntime.currentConnection).toBe(initialConn);
    });

    test('D. Bad connection identity returned by adapter (non-incrementing epoch) is rejected and leaves runtime intact', () => {
      const initialRuntime = streamerService.resolveCurrentProviderRuntime(
        'NSE_STREAM_GATEWAY',
        'WEBSOCKET_STREAM',
      );

      // Disconnect stream first so reconnect attempts rotation
      streamerService.handleStreamProviderDisconnect('NSE_STREAM_GATEWAY');

      // Inject invalid connection return (same epoch as initial)
      jest
        .spyOn(streamerService as any, 'createStreamProviderConnection')
        .mockImplementationOnce(() => {
          return initialRuntime.currentConnection; // Duplicate non-incrementing connection identity
        });

      expect(() => {
        streamerService.handleStreamProviderReconnect('NSE_STREAM_GATEWAY');
      }).toThrow('[INVALID_CONNECTION_ROTATION]');

      const afterRuntime = streamerService.resolveCurrentProviderRuntime(
        'NSE_STREAM_GATEWAY',
        'WEBSOCKET_STREAM',
      );
      expect(afterRuntime.currentConnection).toBe(initialRuntime.currentConnection);
    });
  });

  describe('2. Single-Step Atomic Rotation & Snapshot Integrity', () => {
    test('A. Successful stream reconnect replaces runtime state exactly once in Map with atomic RECONNECTED snapshot', () => {
      const initialRuntime = streamerService.resolveCurrentProviderRuntime(
        'NSE_STREAM_GATEWAY',
        'WEBSOCKET_STREAM',
      );
      const mapSetSpy = jest.spyOn((streamerService as any).streamRuntimeStateMap, 'set');

      // Disconnect then reconnect
      streamerService.handleStreamProviderDisconnect('NSE_STREAM_GATEWAY');
      mapSetSpy.mockClear();

      streamerService.handleStreamProviderReconnect('NSE_STREAM_GATEWAY');

      // Map.set must be called exactly once during reconnect
      expect(mapSetSpy).toHaveBeenCalledTimes(1);

      const nextRuntime = streamerService.resolveCurrentProviderRuntime(
        'NSE_STREAM_GATEWAY',
        'WEBSOCKET_STREAM',
      );
      expect(nextRuntime.connectionState).toBe('RECONNECTED');
      expect(nextRuntime.providerConnected).toBe(true);
      expect(nextRuntime.reconnectedAt).toBeGreaterThan(0);
      expect(nextRuntime.currentConnection.connectionEpoch).toBe(
        initialRuntime.currentConnection.connectionEpoch + 1,
      );
      expect(nextRuntime.currentConnection.providerConnectionId).not.toBe(
        initialRuntime.currentConnection.providerConnectionId,
      );

      // Verify health check returns true immediately
      expect(streamerService.isStreamExecutionHealthy('NSE_STREAM_GATEWAY')).toBe(true);
    });

    test('B. Shared Option and Spot provider connection identity remains 100% synchronized post-reconnect', () => {
      // 1. Initial parity check
      const streamerConn1 =
        streamerService.getCurrentStreamProviderConnection('NSE_STREAM_GATEWAY');
      const optConn1 = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const spotConn1 = NSE_STREAM_SPOT_PROVIDER_ADAPTER.getCurrentProviderConnection()!;

      expect(streamerConn1.providerConnectionId).toBe(optConn1.providerConnectionId);
      expect(streamerConn1.providerConnectionId).toBe(spotConn1.providerConnectionId);
      expect(streamerConn1.connectionEpoch).toBe(optConn1.connectionEpoch);
      expect(streamerConn1.connectionEpoch).toBe(spotConn1.connectionEpoch);

      // 2. Perform reconnect
      streamerService.handleStreamProviderDisconnect('NSE_STREAM_GATEWAY');
      streamerService.handleStreamProviderReconnect('NSE_STREAM_GATEWAY');

      const streamerConn2 =
        streamerService.getCurrentStreamProviderConnection('NSE_STREAM_GATEWAY');
      const optConn2 = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const spotConn2 = NSE_STREAM_SPOT_PROVIDER_ADAPTER.getCurrentProviderConnection()!;

      // All 3 must match the new connection identity perfectly
      expect(streamerConn2.providerConnectionId).toBe(optConn2.providerConnectionId);
      expect(streamerConn2.providerConnectionId).toBe(spotConn2.providerConnectionId);
      expect(streamerConn2.connectionEpoch).toBe(streamerConn1.connectionEpoch + 1);
      expect(streamerConn2.connectionEpoch).toBe(optConn2.connectionEpoch);
      expect(streamerConn2.connectionEpoch).toBe(spotConn2.connectionEpoch);
    });

    test('C. Old connection freshness is purged strictly AFTER successful runtime Map replacement', () => {
      const initialConn = streamerService.getCurrentStreamProviderConnection('NSE_STREAM_GATEWAY');

      // Record fresh symbol for initial connection
      const spotTick = NSE_STREAM_SPOT_PROVIDER_ADAPTER.toCanonicalExecutionTick({
        providerSymbol: 'NIFTY',
        price: 24250,
        providerEventTime: Date.now() - 100,
      });
      streamerService.ingestCanonicalSpotTick(spotTick);

      expect(
        (streamerService as any).isFreshSymbolPresent(
          'WEBSOCKET_STREAM',
          'NSE_STREAM_GATEWAY',
          initialConn.providerConnectionId,
          'NIFTY',
        ),
      ).toBe(true);

      // Perform reconnect
      streamerService.handleStreamProviderDisconnect('NSE_STREAM_GATEWAY');
      streamerService.handleStreamProviderReconnect('NSE_STREAM_GATEWAY');

      const newConn = streamerService.getCurrentStreamProviderConnection('NSE_STREAM_GATEWAY');

      // Old freshness is now purged
      expect(
        (streamerService as any).isFreshSymbolPresent(
          'WEBSOCKET_STREAM',
          'NSE_STREAM_GATEWAY',
          initialConn.providerConnectionId,
          'NIFTY',
        ),
      ).toBe(false);

      // Record tick under new connection
      const newSpotTick = NSE_STREAM_SPOT_PROVIDER_ADAPTER.toCanonicalExecutionTick({
        providerSymbol: 'NIFTY',
        price: 24260,
        providerEventTime: Date.now() - 50,
      });
      streamerService.ingestCanonicalSpotTick(newSpotTick);

      expect(
        (streamerService as any).isFreshSymbolPresent(
          'WEBSOCKET_STREAM',
          'NSE_STREAM_GATEWAY',
          newConn.providerConnectionId,
          'NIFTY',
        ),
      ).toBe(true);
    });

    test('D. Binance Direct WebSocket reconnect replaces runtime state and syncs option & spot adapters atomically', () => {
      const streamerConn1 = streamerService.getCurrentStreamProviderConnection('BINANCE_DIRECT');
      const optConn1 = BINANCE_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const spotConn1 = BINANCE_SPOT_PROVIDER_ADAPTER.getCurrentProviderConnection()!;

      expect(streamerConn1.providerConnectionId).toBe(optConn1.providerConnectionId);
      expect(streamerConn1.providerConnectionId).toBe(spotConn1.providerConnectionId);

      streamerService.handleStreamProviderDisconnect('BINANCE_DIRECT');
      streamerService.handleStreamProviderReconnect('BINANCE_DIRECT');

      const streamerConn2 = streamerService.getCurrentStreamProviderConnection('BINANCE_DIRECT');
      const optConn2 = BINANCE_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const spotConn2 = BINANCE_SPOT_PROVIDER_ADAPTER.getCurrentProviderConnection()!;

      expect(streamerConn2.providerConnectionId).toBe(optConn2.providerConnectionId);
      expect(streamerConn2.providerConnectionId).toBe(spotConn2.providerConnectionId);
      expect(streamerConn2.connectionEpoch).toBe(streamerConn1.connectionEpoch + 1);
    });
  });
});
