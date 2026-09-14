import {
  validateExecutionQuoteTimestamp,
  validateAuthoritativeExecutionQuote,
  getCanonicalSigningSecret,
  parseAndValidateRedisOptionQuote,
  isProviderExecutionHealthy,
  resetCanonicalSigningSecretForTests,
  setCanonicalSigningSecret,
  MAX_FUTURE_SKEW_MS,
  DEFAULT_MAX_AGE_MS,
  CANONICAL_OPTION_QUOTE_SCHEMA,
  CANONICAL_WRITER_ORIGIN,
} from '../execution-quote-validator';
import {
  createCanonicalOptionQuoteRecord,
  isProviderConnectionIdUuid,
  mintProviderConnectionIdentity,
  NSE_STREAM_OPTION_PROVIDER_ADAPTER,
  ValidatedCanonicalOptionProviderTick,
} from '../option-provider';

describe('AI FIX 153 — Execution Quote Validator & Market-Data Authority', () => {
  const now = 1700000000000;
  const providerInstanceId = 'api-test-instance-1';
  const providerConnectionId = '6d0881dc-7eaf-4b7c-9f71-86e0172954ce';

  beforeEach(() => {
    setCanonicalSigningSecret('test-canonical-option-quote-secret');
  });

  function makeValidatedTick(overrides: {
    contractSymbol?: string;
    price?: number;
    marketEventTime?: number;
    providerId?: string;
    connectionEpoch?: number;
    providerInstanceId?: string;
    providerConnectionId?: string;
    providerTransport?: 'WEBSOCKET_STREAM' | 'REST_POLLING';
  } = {}) {
    const providerId = overrides.providerId ?? NSE_STREAM_OPTION_PROVIDER_ADAPTER.providerId;
    const providerTransport = overrides.providerTransport ?? NSE_STREAM_OPTION_PROVIDER_ADAPTER.providerTransport;
    const connectionEpoch = overrides.connectionEpoch ?? 5;
    return NSE_STREAM_OPTION_PROVIDER_ADAPTER.toCanonicalExecutionTick(
      {
        providerId,
        providerTransport,
        providerSymbol: overrides.contractSymbol ?? 'NIFTY24SEP25000CE',
        price: overrides.price ?? 150.0,
        providerEventTime: overrides.marketEventTime ?? Date.now() - 500,
        connectionEpoch,
      },
      mintProviderConnectionIdentity({
        providerId,
        providerInstanceId: overrides.providerInstanceId ?? providerInstanceId,
        providerConnectionId: overrides.providerConnectionId ?? providerConnectionId,
        connectionEpoch,
      }),
    );
  }

  describe('1. Future-Skew & Timestamp Validation Everywhere', () => {
    it('accepts exact current time', () => {
      const res = validateExecutionQuoteTimestamp(now, now);
      expect(res.valid).toBe(true);
      expect(res.ageMs).toBe(0);
    });

    it('accepts 1 second old quote', () => {
      const res = validateExecutionQuoteTimestamp(now - 1000, now);
      expect(res.valid).toBe(true);
      expect(res.ageMs).toBe(1000);
    });

    it('accepts exactly max age (5000ms)', () => {
      const res = validateExecutionQuoteTimestamp(now - DEFAULT_MAX_AGE_MS, now, DEFAULT_MAX_AGE_MS);
      expect(res.valid).toBe(true);
      expect(res.ageMs).toBe(5000);
    });

    it('rejects quote that is too old (5001ms)', () => {
      const res = validateExecutionQuoteTimestamp(now - 5001, now, 5000);
      expect(res.valid).toBe(false);
      expect(res.errorType).toBe('STALE_QUOTE');
    });

    it('accepts 1 ms future timestamp within skew limit', () => {
      const res = validateExecutionQuoteTimestamp(now + 1, now, 5000, MAX_FUTURE_SKEW_MS);
      expect(res.valid).toBe(true);
    });

    it('accepts max future skew (now + 5000ms)', () => {
      const res = validateExecutionQuoteTimestamp(now + MAX_FUTURE_SKEW_MS, now, 5000, MAX_FUTURE_SKEW_MS);
      expect(res.valid).toBe(true);
    });

    it('rejects beyond max future skew (now + 5001ms)', () => {
      const res = validateExecutionQuoteTimestamp(now + MAX_FUTURE_SKEW_MS + 1, now, 5000, MAX_FUTURE_SKEW_MS);
      expect(res.valid).toBe(false);
      expect(res.errorType).toBe('FUTURE_SKEW');
    });

    it('rejects zero timestamp', () => {
      const res = validateExecutionQuoteTimestamp(0, now);
      expect(res.valid).toBe(false);
      expect(res.errorType).toBe('INVALID_EVENT_TIME');
    });

    it('rejects negative timestamp', () => {
      const res = validateExecutionQuoteTimestamp(-100, now);
      expect(res.valid).toBe(false);
      expect(res.errorType).toBe('INVALID_EVENT_TIME');
    });

    it('rejects NaN timestamp', () => {
      const res = validateExecutionQuoteTimestamp(NaN, now);
      expect(res.valid).toBe(false);
      expect(res.errorType).toBe('INVALID_EVENT_TIME');
    });

    it('rejects Infinity timestamp', () => {
      const res = validateExecutionQuoteTimestamp(Infinity, now);
      expect(res.valid).toBe(false);
      expect(res.errorType).toBe('INVALID_EVENT_TIME');
    });

    it('rejects malformed string timestamp', () => {
      const res = validateExecutionQuoteTimestamp('2026-09-14' as any, now);
      expect(res.valid).toBe(false);
      expect(res.errorType).toBe('INVALID_EVENT_TIME');
    });

    it('rejects null and undefined timestamps', () => {
      expect(validateExecutionQuoteTimestamp(null, now).valid).toBe(false);
      expect(validateExecutionQuoteTimestamp(undefined, now).valid).toBe(false);
    });
  });

  describe('2. Fail-Closed Provider Health Predicate', () => {
    it('returns true for CONNECTED and RECONNECTED', () => {
      expect(isProviderExecutionHealthy('CONNECTED', true)).toBe(true);
      expect(isProviderExecutionHealthy('RECONNECTED', true)).toBe(true);
    });

    it('returns false for DISCONNECTED', () => {
      expect(isProviderExecutionHealthy('DISCONNECTED', false)).toBe(false);
      expect(isProviderExecutionHealthy('DISCONNECTED', true)).toBe(false);
    });

    it('returns false for RECONNECTING', () => {
      expect(isProviderExecutionHealthy('RECONNECTING', false)).toBe(false);
      expect(isProviderExecutionHealthy('RECONNECTING', true)).toBe(false);
    });

    it('returns false when connected boolean is false regardless of state string', () => {
      expect(isProviderExecutionHealthy('CONNECTED', false)).toBe(false);
      expect(isProviderExecutionHealthy('RECONNECTED', false)).toBe(false);
    });
  });

  describe('3. Centralized Authoritative Execution Quote Validator', () => {
    const validQuote = {
      symbol: 'BTCUSDT',
      price: 65000.5,
      provenance: 'LIVE_PROVIDER',
      providerId: 'BINANCE_DIRECT',
      connectionEpoch: 2,
      marketEventTime: now - 500,
    };

    it('validates a compliant live provider quote', () => {
      const res = validateAuthoritativeExecutionQuote(validQuote, {
        expectedSymbol: 'BTCUSDT',
        activeConnectionEpoch: 2,
        providerState: 'CONNECTED',
        isProviderConnected: true,
        currentTimeMs: now,
      });
      expect(res.valid).toBe(true);
    });

    it('fails closed when provider is RECONNECTING', () => {
      const res = validateAuthoritativeExecutionQuote(validQuote, {
        expectedSymbol: 'BTCUSDT',
        activeConnectionEpoch: 2,
        providerState: 'RECONNECTING',
        isProviderConnected: false,
        currentTimeMs: now,
      });
      expect(res.valid).toBe(false);
      expect(res.errorType).toBe('PROVIDER_RECONNECTING');
    });

    it('fails closed when provider is DISCONNECTED', () => {
      const res = validateAuthoritativeExecutionQuote(validQuote, {
        expectedSymbol: 'BTCUSDT',
        activeConnectionEpoch: 2,
        providerState: 'DISCONNECTED',
        isProviderConnected: false,
        currentTimeMs: now,
      });
      expect(res.valid).toBe(false);
      expect(res.errorType).toBe('PROVIDER_DISCONNECTED');
    });

    it('fails closed when connection epoch does not match active epoch', () => {
      const res = validateAuthoritativeExecutionQuote(validQuote, {
        expectedSymbol: 'BTCUSDT',
        activeConnectionEpoch: 3, // active epoch is 3, quote is from epoch 2
        providerState: 'CONNECTED',
        isProviderConnected: true,
        currentTimeMs: now,
      });
      expect(res.valid).toBe(false);
      expect(res.errorType).toBe('EPOCH_MISMATCH');
    });

    it('fails closed when provenance is not LIVE_PROVIDER', () => {
      const res = validateAuthoritativeExecutionQuote(
        { ...validQuote, provenance: 'BOOTSTRAP' },
        {
          expectedSymbol: 'BTCUSDT',
          activeConnectionEpoch: 2,
          providerState: 'CONNECTED',
          isProviderConnected: true,
          currentTimeMs: now,
        },
      );
      expect(res.valid).toBe(false);
      expect(res.errorType).toBe('NOT_LIVE_PROVIDER');
    });

    it('fails closed on synthetic quotes', () => {
      const res = validateAuthoritativeExecutionQuote(
        { ...validQuote, isSynthetic: true },
        {
          expectedSymbol: 'BTCUSDT',
          activeConnectionEpoch: 2,
          providerState: 'CONNECTED',
          isProviderConnected: true,
          currentTimeMs: now,
        },
      );
      expect(res.valid).toBe(false);
      expect(res.errorType).toBe('SYNTHETIC_REJECTED');
    });

    it('fails closed on symbol mismatch', () => {
      const res = validateAuthoritativeExecutionQuote(validQuote, {
        expectedSymbol: 'ETHUSDT',
        activeConnectionEpoch: 2,
        providerState: 'CONNECTED',
        isProviderConnected: true,
        currentTimeMs: now,
      });
      expect(res.valid).toBe(false);
      expect(res.errorType).toBe('SYMBOL_MISMATCH');
    });

    it('fails closed on non-positive or invalid price', () => {
      expect(validateAuthoritativeExecutionQuote({ ...validQuote, price: 0 }).valid).toBe(false);
      expect(validateAuthoritativeExecutionQuote({ ...validQuote, price: -10 }).valid).toBe(false);
      expect(validateAuthoritativeExecutionQuote({ ...validQuote, price: NaN }).valid).toBe(false);
    });

    it('fails closed on missing providerId', () => {
      const res = validateAuthoritativeExecutionQuote(
        { ...validQuote, providerId: undefined },
        {
          expectedSymbol: 'BTCUSDT',
          activeConnectionEpoch: 2,
          providerState: 'CONNECTED',
          isProviderConnected: true,
          currentTimeMs: now,
        },
      );
      expect(res.valid).toBe(false);
      expect(res.errorType).toBe('MISSING_PROVIDER_ID');
    });
  });

  describe('4. Redis Option Quote Tampering & Provenance Immunity', () => {
    const contract = 'NIFTY24SEP25000CE';
    const epoch = 5;

    it('1. raw Redis JSON with price + timestamp => fails canonical validation', () => {
      const raw = JSON.stringify({ price: 150.0, marketEventTime: now });
      const res = parseAndValidateRedisOptionQuote(raw, contract, epoch, true, now);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('Untrusted schemaVersion');
    });

    it('2. JSON manually adding provenance LIVE_PROVIDER => STILL fails canonical validation', () => {
      const raw = JSON.stringify({
        price: 150.0,
        provenance: 'LIVE_PROVIDER',
        marketEventTime: now,
      });
      const res = parseAndValidateRedisOptionQuote(raw, contract, epoch, true, now);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('Untrusted schemaVersion');
    });

    it('3. JSON manually adding providerId + epoch => STILL fails canonical validation without signature', () => {
      const raw = JSON.stringify({
        schemaVersion: CANONICAL_OPTION_QUOTE_SCHEMA,
        writerOrigin: CANONICAL_WRITER_ORIGIN,
        contractSymbol: contract,
        price: 150.0,
        provenance: 'LIVE_PROVIDER',
        providerId: NSE_STREAM_OPTION_PROVIDER_ADAPTER.providerId,
        connectionEpoch: epoch,
        providerInstanceId,
        providerConnectionId,
        providerTransport: 'WEBSOCKET_STREAM',
        marketEventTime: now,
        signatureToken: 'forged_fake_sig',
      });
      const res = parseAndValidateRedisOptionQuote(raw, contract, epoch, true, now);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('Cryptographic signature mismatch');
    });

    it('4. authentic canonical writer payload => validated as LIVE_PROVIDER', () => {
      const record = createCanonicalOptionQuoteRecord(makeValidatedTick({ contractSymbol: contract, connectionEpoch: epoch }));

      const res = parseAndValidateRedisOptionQuote(JSON.stringify(record), contract, epoch, true, Date.now(), providerConnectionId, providerInstanceId);
      expect(res.valid).toBe(true);
      expect(res.quote?.provenance).toBe('LIVE_PROVIDER');
      expect(res.quote?.price).toBe(150.0);
      expect(res.quote?.connectionEpoch).toBe(epoch);
      expect(res.quote?.providerId).toBe(NSE_STREAM_OPTION_PROVIDER_ADAPTER.providerId);
      expect(res.quote?.providerInstanceId).toBe(providerInstanceId);
      expect(res.quote?.providerConnectionId).toBe(providerConnectionId);
      expect(res.quote?.providerTransport).toBe('WEBSOCKET_STREAM');
    });

    it('5. authentic payload from obsolete epoch => fails validation', () => {
      const record = createCanonicalOptionQuoteRecord(makeValidatedTick({
        contractSymbol: contract,
        connectionEpoch: epoch - 1,
        providerConnectionId: '13730d53-a482-43ce-8384-b97e7fbdb111',
      }));

      const res = parseAndValidateRedisOptionQuote(JSON.stringify(record), contract, epoch, true, Date.now());
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('obsolete connection epoch');
    });

    it('6. authentic payload while streamer is RECONNECTING or unhealthy => fails validation', () => {
      const record = createCanonicalOptionQuoteRecord(makeValidatedTick({ contractSymbol: contract, connectionEpoch: epoch }));

      const res = parseAndValidateRedisOptionQuote(
        JSON.stringify(record),
        contract,
        epoch,
        false, // streamer not healthy!
        Date.now(),
      );
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('not in an execution-healthy state');
    });

    it('7. authentic payload while DISCONNECTED => fails validation', () => {
      const record = createCanonicalOptionQuoteRecord(makeValidatedTick({ contractSymbol: contract, connectionEpoch: epoch }));

      const res = parseAndValidateRedisOptionQuote(
        JSON.stringify(record),
        contract,
        epoch,
        false,
        Date.now(),
      );
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('not in an execution-healthy state');
    });

    it('fails when contract symbol does not match', () => {
      const record = createCanonicalOptionQuoteRecord(makeValidatedTick({
        contractSymbol: 'BANKNIFTY24SEP50000CE',
        price: 250.0,
        connectionEpoch: epoch,
      }));

      const res = parseAndValidateRedisOptionQuote(JSON.stringify(record), contract, epoch, true, Date.now());
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('Contract mismatch');
    });

    it('rejects providerId, connection identity, contract, price, event-time, and signature tampering', () => {
      const record = createCanonicalOptionQuoteRecord(makeValidatedTick({ contractSymbol: contract, connectionEpoch: epoch }));
      for (const patch of [
        { providerId: 'ATTACKER_PROVIDER' },
        { providerInstanceId: 'other-api-instance' },
        { providerConnectionId: '32b38a0e-3773-4758-b16c-21af4e8bdc76' },
        { contractSymbol: 'NIFTY24SEP26000CE' },
        { price: 151.0 },
        { marketEventTime: Date.now() - 250 },
        { signatureToken: '0'.repeat(64) },
        { providerTransport: 'REST_POLLING' },
      ]) {
        const tampered = { ...record, ...patch };
        const res = parseAndValidateRedisOptionQuote(JSON.stringify(tampered), contract, epoch, true, Date.now(), providerConnectionId, providerInstanceId);
        expect(res.valid).toBe(false);
      }
    });

    it('requires a runtime-branded provider tick instead of arbitrary caller primitives', () => {
      expect(() => createCanonicalOptionQuoteRecord({
        contractSymbol: contract,
        price: 150.0,
        marketEventTime: now - 500,
        providerId: NSE_STREAM_OPTION_PROVIDER_ADAPTER.providerId,
        connectionEpoch: epoch,
        providerInstanceId,
        providerConnectionId,
        providerTransport: 'WEBSOCKET_STREAM',
      } as any)).toThrow(/validated provider-origin tick/);
    });

    it('cannot fabricate a branded provider tick with constructor tricks or structural objects', () => {
      const validInput = makeValidatedTick().toRecordInput();

      // @ts-expect-error constructor is private to the provider adapter module.
      const compileTimeFabricationCheck = () => new ValidatedCanonicalOptionProviderTick(Symbol('fake'), validInput);
      expect(compileTimeFabricationCheck).toBeDefined();
      expect((ValidatedCanonicalOptionProviderTick as any).fromProviderEvent).toBeUndefined();
      expect(() => new (ValidatedCanonicalOptionProviderTick as any)(Symbol('fake'), validInput))
        .toThrow(/cannot be constructed outside/);

      const structuralClone = {
        contractSymbol: contract,
        toRecordInput: () => validInput,
      };
      expect(() => createCanonicalOptionQuoteRecord(structuralClone as any))
        .toThrow(/validated provider-origin tick/);

      const authentic = makeValidatedTick({ contractSymbol: contract });
      expect(Object.isFrozen(authentic)).toBe(true);
      expect(Object.isFrozen(authentic.toRecordInput())).toBe(true);
      expect(() => ((authentic.toRecordInput() as any).price = 999)).toThrow();
    });

    it('mints UUID provider connection ids instead of instance-plus-epoch strings', () => {
      const first = mintProviderConnectionIdentity({
        providerId: NSE_STREAM_OPTION_PROVIDER_ADAPTER.providerId,
        providerInstanceId,
        connectionEpoch: epoch,
      });
      const second = mintProviderConnectionIdentity({
        providerId: NSE_STREAM_OPTION_PROVIDER_ADAPTER.providerId,
        providerInstanceId,
        connectionEpoch: epoch,
      });

      expect(isProviderConnectionIdUuid(first.providerConnectionId)).toBe(true);
      expect(isProviderConnectionIdUuid(second.providerConnectionId)).toBe(true);
      expect(first.providerConnectionId).not.toBe(second.providerConnectionId);
    });

    it('uses only CANONICAL_OPTION_QUOTE_SECRET and does not fall back to JWT/session secrets', () => {
      const oldCanonical = process.env.CANONICAL_OPTION_QUOTE_SECRET;
      const oldJwt = process.env.JWT_SECRET;
      const oldSession = process.env.SESSION_SECRET;
      resetCanonicalSigningSecretForTests();
      delete process.env.CANONICAL_OPTION_QUOTE_SECRET;
      process.env.JWT_SECRET = 'jwt-secret-must-not-sign-market-data';
      process.env.SESSION_SECRET = 'session-secret-must-not-sign-market-data';

      expect(() => getCanonicalSigningSecret()).toThrow(/CANONICAL_SECRET_UNCONFIGURED/);

      if (oldCanonical === undefined) delete process.env.CANONICAL_OPTION_QUOTE_SECRET;
      else process.env.CANONICAL_OPTION_QUOTE_SECRET = oldCanonical;
      if (oldJwt === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = oldJwt;
      if (oldSession === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = oldSession;
      setCanonicalSigningSecret('test-canonical-option-quote-secret');
    });
  });
});
