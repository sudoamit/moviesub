import {
  NSE_STREAM_OPTION_PROVIDER_ADAPTER,
  NSE_REST_OPTION_PROVIDER_ADAPTER,
  resetAllOptionProviderAdaptersForTests,
} from '../option-provider/canonical-option-provider-tick';
import {
  validateAuthoritativeExecutionQuote,
  setCanonicalSigningSecret,
  resetCanonicalSigningSecretForTests,
} from '../execution-quote-validator';

describe('AI FIX 159 — Final Transport-Specific Connection Authority', () => {
  const TEST_SECRET = 'test_secret_key_1234567890_abcdef';

  beforeEach(() => {
    resetAllOptionProviderAdaptersForTests();
    setCanonicalSigningSecret(TEST_SECRET);
    NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection();
    NSE_REST_OPTION_PROVIDER_ADAPTER.beginProviderConnection();
  });

  afterEach(() => {
    resetCanonicalSigningSecretForTests();
    resetAllOptionProviderAdaptersForTests();
  });

  test('1. stream reconnect does not change REST connection identity', () => {
    const initialRestConnection = NSE_REST_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
    const initialStreamConnection = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;

    // Reconnect stream
    const newStreamConnection = NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection();

    expect(newStreamConnection.connectionEpoch).toBe(initialStreamConnection.connectionEpoch + 1);
    expect(NSE_REST_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()).toEqual(initialRestConnection);
  });

  test('2. REST recovery does not change stream connection identity', () => {
    const initialStreamConnection = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
    const initialRestConnection = NSE_REST_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;

    // Recover REST connection
    const newRestConnection = NSE_REST_OPTION_PROVIDER_ADAPTER.beginProviderConnection();

    expect(newRestConnection.connectionEpoch).toBe(initialRestConnection.connectionEpoch + 1);
    expect(NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()).toEqual(initialStreamConnection);
  });

  test('3. stream epoch changes independently', () => {
    const streamConn1 = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
    const restConn1 = NSE_REST_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;

    NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection();
    const streamConn2 = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
    const restConn2 = NSE_REST_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;

    expect(streamConn2.connectionEpoch).toBe(streamConn1.connectionEpoch + 1);
    expect(restConn2.connectionEpoch).toBe(restConn1.connectionEpoch);
  });

  test('4. REST epoch changes independently', () => {
    const streamConn1 = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
    const restConn1 = NSE_REST_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;

    NSE_REST_OPTION_PROVIDER_ADAPTER.beginProviderConnection();
    const streamConn2 = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
    const restConn2 = NSE_REST_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;

    expect(restConn2.connectionEpoch).toBe(restConn1.connectionEpoch + 1);
    expect(streamConn2.connectionEpoch).toBe(streamConn1.connectionEpoch);
  });

  test('5. unknown providerId is rejected', () => {
    const now = Date.now();
    const quote = {
      contractSymbol: 'NIFTY26SEP25000CE',
      price: 150.5,
      marketEventTime: now,
      provenance: 'LIVE_PROVIDER',
      providerId: 'INVALID_UNSUPPORTED_PROVIDER',
      providerTransport: 'WEBSOCKET_STREAM',
      connectionEpoch: 1,
      providerInstanceId: 'inst-1',
      providerConnectionId: 'conn-1',
    };

    const res = validateAuthoritativeExecutionQuote(quote, {
      streamConnectionState: 'CONNECTED',
      isStreamConnected: true,
    });

    expect(res.valid).toBe(false);
    expect(res.errorType).toBe('UNKNOWN_PROVIDER_ID_REJECTED');
  });

  test('6. provider transport mismatch is rejected', () => {
    const now = Date.now();
    const streamConn = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;

    const quote = {
      contractSymbol: 'NIFTY26SEP25000CE',
      price: 150.5,
      marketEventTime: now,
      provenance: 'LIVE_PROVIDER',
      providerId: NSE_STREAM_OPTION_PROVIDER_ADAPTER.providerId,
      providerTransport: 'REST_POLLING', // Mismatch for NSE_OPTION_STREAM!
      connectionEpoch: streamConn.connectionEpoch,
      providerInstanceId: streamConn.providerInstanceId,
      providerConnectionId: streamConn.providerConnectionId,
    };

    const res = validateAuthoritativeExecutionQuote(quote, {
      activeStreamConnection: streamConn,
      streamConnectionState: 'CONNECTED',
      isStreamConnected: true,
    });

    expect(res.valid).toBe(false);
    expect(res.errorType).toBe('PROVIDER_TRANSPORT_MISMATCH');
  });

  test('7. same numeric epoch but different providerConnectionId is rejected', () => {
    const now = Date.now();
    const streamConn = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;

    const quote = {
      contractSymbol: 'NIFTY26SEP25000CE',
      price: 150.5,
      marketEventTime: now,
      provenance: 'LIVE_PROVIDER',
      providerId: NSE_STREAM_OPTION_PROVIDER_ADAPTER.providerId,
      providerTransport: 'WEBSOCKET_STREAM',
      connectionEpoch: streamConn.connectionEpoch,
      providerInstanceId: streamConn.providerInstanceId,
      providerConnectionId: 'different_connection_id_abc',
    };

    const res = validateAuthoritativeExecutionQuote(quote, {
      activeStreamConnection: streamConn,
      streamConnectionState: 'CONNECTED',
      isStreamConnected: true,
    });

    expect(res.valid).toBe(false);
    expect(res.errorType).toBe('EPOCH_MISMATCH');
    expect(res.reason).toContain('provider connection');
  });

  test('8. stream quote cannot validate against REST connection', () => {
    const now = Date.now();
    const restConn = NSE_REST_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;

    const streamQuote = {
      contractSymbol: 'NIFTY26SEP25000CE',
      price: 150.5,
      marketEventTime: now,
      provenance: 'LIVE_PROVIDER',
      providerId: NSE_STREAM_OPTION_PROVIDER_ADAPTER.providerId,
      providerTransport: 'WEBSOCKET_STREAM',
      connectionEpoch: restConn.connectionEpoch,
      providerInstanceId: restConn.providerInstanceId,
      providerConnectionId: restConn.providerConnectionId,
    };

    // Validating against only active REST connection authority
    const res = validateAuthoritativeExecutionQuote(streamQuote, {
      activeRestConnection: restConn,
      restHealthState: 'HEALTHY',
    });

    expect(res.valid).toBe(false);
    expect(['EPOCH_MISMATCH', 'PROVIDER_TRANSPORT_MISMATCH']).toContain(res.errorType);
  });

  test('9. REST quote cannot validate against stream connection', () => {
    const now = Date.now();
    const streamConn = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;

    const restQuote = {
      contractSymbol: 'NIFTY26SEP25000CE',
      price: 150.5,
      marketEventTime: now,
      provenance: 'LIVE_PROVIDER',
      providerId: NSE_REST_OPTION_PROVIDER_ADAPTER.providerId,
      providerTransport: 'REST_POLLING',
      connectionEpoch: streamConn.connectionEpoch,
      providerInstanceId: streamConn.providerInstanceId,
      providerConnectionId: streamConn.providerConnectionId,
    };

    // Validating against only active stream connection authority
    const res = validateAuthoritativeExecutionQuote(restQuote, {
      activeStreamConnection: streamConn,
      streamConnectionState: 'CONNECTED',
      isStreamConnected: true,
    });

    expect(res.valid).toBe(false);
    expect(['EPOCH_MISMATCH', 'PROVIDER_TRANSPORT_MISMATCH']).toContain(res.errorType);
  });

  test('10. adapter isolation ensures clean state reset across tests', () => {
    resetAllOptionProviderAdaptersForTests();
    expect(NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()).toBeNull();

    const streamConnInitial = NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection();
    expect(streamConnInitial.connectionEpoch).toBe(1);

    NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection();
    expect(NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!.connectionEpoch).toBe(2);

    resetAllOptionProviderAdaptersForTests();
    expect(NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()).toBeNull();
  });
});
