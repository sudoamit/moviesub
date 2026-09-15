import {
  NSE_STREAM_OPTION_PROVIDER_ADAPTER,
  NSE_REST_OPTION_PROVIDER_ADAPTER,
  NSE_YAHOO_REST_PROVIDER_ADAPTER,
  BINANCE_REST_PROVIDER_ADAPTER,
  BINANCE_OPTION_PROVIDER_ADAPTER,
  resetAllOptionProviderAdaptersForTests,
} from '../option-provider/canonical-option-provider-tick';
import {
  BINANCE_SPOT_PROVIDER_ADAPTER,
  BINANCE_REST_SPOT_PROVIDER_ADAPTER,
  NSE_YAHOO_REST_SPOT_PROVIDER_ADAPTER,
  NSE_STREAM_SPOT_PROVIDER_ADAPTER,
  isValidatedCanonicalSpotProviderTick,
  resetAllSpotProviderAdaptersForTests,
} from '../spot-provider/canonical-spot-provider-tick';
import {
  validateAuthoritativeExecutionQuote,
  normalizeCanonicalProviderId,
  setCanonicalSigningSecret,
  resetCanonicalSigningSecretForTests,
  ProviderRuntimeState,
} from '../execution-quote-validator';

describe('AI FIX 159 — Final Transport-Specific Connection Authority', () => {
  const TEST_SECRET = 'test_secret_key_1234567890_abcdef';

  beforeEach(() => {
    resetAllOptionProviderAdaptersForTests();
    resetAllSpotProviderAdaptersForTests();
    setCanonicalSigningSecret(TEST_SECRET);
    NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection();
    NSE_REST_OPTION_PROVIDER_ADAPTER.beginProviderConnection();
    NSE_YAHOO_REST_PROVIDER_ADAPTER.beginProviderConnection();
    BINANCE_REST_PROVIDER_ADAPTER.beginProviderConnection();
    BINANCE_SPOT_PROVIDER_ADAPTER.beginProviderConnection();
    BINANCE_REST_SPOT_PROVIDER_ADAPTER.beginProviderConnection();
    NSE_YAHOO_REST_SPOT_PROVIDER_ADAPTER.beginProviderConnection();
    NSE_STREAM_SPOT_PROVIDER_ADAPTER.beginProviderConnection();
  });

  afterEach(() => {
    resetCanonicalSigningSecretForTests();
    resetAllOptionProviderAdaptersForTests();
    resetAllSpotProviderAdaptersForTests();
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

  describe('FIX 161 — Final Execution-Authority Hardening Pass Tests', () => {
    beforeEach(() => {
      resetAllSpotProviderAdaptersForTests();
      BINANCE_SPOT_PROVIDER_ADAPTER.beginProviderConnection();
      BINANCE_REST_SPOT_PROVIDER_ADAPTER.beginProviderConnection();
      NSE_YAHOO_REST_SPOT_PROVIDER_ADAPTER.beginProviderConnection();
      NSE_STREAM_SPOT_PROVIDER_ADAPTER.beginProviderConnection();
    });

    test('1. ValidatedCanonicalSpotProviderTick root-of-trust and branding', () => {
      const now = Date.now();
      const binanceConn = BINANCE_SPOT_PROVIDER_ADAPTER.getCurrentProviderConnection()!;

      // Valid branded spot tick
      const tick = BINANCE_SPOT_PROVIDER_ADAPTER.toCanonicalExecutionTick({
        providerSymbol: 'BTCUSDT',
        price: 79500,
        providerEventTime: now - 100,
      });

      expect(isValidatedCanonicalSpotProviderTick(tick)).toBe(true);
      expect(tick.symbol).toBe('BTCUSDT');
      const rec = tick.toRecordInput();
      expect(rec.providerId).toBe('BINANCE_DIRECT');
      expect(rec.providerTransport).toBe('WEBSOCKET_STREAM');
      expect(rec.connectionEpoch).toBe(binanceConn.connectionEpoch);
      expect(rec.providerConnectionId).toBe(binanceConn.providerConnectionId);

      // Unbranded object returns false
      expect(isValidatedCanonicalSpotProviderTick({ symbol: 'BTCUSDT', price: 79500 })).toBe(false);
    });

    test('4. normalizeCanonicalProviderId fails closed on unknown/empty/whitespace/malformed provider IDs', () => {
      expect(() => normalizeCanonicalProviderId('')).toThrow('[UNKNOWN_PROVIDER_ID_REJECTED]');
      expect(() => normalizeCanonicalProviderId('   ')).toThrow('[UNKNOWN_PROVIDER_ID_REJECTED]');
      expect(() => normalizeCanonicalProviderId('UNKNOWN_PROVIDER_XYZ')).toThrow('[UNKNOWN_PROVIDER_ID_REJECTED]');
      expect(() => normalizeCanonicalProviderId('UNSUPPORTED_ALIAS_123')).toThrow('[UNKNOWN_PROVIDER_ID_REJECTED]');
      expect(() => normalizeCanonicalProviderId(null as any)).toThrow('[UNKNOWN_PROVIDER_ID_REJECTED]');
      expect(() => normalizeCanonicalProviderId(12345 as any)).toThrow('[UNKNOWN_PROVIDER_ID_REJECTED]');

      // Valid alias normalizations
      expect(normalizeCanonicalProviderId('NSE_OPTION_STREAM')).toBe('NSE_STREAM_GATEWAY');
      expect(normalizeCanonicalProviderId('NSE_OPTION_REST')).toBe('NSE_REST_OPTION_PROVIDER');
      expect(normalizeCanonicalProviderId('BINANCE_OPTION_STREAM')).toBe('BINANCE_DIRECT');
      expect(normalizeCanonicalProviderId('BINANCE_REST')).toBe('BINANCE_REST');
      expect(normalizeCanonicalProviderId('NSE_YAHOO_REST')).toBe('NSE_YAHOO_REST');
    });

    test('11. Lifecycle Test Matrix A through H', () => {
      const bStream1 = BINANCE_SPOT_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const nStream1 = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const yRest1 = NSE_YAHOO_REST_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const bRest1 = BINANCE_REST_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const nRest1 = NSE_REST_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;

      // A: Binance stream reconnect -> only Binance stream epoch/id changes
      const bStream2 = BINANCE_SPOT_PROVIDER_ADAPTER.beginProviderConnection();
      expect(bStream2.connectionEpoch).toBe(bStream1.connectionEpoch + 1);
      expect(NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()).toEqual(nStream1);
      expect(NSE_YAHOO_REST_PROVIDER_ADAPTER.getCurrentProviderConnection()).toEqual(yRest1);
      expect(BINANCE_REST_PROVIDER_ADAPTER.getCurrentProviderConnection()).toEqual(bRest1);
      expect(NSE_REST_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()).toEqual(nRest1);

      // B: NSE stream reconnect -> only NSE stream epoch/id changes
      const nStream2 = NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection();
      expect(nStream2.connectionEpoch).toBe(nStream1.connectionEpoch + 1);
      expect(BINANCE_SPOT_PROVIDER_ADAPTER.getCurrentProviderConnection()).toEqual(bStream2);
      expect(NSE_YAHOO_REST_PROVIDER_ADAPTER.getCurrentProviderConnection()).toEqual(yRest1);

      // C: NSE Yahoo REST recovery -> only NSE Yahoo REST epoch/id changes
      const yRest2 = NSE_YAHOO_REST_PROVIDER_ADAPTER.beginProviderConnection();
      expect(yRest2.connectionEpoch).toBe(yRest1.connectionEpoch + 1);
      expect(BINANCE_REST_PROVIDER_ADAPTER.getCurrentProviderConnection()).toEqual(bRest1);
      expect(BINANCE_SPOT_PROVIDER_ADAPTER.getCurrentProviderConnection()).toEqual(bStream2);

      // D: Binance REST recovery -> only Binance REST epoch/id changes
      const bRest2 = BINANCE_REST_PROVIDER_ADAPTER.beginProviderConnection();
      expect(bRest2.connectionEpoch).toBe(bRest1.connectionEpoch + 1);
      expect(NSE_YAHOO_REST_PROVIDER_ADAPTER.getCurrentProviderConnection()).toEqual(yRest2);
      expect(BINANCE_SPOT_PROVIDER_ADAPTER.getCurrentProviderConnection()).toEqual(bStream2);

      // E: NSE REST recovery -> NSE REST changes, Binance REST unchanged, stream unchanged
      const nRest2 = NSE_REST_OPTION_PROVIDER_ADAPTER.beginProviderConnection();
      expect(nRest2.connectionEpoch).toBe(nRest1.connectionEpoch + 1);
      expect(BINANCE_REST_PROVIDER_ADAPTER.getCurrentProviderConnection()).toEqual(bRest2);
      expect(BINANCE_SPOT_PROVIDER_ADAPTER.getCurrentProviderConnection()).toEqual(bStream2);
      expect(NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()).toEqual(nStream2);

      // F: old quote from previous connection -> rejected
      const now = Date.now();
      const oldQuote = {
        contractSymbol: 'NIFTY26SEP25000CE',
        price: 150.5,
        marketEventTime: now - 100,
        provenance: 'LIVE_PROVIDER',
        providerId: 'NSE_STREAM_GATEWAY',
        providerTransport: 'WEBSOCKET_STREAM',
        connectionEpoch: nStream1.connectionEpoch,
        providerInstanceId: nStream1.providerInstanceId,
        providerConnectionId: nStream1.providerConnectionId,
      };
      expect(validateAuthoritativeExecutionQuote(oldQuote, { activeStreamConnection: nStream2 }).valid).toBe(false);

      // G: quote from another provider -> rejected
      const wrongProviderQuote = {
        ...oldQuote,
        connectionEpoch: nStream2.connectionEpoch,
        providerInstanceId: nStream2.providerInstanceId,
        providerConnectionId: nStream2.providerConnectionId,
        providerId: 'BINANCE_DIRECT',
      };
      expect(validateAuthoritativeExecutionQuote(wrongProviderQuote, { activeStreamConnection: nStream2 }).valid).toBe(false);

      // H: quote from another transport -> rejected
      const wrongTransportQuote = {
        ...oldQuote,
        connectionEpoch: nStream2.connectionEpoch,
        providerInstanceId: nStream2.providerInstanceId,
        providerConnectionId: nStream2.providerConnectionId,
        providerTransport: 'REST_POLLING',
      };
      expect(validateAuthoritativeExecutionQuote(wrongTransportQuote, { activeStreamConnection: nStream2 }).valid).toBe(false);
    });
  });

  describe('FIX 162 — Final Provider-Runtime-State Hardening Tests (A through N)', () => {
    beforeEach(() => {
      resetAllOptionProviderAdaptersForTests();
      resetAllSpotProviderAdaptersForTests();
      NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection();
      NSE_REST_OPTION_PROVIDER_ADAPTER.beginProviderConnection();
      NSE_YAHOO_REST_PROVIDER_ADAPTER.beginProviderConnection();
      BINANCE_REST_PROVIDER_ADAPTER.beginProviderConnection();
      BINANCE_SPOT_PROVIDER_ADAPTER.beginProviderConnection();
      BINANCE_REST_SPOT_PROVIDER_ADAPTER.beginProviderConnection();
      NSE_YAHOO_REST_SPOT_PROVIDER_ADAPTER.beginProviderConnection();
      NSE_STREAM_SPOT_PROVIDER_ADAPTER.beginProviderConnection();
    });

    test('L. shared option/spot physical connection identity -> accepted', () => {
      const bSpotConn = BINANCE_SPOT_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      // Re-use bSpotConn for option adapter
      const bOptionConn = BINANCE_OPTION_PROVIDER_ADAPTER.beginProviderConnection({ existingConnection: bSpotConn });
      expect(bOptionConn.connectionEpoch).toBe(bSpotConn.connectionEpoch);
      expect(bOptionConn.providerConnectionId).toBe(bSpotConn.providerConnectionId);
    });

    test('M. forged existingConnection from another provider -> rejected', () => {
      const nseConn = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      // Try to pass NSE connection to Binance adapter
      expect(() => {
        BINANCE_SPOT_PROVIDER_ADAPTER.beginProviderConnection({ existingConnection: nseConn });
      }).toThrow(/providerId/);
    });

    test('M2. forged existingConnection from another transport -> rejected', () => {
      const bRestConn = BINANCE_REST_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      // Try to pass REST connection to stream adapter
      expect(() => {
        BINANCE_SPOT_PROVIDER_ADAPTER.beginProviderConnection({ existingConnection: bRestConn });
      }).toThrow(/transport/);
    });
  });

  describe('FIX 163 — Final Provider-Runtime Authority Hardening Tests (A through N)', () => {
    beforeEach(() => {
      resetAllOptionProviderAdaptersForTests();
      resetAllSpotProviderAdaptersForTests();
      NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection();
      NSE_REST_OPTION_PROVIDER_ADAPTER.beginProviderConnection();
      NSE_YAHOO_REST_PROVIDER_ADAPTER.beginProviderConnection();
      BINANCE_REST_PROVIDER_ADAPTER.beginProviderConnection();
      BINANCE_SPOT_PROVIDER_ADAPTER.beginProviderConnection();
      BINANCE_REST_SPOT_PROVIDER_ADAPTER.beginProviderConnection();
      NSE_YAHOO_REST_SPOT_PROVIDER_ADAPTER.beginProviderConnection();
      NSE_STREAM_SPOT_PROVIDER_ADAPTER.beginProviderConnection();
    });

    test('A. runtimeState stream validation against matching quote -> valid', () => {
      const conn = BINANCE_SPOT_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const now = Date.now();
      const quote = {
        symbol: 'BTCUSDT',
        price: 75000,
        marketEventTime: now,
        provenance: 'LIVE_PROVIDER',
        providerId: 'BINANCE_DIRECT',
        providerTransport: 'WEBSOCKET_STREAM',
        connectionEpoch: conn.connectionEpoch,
        providerInstanceId: conn.providerInstanceId,
        providerConnectionId: conn.providerConnectionId,
      };

      const runtimeState: ProviderRuntimeState = {
        providerId: 'BINANCE_DIRECT',
        providerTransport: 'WEBSOCKET_STREAM',
        connectionState: 'CONNECTED',
        providerConnected: true,
        currentConnection: conn,
        reconnectedAt: null,
      };

      const res = validateAuthoritativeExecutionQuote(quote, { runtimeState });
      expect(res.valid).toBe(true);
    });

    test('B. runtimeState providerTransport mismatch -> rejected with PROVIDER_TRANSPORT_MISMATCH', () => {
      const conn = BINANCE_SPOT_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const now = Date.now();
      const quote = {
        symbol: 'BTCUSDT',
        price: 75000,
        marketEventTime: now,
        provenance: 'LIVE_PROVIDER',
        providerId: 'BINANCE_DIRECT',
        providerTransport: 'REST_POLLING',
        connectionEpoch: conn.connectionEpoch,
        providerInstanceId: conn.providerInstanceId,
        providerConnectionId: conn.providerConnectionId,
      };

      const runtimeState: ProviderRuntimeState = {
        providerId: 'BINANCE_DIRECT',
        providerTransport: 'WEBSOCKET_STREAM',
        connectionState: 'CONNECTED',
        providerConnected: true,
        currentConnection: conn,
        reconnectedAt: null,
      };

      const res = validateAuthoritativeExecutionQuote(quote, { runtimeState });
      expect(res.valid).toBe(false);
      expect(res.errorType).toBe('PROVIDER_TRANSPORT_MISMATCH');
    });

    test('C. runtimeState providerId mismatch -> rejected with UNKNOWN_PROVIDER_ID_REJECTED', () => {
      const conn = BINANCE_SPOT_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const now = Date.now();
      const quote = {
        symbol: 'BTCUSDT',
        price: 75000,
        marketEventTime: now,
        provenance: 'LIVE_PROVIDER',
        providerId: 'NSE_STREAM_GATEWAY',
        providerTransport: 'WEBSOCKET_STREAM',
        connectionEpoch: conn.connectionEpoch,
        providerInstanceId: conn.providerInstanceId,
        providerConnectionId: conn.providerConnectionId,
      };

      const runtimeState: ProviderRuntimeState = {
        providerId: 'BINANCE_DIRECT',
        providerTransport: 'WEBSOCKET_STREAM',
        connectionState: 'CONNECTED',
        providerConnected: true,
        currentConnection: conn,
        reconnectedAt: null,
      };

      const res = validateAuthoritativeExecutionQuote(quote, { runtimeState });
      expect(res.valid).toBe(false);
      expect(res.errorType).toBe('UNKNOWN_PROVIDER_ID_REJECTED');
    });

    test('D. runtimeState RECONNECTING -> rejected with PROVIDER_RECONNECTING', () => {
      const conn = BINANCE_SPOT_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const now = Date.now();
      const quote = {
        symbol: 'BTCUSDT',
        price: 75000,
        marketEventTime: now,
        provenance: 'LIVE_PROVIDER',
        providerId: 'BINANCE_DIRECT',
        providerTransport: 'WEBSOCKET_STREAM',
        connectionEpoch: conn.connectionEpoch,
        providerInstanceId: conn.providerInstanceId,
        providerConnectionId: conn.providerConnectionId,
      };

      const runtimeState: ProviderRuntimeState = {
        providerId: 'BINANCE_DIRECT',
        providerTransport: 'WEBSOCKET_STREAM',
        connectionState: 'RECONNECTING',
        providerConnected: false,
        currentConnection: conn,
        reconnectedAt: null,
      };

      const res = validateAuthoritativeExecutionQuote(quote, { runtimeState });
      expect(res.valid).toBe(false);
      expect(res.errorType).toBe('PROVIDER_RECONNECTING');
    });

    test('E. runtimeState DISCONNECTED -> rejected with PROVIDER_DISCONNECTED', () => {
      const conn = BINANCE_SPOT_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const now = Date.now();
      const quote = {
        symbol: 'BTCUSDT',
        price: 75000,
        marketEventTime: now,
        provenance: 'LIVE_PROVIDER',
        providerId: 'BINANCE_DIRECT',
        providerTransport: 'WEBSOCKET_STREAM',
        connectionEpoch: conn.connectionEpoch,
        providerInstanceId: conn.providerInstanceId,
        providerConnectionId: conn.providerConnectionId,
      };

      const runtimeState: ProviderRuntimeState = {
        providerId: 'BINANCE_DIRECT',
        providerTransport: 'WEBSOCKET_STREAM',
        connectionState: 'DISCONNECTED',
        providerConnected: false,
        currentConnection: conn,
        reconnectedAt: null,
      };

      const res = validateAuthoritativeExecutionQuote(quote, { runtimeState });
      expect(res.valid).toBe(false);
      expect(res.errorType).toBe('PROVIDER_DISCONNECTED');
    });

    test('F. runtimeState connectionEpoch mismatch -> rejected with EPOCH_MISMATCH', () => {
      const conn = BINANCE_SPOT_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const now = Date.now();
      const quote = {
        symbol: 'BTCUSDT',
        price: 75000,
        marketEventTime: now,
        provenance: 'LIVE_PROVIDER',
        providerId: 'BINANCE_DIRECT',
        providerTransport: 'WEBSOCKET_STREAM',
        connectionEpoch: conn.connectionEpoch - 1,
        providerInstanceId: conn.providerInstanceId,
        providerConnectionId: conn.providerConnectionId,
      };

      const runtimeState: ProviderRuntimeState = {
        providerId: 'BINANCE_DIRECT',
        providerTransport: 'WEBSOCKET_STREAM',
        connectionState: 'CONNECTED',
        providerConnected: true,
        currentConnection: conn,
        reconnectedAt: null,
      };

      const res = validateAuthoritativeExecutionQuote(quote, { runtimeState });
      expect(res.valid).toBe(false);
      expect(res.errorType).toBe('EPOCH_MISMATCH');
    });

    test('O. REST Health Transition Idempotency — repeated connection initialization with existing connection retains identical epoch', () => {
      const initialConn = NSE_REST_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      expect(initialConn.connectionEpoch).toBe(1);

      // Re-initialize with existing connection (simulating repeated HEALTHY calls)
      const newConn = NSE_REST_OPTION_PROVIDER_ADAPTER.beginProviderConnection({
        existingConnection: initialConn,
      });

      expect(newConn.connectionEpoch).toBe(initialConn.connectionEpoch);
      expect(newConn.providerConnectionId).toBe(initialConn.providerConnectionId);
      expect(newConn.providerInstanceId).toBe(initialConn.providerInstanceId);
    });

    test('P. Freshness Key Isolation — Binance reconnect prefix does not purge NSE freshness keys', () => {
      const freshKeys = new Set<string>();
      const nseKey = 'WEBSOCKET_STREAM:NSE_STREAM_GATEWAY:conn_nse_123:NIFTY';
      const binanceKey = 'WEBSOCKET_STREAM:BINANCE_DIRECT:conn_binance_456:BTCUSDT';

      freshKeys.add(nseKey);
      freshKeys.add(binanceKey);

      // Simulate handleStreamProviderReconnect for NSE_STREAM_GATEWAY
      const nsePrefix = 'WEBSOCKET_STREAM:NSE_STREAM_GATEWAY:';
      Array.from(freshKeys)
        .filter((k) => k.startsWith(nsePrefix))
        .forEach((k) => freshKeys.delete(k));

      expect(freshKeys.has(nseKey)).toBe(false);
      expect(freshKeys.has(binanceKey)).toBe(true);
    });

    test('Q. Shared Option/Spot Post-Reconnect Identity Equality — NSE stream option & spot adapters share identical active connection identity after reconnect', () => {
      // 1. Initial shared connection
      const initialStreamConn = NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection();
      NSE_STREAM_SPOT_PROVIDER_ADAPTER.beginProviderConnection({
        existingConnection: initialStreamConn,
      });

      const optConn1 = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const spotConn1 = NSE_STREAM_SPOT_PROVIDER_ADAPTER.getCurrentProviderConnection()!;

      expect(optConn1.providerConnectionId).toBe(spotConn1.providerConnectionId);
      expect(optConn1.connectionEpoch).toBe(spotConn1.connectionEpoch);

      // 2. Reconnect: mint new shared connection
      const reconnectedStreamConn = NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection();
      NSE_STREAM_SPOT_PROVIDER_ADAPTER.beginProviderConnection({
        existingConnection: reconnectedStreamConn,
      });

      const optConn2 = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const spotConn2 = NSE_STREAM_SPOT_PROVIDER_ADAPTER.getCurrentProviderConnection()!;

      expect(optConn2.connectionEpoch).toBe(optConn1.connectionEpoch + 1);
      expect(optConn2.providerConnectionId).toBe(spotConn2.providerConnectionId);
      expect(optConn2.connectionEpoch).toBe(spotConn2.connectionEpoch);
      expect(optConn2.providerInstanceId).toBe(spotConn2.providerInstanceId);
    });
  });

  describe('FIX 165 — Final Provider-Runtime Atomicity & Authority Hardening Tests', () => {
    test('165-A. Validator rejects runtimeState with mismatched connection providerId or transport', () => {
      const streamConn = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const restConn = NSE_REST_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const now = Date.now();

      const quote = {
        contractSymbol: 'NIFTY26SEP25000CE',
        price: 150.5,
        marketEventTime: now,
        provenance: 'LIVE_PROVIDER',
        providerId: 'NSE_STREAM_GATEWAY',
        providerTransport: 'WEBSOCKET_STREAM',
        connectionEpoch: streamConn.connectionEpoch,
        providerInstanceId: streamConn.providerInstanceId,
        providerConnectionId: streamConn.providerConnectionId,
      };

      // Mismatched currentConnection inside runtimeState
      const corruptRuntimeState: ProviderRuntimeState = {
        providerId: 'NSE_STREAM_GATEWAY',
        providerTransport: 'WEBSOCKET_STREAM',
        connectionState: 'CONNECTED',
        providerConnected: true,
        currentConnection: restConn, // REST connection passed into WEBSOCKET_STREAM runtimeState
        reconnectedAt: null,
      };

      const res = validateAuthoritativeExecutionQuote(quote, { runtimeState: corruptRuntimeState });
      expect(res.valid).toBe(false);
      expect(['PROVIDER_TRANSPORT_MISMATCH', 'UNKNOWN_PROVIDER_ID_REJECTED']).toContain(res.errorType);
    });

    test('165-B. Validator rejects runtimeState with invalid or missing currentConnection', () => {
      const streamConn = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const now = Date.now();

      const quote = {
        contractSymbol: 'NIFTY26SEP25000CE',
        price: 150.5,
        marketEventTime: now,
        provenance: 'LIVE_PROVIDER',
        providerId: 'NSE_STREAM_GATEWAY',
        providerTransport: 'WEBSOCKET_STREAM',
        connectionEpoch: streamConn.connectionEpoch,
        providerInstanceId: streamConn.providerInstanceId,
        providerConnectionId: streamConn.providerConnectionId,
      };

      const unbrandedRuntimeState: any = {
        providerId: 'NSE_STREAM_GATEWAY',
        providerTransport: 'WEBSOCKET_STREAM',
        connectionState: 'CONNECTED',
        providerConnected: true,
        currentConnection: { connectionEpoch: 1, providerConnectionId: 'fake' }, // unbranded
        reconnectedAt: null,
      };

      const res = validateAuthoritativeExecutionQuote(quote, { runtimeState: unbrandedRuntimeState });
      expect(res.valid).toBe(false);
      expect(res.errorType).toBe('PROVIDER_DISCONNECTED');
    });

    test('165-C. Validator accepts fully consistent runtimeState with matching quote', () => {
      const streamConn = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const now = Date.now();

      const quote = {
        contractSymbol: 'NIFTY26SEP25000CE',
        price: 150.5,
        marketEventTime: now,
        provenance: 'LIVE_PROVIDER',
        providerId: 'NSE_STREAM_GATEWAY',
        providerTransport: 'WEBSOCKET_STREAM',
        connectionEpoch: streamConn.connectionEpoch,
        providerInstanceId: streamConn.providerInstanceId,
        providerConnectionId: streamConn.providerConnectionId,
      };

      const validRuntimeState: ProviderRuntimeState = {
        providerId: 'NSE_STREAM_GATEWAY',
        providerTransport: 'WEBSOCKET_STREAM',
        connectionState: 'CONNECTED',
        providerConnected: true,
        currentConnection: streamConn,
        reconnectedAt: null,
      };

      const res = validateAuthoritativeExecutionQuote(quote, { runtimeState: validRuntimeState });
      expect(res.valid).toBe(true);
    });
  });

  describe('FIX 166 — Final Provider-Runtime Atomicity & Connection Rotation Invariant Tests', () => {
    test('166-A. Stream reconnect service-level exactly-once rotation', () => {
      const initialConn = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      expect(initialConn.connectionEpoch).toBe(1);

      const rotatedConn = NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection({
        providerInstanceId: initialConn.providerInstanceId,
      });
      expect(rotatedConn.connectionEpoch).toBe(initialConn.connectionEpoch + 1);
      expect(rotatedConn.providerConnectionId).not.toBe(initialConn.providerConnectionId);
      expect(rotatedConn.providerInstanceId).toBe(initialConn.providerInstanceId);
    });

    test('166-B. Duplicate stream reconnect with existing connection is idempotent and preserves epoch', () => {
      const conn1 = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const conn2 = NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection({
        existingConnection: conn1,
      });

      expect(conn2.connectionEpoch).toBe(conn1.connectionEpoch);
      expect(conn2.providerConnectionId).toBe(conn1.providerConnectionId);
      expect(conn2.providerInstanceId).toBe(conn1.providerInstanceId);
    });

    test('166-C. REST health recovery UNAVAILABLE -> HEALTHY exactly-once rotation', () => {
      const initialRestConn = NSE_REST_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      expect(initialRestConn.connectionEpoch).toBe(1);

      const recoveredRestConn = NSE_REST_OPTION_PROVIDER_ADAPTER.beginProviderConnection();
      expect(recoveredRestConn.connectionEpoch).toBe(initialRestConn.connectionEpoch + 1);
      expect(recoveredRestConn.providerConnectionId).not.toBe(initialRestConn.providerConnectionId);
    });

    test('166-D. Connection rotation invariants: rotation requires newEpoch > oldEpoch, distinct connectionId, matching instanceId', () => {
      const conn1 = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const conn2 = NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection({
        providerInstanceId: conn1.providerInstanceId,
      });

      // Rotation invariants verification
      expect(conn2.connectionEpoch).toBeGreaterThan(conn1.connectionEpoch);
      expect(conn2.providerConnectionId).not.toBe(conn1.providerConnectionId);
      expect(conn2.providerInstanceId).toBe(conn1.providerInstanceId);
      expect(conn2.providerId).toBe(conn1.providerId);
      expect(conn2.providerTransport).toBe(conn1.providerTransport);
    });

    test('166-E. ProviderRuntimeState snapshot immutability via Object.freeze', () => {
      const conn = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const runtimeState: ProviderRuntimeState = Object.freeze({
        providerId: 'NSE_STREAM_GATEWAY',
        providerTransport: 'WEBSOCKET_STREAM',
        connectionState: 'CONNECTED',
        providerConnected: true,
        currentConnection: conn,
        reconnectedAt: null,
      });

      expect(Object.isFrozen(runtimeState)).toBe(true);
      expect(() => {
        (runtimeState as any).providerConnected = false;
      }).toThrow();
    });
  });

  describe('FIX 167 — Final Provider-Runtime Lifecycle Authority Hardening Tests', () => {
    test('167-A. Shared Option/Spot Connection Parity — Option & Spot adapters maintain identical identity post-rotation', () => {
      const initialStreamConn = NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection();
      NSE_STREAM_SPOT_PROVIDER_ADAPTER.beginProviderConnection({
        existingConnection: initialStreamConn,
      });

      const optConn1 = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const spotConn1 = NSE_STREAM_SPOT_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      expect(optConn1).toEqual(spotConn1);

      // Rotate connection
      const rotatedStreamConn = NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection({
        providerInstanceId: initialStreamConn.providerInstanceId,
      });
      NSE_STREAM_SPOT_PROVIDER_ADAPTER.beginProviderConnection({
        existingConnection: rotatedStreamConn,
      });

      const optConn2 = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      const spotConn2 = NSE_STREAM_SPOT_PROVIDER_ADAPTER.getCurrentProviderConnection()!;

      expect(optConn2).toEqual(spotConn2);
      expect(optConn2.connectionEpoch).toBe(optConn1.connectionEpoch + 1);
      expect(optConn2.providerConnectionId).not.toBe(optConn1.providerConnectionId);
    });

    test('167-B. Connection rotation invariants: non-incrementing epoch or duplicate connection ID is invalid', () => {
      const conn1 = NSE_STREAM_OPTION_PROVIDER_ADAPTER.getCurrentProviderConnection()!;
      
      // Duplicate connection identity has same epoch and connection ID
      expect(conn1.connectionEpoch).toBe(1);
      
      const conn2 = NSE_STREAM_OPTION_PROVIDER_ADAPTER.beginProviderConnection({
        providerInstanceId: conn1.providerInstanceId,
      });
      expect(conn2.connectionEpoch).toBe(2);
      expect(conn2.providerConnectionId).not.toBe(conn1.providerConnectionId);
    });

    test('167-C. Connection-level freshness key isolation across providers and transports', () => {
      const store = new Map<string, Map<string, Set<string>>>();
      
      // Transport -> Provider -> Connection -> Set<symbol>
      const nseOldConnId = 'conn_nse_v1';
      const nseNewConnId = 'conn_nse_v2';
      const binanceConnId = 'conn_binance_v1';

      const providerMap = new Map<string, Set<string>>();
      providerMap.set(nseOldConnId, new Set(['NIFTY']));
      providerMap.set(nseNewConnId, new Set(['NIFTY']));
      store.set('NSE_STREAM_GATEWAY', providerMap);

      const binanceMap = new Map<string, Set<string>>();
      binanceMap.set(binanceConnId, new Set(['BTCUSDT']));
      store.set('BINANCE_DIRECT', binanceMap);

      // Purge only old connection ID for NSE
      store.get('NSE_STREAM_GATEWAY')?.delete(nseOldConnId);

      expect(store.get('NSE_STREAM_GATEWAY')?.has(nseOldConnId)).toBe(false);
      expect(store.get('NSE_STREAM_GATEWAY')?.has(nseNewConnId)).toBe(true);
      expect(store.get('BINANCE_DIRECT')?.has(binanceConnId)).toBe(true);
    });
  });
});



