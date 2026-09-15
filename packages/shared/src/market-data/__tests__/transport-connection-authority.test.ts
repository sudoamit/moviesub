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

  describe('FIX 160 — Production-Hardening Release Gate Tests', () => {
    test('6. Timestamp Discipline (missing, zero, negative, NaN, future, stale, valid)', () => {
      const now = Date.now();
      const streamConn = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const baseQuote = {
        contractSymbol: 'NIFTY26SEP25000CE',
        price: 150.5,
        provenance: 'LIVE_PROVIDER',
        providerId: NSE_STREAM_OPTION_PROVIDER_ADAPTER.providerId,
        providerTransport: 'WEBSOCKET_STREAM',
        connectionEpoch: streamConn.connectionEpoch,
        providerInstanceId: streamConn.providerInstanceId,
        providerConnectionId: streamConn.providerConnectionId,
      };

      expect(validateAuthoritativeExecutionQuote({ ...baseQuote, marketEventTime: undefined }, { activeConnection: streamConn, currentTimeMs: now }).valid).toBe(false);
      expect(validateAuthoritativeExecutionQuote({ ...baseQuote, marketEventTime: 0 }, { activeConnection: streamConn, currentTimeMs: now }).valid).toBe(false);
      expect(validateAuthoritativeExecutionQuote({ ...baseQuote, marketEventTime: -1000 }, { activeConnection: streamConn, currentTimeMs: now }).valid).toBe(false);
      expect(validateAuthoritativeExecutionQuote({ ...baseQuote, marketEventTime: NaN }, { activeConnection: streamConn, currentTimeMs: now }).valid).toBe(false);
      expect(validateAuthoritativeExecutionQuote({ ...baseQuote, marketEventTime: now + 10000 }, { activeConnection: streamConn, currentTimeMs: now }).valid).toBe(false);
      expect(validateAuthoritativeExecutionQuote({ ...baseQuote, marketEventTime: now - 10000 }, { activeConnection: streamConn, currentTimeMs: now }).valid).toBe(false);
      expect(validateAuthoritativeExecutionQuote({ ...baseQuote, marketEventTime: now - 500 }, { activeConnection: streamConn, currentTimeMs: now }).valid).toBe(true);
    });

    test('7. Connection Lifecycle (Stream & REST)', () => {
      const streamConn1 = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const epochBeforeDisc = streamConn1.connectionEpoch;
      expect(NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!.connectionEpoch).toBe(epochBeforeDisc);

      const streamConn2 = NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection();
      expect(streamConn2.connectionEpoch).toBe(epochBeforeDisc + 1);
      expect(streamConn2.providerConnectionId).not.toBe(streamConn1.providerConnectionId);

      const oldQuote = {
        contractSymbol: 'NIFTY26SEP25000CE',
        price: 150.5,
        marketEventTime: Date.now(),
        provenance: 'LIVE_PROVIDER',
        providerId: NSE_STREAM_OPTION_PROVIDER_ADAPTER.providerId,
        providerTransport: 'WEBSOCKET_STREAM',
        connectionEpoch: streamConn1.connectionEpoch,
        providerInstanceId: streamConn1.providerInstanceId,
        providerConnectionId: streamConn1.providerConnectionId,
      };

      const resOld = validateAuthoritativeExecutionQuote(oldQuote, { activeConnection: streamConn2 });
      expect(resOld.valid).toBe(false);
      expect(resOld.errorType).toBe('EPOCH_MISMATCH');
    });

    test('8. Execution Path Regression Tests (A through M)', () => {
      const now = Date.now();
      const streamConn = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const restConn = NSE_REST_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;

      const validStreamQuote = {
        contractSymbol: 'NIFTY26SEP25000CE',
        price: 150.5,
        marketEventTime: now - 200,
        provenance: 'LIVE_PROVIDER',
        providerId: NSE_STREAM_OPTION_PROVIDER_ADAPTER.providerId,
        providerTransport: 'WEBSOCKET_STREAM',
        connectionEpoch: streamConn.connectionEpoch,
        providerInstanceId: streamConn.providerInstanceId,
        providerConnectionId: streamConn.providerConnectionId,
      };

      const validRestQuote = {
        contractSymbol: 'NIFTY26SEP25000CE',
        price: 150.5,
        marketEventTime: now - 200,
        provenance: 'LIVE_PROVIDER',
        providerId: NSE_REST_OPTION_PROVIDER_ADAPTER.providerId,
        providerTransport: 'REST_POLLING',
        connectionEpoch: restConn.connectionEpoch,
        providerInstanceId: restConn.providerInstanceId,
        providerConnectionId: restConn.providerConnectionId,
      };

      // A. valid stream quote -> accepted
      expect(validateAuthoritativeExecutionQuote(validStreamQuote, { activeStreamConnection: streamConn, streamConnectionState: 'CONNECTED', isStreamConnected: true, currentTimeMs: now }).valid).toBe(true);

      // B. stale stream connection -> rejected
      expect(validateAuthoritativeExecutionQuote(validStreamQuote, { activeStreamConnection: streamConn, streamConnectionState: 'DISCONNECTED', isStreamConnected: false, currentTimeMs: now }).valid).toBe(false);

      // C. valid REST quote -> accepted
      expect(validateAuthoritativeExecutionQuote(validRestQuote, { activeRestConnection: restConn, restHealthState: 'HEALTHY', currentTimeMs: now }).valid).toBe(true);

      // D. stale REST connection / UNAVAILABLE -> rejected
      expect(validateAuthoritativeExecutionQuote(validRestQuote, { activeRestConnection: restConn, restHealthState: 'UNAVAILABLE', currentTimeMs: now }).valid).toBe(false);

      // E. missing event timestamp -> rejected
      expect(validateAuthoritativeExecutionQuote({ ...validStreamQuote, marketEventTime: undefined }, { activeStreamConnection: streamConn, streamConnectionState: 'CONNECTED', isStreamConnected: true, currentTimeMs: now }).valid).toBe(false);

      // F. future event timestamp -> rejected
      expect(validateAuthoritativeExecutionQuote({ ...validStreamQuote, marketEventTime: now + 10000 }, { activeStreamConnection: streamConn, streamConnectionState: 'CONNECTED', isStreamConnected: true, currentTimeMs: now }).valid).toBe(false);

      // G. arbitrary caller-crafted LIVE_PROVIDER quote -> rejected
      expect(validateAuthoritativeExecutionQuote({ contractSymbol: 'NIFTY26SEP25000CE', price: 150.5, provenance: 'BOOTSTRAP' }, { activeStreamConnection: streamConn, streamConnectionState: 'CONNECTED', isStreamConnected: true, currentTimeMs: now }).valid).toBe(false);

      // H. forged providerId -> rejected
      expect(validateAuthoritativeExecutionQuote({ ...validStreamQuote, providerId: 'FORGED_PROVIDER' }, { activeStreamConnection: streamConn, streamConnectionState: 'CONNECTED', isStreamConnected: true, currentTimeMs: now }).valid).toBe(false);

      // I. forged providerConnectionId -> rejected
      expect(validateAuthoritativeExecutionQuote({ ...validStreamQuote, providerConnectionId: 'forged-conn-id' }, { activeStreamConnection: streamConn, streamConnectionState: 'CONNECTED', isStreamConnected: true, currentTimeMs: now }).valid).toBe(false);

      // J. forged connectionEpoch -> rejected
      expect(validateAuthoritativeExecutionQuote({ ...validStreamQuote, connectionEpoch: 9999 }, { activeStreamConnection: streamConn, streamConnectionState: 'CONNECTED', isStreamConnected: true, currentTimeMs: now }).valid).toBe(false);

      // K. wrong providerTransport -> rejected
      expect(validateAuthoritativeExecutionQuote({ ...validStreamQuote, providerTransport: 'INVALID_TRANSPORT' }, { activeStreamConnection: streamConn, streamConnectionState: 'CONNECTED', isStreamConnected: true, currentTimeMs: now }).valid).toBe(false);

      // L. Binance REST mislabeled as websocket -> rejected
      const paxgMislabeled = {
        contractSymbol: 'PAXGUSDT',
        price: 2885.5,
        marketEventTime: now - 200,
        provenance: 'LIVE_PROVIDER',
        providerId: 'BINANCE_REST',
        providerTransport: 'WEBSOCKET_STREAM',
        connectionEpoch: restConn.connectionEpoch,
        providerInstanceId: restConn.providerInstanceId,
        providerConnectionId: restConn.providerConnectionId,
      };
      expect(validateAuthoritativeExecutionQuote(paxgMislabeled, { activeRestConnection: restConn, restHealthState: 'HEALTHY', currentTimeMs: now }).valid).toBe(false);

      // M. quote from previous connection epoch -> rejected
      const prevEpochQuote = { ...validStreamQuote, connectionEpoch: streamConn.connectionEpoch - 1 };
      expect(validateAuthoritativeExecutionQuote(prevEpochQuote, { activeStreamConnection: streamConn, streamConnectionState: 'CONNECTED', isStreamConnected: true, currentTimeMs: now }).valid).toBe(false);
    });
  });
});
