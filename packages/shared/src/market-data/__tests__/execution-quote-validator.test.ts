import {
  readdirSync,
  readFileSync,
  statSync,
} from 'fs';
import {
  join,
  relative,
} from 'path';
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
  isProviderConnectionIdentity,
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
    providerTransport?: 'WEBSOCKET_STREAM' | 'REST_POLLING';
  } = {}) {
    const adapter = NSE_STREAM_OPTION_PROVIDER_ADAPTER;
    const providerId = overrides.providerId ?? adapter.providerId;
    const providerTransport = overrides.providerTransport ?? adapter.providerTransport;
    const connection = adapter.beginProviderConnection({
      providerInstanceId: overrides.providerInstanceId ?? providerInstanceId,
    });
    const currentConnection = adapter.getCurrentProviderConnection();
    if (!currentConnection) throw new Error('test adapter did not create a connection');
    return adapter.toCanonicalExecutionTick(
      {
        providerId,
        providerTransport,
        providerSymbol: overrides.contractSymbol ?? 'NIFTY24SEP25000CE',
        price: overrides.price ?? 150.0,
        providerEventTime: overrides.marketEventTime ?? Date.now() - 500,
      },
      currentConnection,
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
      providerTransport: 'WEBSOCKET_STREAM' as const,
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

      const res = parseAndValidateRedisOptionQuote(JSON.stringify(record), contract, record.connectionEpoch, true, Date.now(), record.providerConnectionId, providerInstanceId);
      expect(res.valid).toBe(true);
      expect(res.quote?.provenance).toBe('LIVE_PROVIDER');
      expect(res.quote?.price).toBe(150.0);
      expect(res.quote?.connectionEpoch).toBe(record.connectionEpoch);
      expect(res.quote?.providerId).toBe(NSE_STREAM_OPTION_PROVIDER_ADAPTER.providerId);
      expect(res.quote?.providerInstanceId).toBe(providerInstanceId);
      expect(res.quote?.providerConnectionId).toBe(record.providerConnectionId);
      expect(res.quote?.providerTransport).toBe('WEBSOCKET_STREAM');
    });

    it('5. authentic payload from obsolete epoch => fails validation', () => {
      const record = createCanonicalOptionQuoteRecord(makeValidatedTick({
        contractSymbol: contract,
        connectionEpoch: epoch - 1,
      }));

      const res = parseAndValidateRedisOptionQuote(JSON.stringify(record), contract, record.connectionEpoch + 1, true, Date.now());
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('obsolete connection epoch');
    });

    it('6. authentic payload while streamer is RECONNECTING or unhealthy => fails validation', () => {
      const record = createCanonicalOptionQuoteRecord(makeValidatedTick({ contractSymbol: contract, connectionEpoch: epoch }));

      const res = parseAndValidateRedisOptionQuote(
        JSON.stringify(record),
        contract,
        record.connectionEpoch,
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
        record.connectionEpoch,
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

      const res = parseAndValidateRedisOptionQuote(JSON.stringify(record), contract, record.connectionEpoch, true, Date.now());
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('Contract mismatch');
    });

    it('rejects providerId, connection identity, contract, price, event-time, and signature tampering', () => {
      const record = createCanonicalOptionQuoteRecord(makeValidatedTick({ contractSymbol: contract, connectionEpoch: epoch }));
      for (const patch of [
        { providerId: 'ATTACKER_PROVIDER' },
        { providerInstanceId: 'other-api-instance' },
        { providerConnectionId: '32b38a0e-3773-4758-b16c-21af4e8bdc76' },
        { connectionEpoch: record.connectionEpoch + 1 },
        { contractSymbol: 'NIFTY24SEP26000CE' },
        { price: 151.0 },
        { marketEventTime: Date.now() - 250 },
        { signatureToken: '0'.repeat(64) },
        { providerTransport: 'REST_POLLING' },
      ]) {
        const tampered = { ...record, ...patch };
        const res = parseAndValidateRedisOptionQuote(JSON.stringify(tampered), contract, record.connectionEpoch, true, Date.now(), record.providerConnectionId, providerInstanceId);
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

    it('mints UUID provider connection ids inside the adapter instead of accepting caller ids', () => {
      const adapter = NSE_STREAM_OPTION_PROVIDER_ADAPTER;
      const first = adapter.beginProviderConnection({ providerInstanceId });
      const second = adapter.beginProviderConnection({ providerInstanceId });

      expect(isProviderConnectionIdUuid(first.providerConnectionId)).toBe(true);
      expect(isProviderConnectionIdUuid(second.providerConnectionId)).toBe(true);
      expect(first.providerConnectionId).not.toBe(second.providerConnectionId);
      expect(second.connectionEpoch).toBe(first.connectionEpoch + 1);
    });

    it('does not expose generic adapter or validator factories as production authority', () => {
      const publicApi = require('../option-provider');

      expect(publicApi.createOptionProviderAdapter).toBeUndefined();
      expect(publicApi.createOptionProviderValidator).toBeUndefined();
      expect(publicApi.NSE_STREAM_OPTION_PROVIDER_VALIDATOR).toBeUndefined();
      expect(publicApi.NSE_REST_OPTION_PROVIDER_VALIDATOR).toBeUndefined();
    });

    it('fabricated validator and adapter objects cannot produce production-authoritative ticks', () => {
      const fakeValidatedEvent = Object.freeze({
        providerId: NSE_STREAM_OPTION_PROVIDER_ADAPTER.providerId,
        providerTransport: NSE_STREAM_OPTION_PROVIDER_ADAPTER.providerTransport,
        contractSymbol: contract,
        price: 150.0,
        marketEventTime: Date.now() - 500,
      });
      const fakeValidator = Object.freeze({
        providerId: NSE_STREAM_OPTION_PROVIDER_ADAPTER.providerId,
        providerTransport: NSE_STREAM_OPTION_PROVIDER_ADAPTER.providerTransport,
        validate: () => fakeValidatedEvent,
      });
      const fakeAdapter = Object.freeze({
        providerId: NSE_STREAM_OPTION_PROVIDER_ADAPTER.providerId,
        providerTransport: NSE_STREAM_OPTION_PROVIDER_ADAPTER.providerTransport,
        beginProviderConnection: () => ({
          providerId: NSE_STREAM_OPTION_PROVIDER_ADAPTER.providerId,
          providerInstanceId,
          providerConnectionId,
          connectionEpoch: epoch,
        }),
        toCanonicalExecutionTick: () => fakeValidatedEvent,
      });

      expect(() => (fakeValidator as any).validate({})).not.toThrow();
      expect(() => createCanonicalOptionQuoteRecord((fakeAdapter as any).toCanonicalExecutionTick()))
        .toThrow(/validated provider-origin tick/);
    });

    it('rejects fabricated and stale provider connection identity objects', () => {
      const adapter = NSE_STREAM_OPTION_PROVIDER_ADAPTER;
      const first = adapter.beginProviderConnection({ providerInstanceId });
      const second = adapter.beginProviderConnection({ providerInstanceId });
      const raw = {
        providerSymbol: contract,
        price: 150.0,
        providerEventTime: Date.now() - 500,
      };

      expect(isProviderConnectionIdentity({
        providerId: adapter.providerId,
        providerInstanceId,
        providerConnectionId: second.providerConnectionId,
        connectionEpoch: second.connectionEpoch,
      })).toBe(false);
      expect(() => adapter.toCanonicalExecutionTick(raw, {
        providerId: adapter.providerId,
        providerInstanceId,
        providerConnectionId: second.providerConnectionId,
        connectionEpoch: second.connectionEpoch,
      } as any)).toThrow(/fabricated provider connection identity/);
      expect(() => adapter.toCanonicalExecutionTick(raw, first)).toThrow(/non-current provider connection identity/);
      expect(() => adapter.toCanonicalExecutionTick(raw, second)).not.toThrow();
    });

    it('raw provider identity and epoch claims cannot override adapter-derived authority', () => {
      const adapter = NSE_STREAM_OPTION_PROVIDER_ADAPTER;
      const connection = adapter.beginProviderConnection({ providerInstanceId });

      const tick = adapter.toCanonicalExecutionTick({
        providerId: adapter.providerId,
        providerTransport: adapter.providerTransport,
        providerSymbol: contract,
        price: 150.0,
        providerEventTime: Date.now() - 500,
      }, connection);
      const recordInput = tick.toRecordInput();
      expect(recordInput.providerId).toBe(adapter.providerId);
      expect(recordInput.providerTransport).toBe(adapter.providerTransport);
      expect(recordInput.connectionEpoch).toBe(connection.connectionEpoch);
      expect(recordInput.providerConnectionId).toBe(connection.providerConnectionId);

      expect(() => adapter.toCanonicalExecutionTick({
        providerId: 'ATTACKER',
        providerSymbol: contract,
        price: 150.0,
        providerEventTime: Date.now() - 500,
      }, connection)).toThrow(/providerId/);
      expect(() => adapter.toCanonicalExecutionTick({
        providerTransport: 'REST_POLLING',
        providerSymbol: contract,
        price: 150.0,
        providerEventTime: Date.now() - 500,
      }, connection)).toThrow(/providerTransport/);
      expect(() => adapter.toCanonicalExecutionTick({
        providerSymbol: contract,
        price: 150.0,
        providerEventTime: Date.now() - 500,
        connectionEpoch: connection.connectionEpoch,
      }, connection)).toThrow(/cannot supply trusted connectionEpoch/);
    });

    it('rejects malformed provider payloads before minting canonical ticks', () => {
      const adapter = NSE_STREAM_OPTION_PROVIDER_ADAPTER;
      adapter.beginProviderConnection({ providerInstanceId });

      for (const raw of [
        null,
        { providerSymbol: '', price: 150, providerEventTime: Date.now() - 500 },
        { providerSymbol: contract, price: 0, providerEventTime: Date.now() - 500 },
        { providerSymbol: contract, price: NaN, providerEventTime: Date.now() - 500 },
        { providerSymbol: contract, price: Infinity, providerEventTime: Date.now() - 500 },
        { providerSymbol: contract, price: 150 },
        { providerSymbol: contract, price: 150, providerEventTime: 0 },
        { providerSymbol: contract, price: 150, providerEventTime: -1 },
        { providerSymbol: contract, price: 150, providerEventTime: NaN },
        { providerSymbol: contract, price: 150, providerEventTime: Infinity },
        { providerSymbol: contract, price: 150, providerEventTime: Date.now() + MAX_FUTURE_SKEW_MS + 1000 },
        { providerSymbol: contract, price: 150, providerEventTime: Date.now() - 500, connectionEpoch: 1 },
        { providerSymbol: contract, price: 150, providerEventTime: Date.now() - 500, providerId: 'ATTACKER' },
        { providerSymbol: contract, price: 150, providerEventTime: Date.now() - 500, providerTransport: 'REST_POLLING' },
      ]) {
        expect(() => adapter.toCanonicalExecutionTick(raw as any)).toThrow(/PROVIDER_EVENT_REJECTED/);
      }
    });

    it('proves production-equivalent provider event to Redis to execution validator path', () => {
      const adapter = NSE_STREAM_OPTION_PROVIDER_ADAPTER;
      const connection = adapter.beginProviderConnection({ providerInstanceId });
      const providerWireEvent = {
        providerSymbol: contract,
        price: '150.25',
        providerEventTime: Date.now() - 500,
        sequence: 42,
      };

      const tick = adapter.toCanonicalExecutionTick(providerWireEvent, connection);
      const record = createCanonicalOptionQuoteRecord(tick);
      const redisJson = JSON.stringify(record);
      const monitorResult = parseAndValidateRedisOptionQuote(
        redisJson,
        contract,
        connection.connectionEpoch,
        true,
        Date.now(),
        connection.providerConnectionId,
        connection.providerInstanceId,
      );

      expect(monitorResult.valid).toBe(true);
      const executionResult = validateAuthoritativeExecutionQuote(monitorResult.quote, {
        expectedSymbol: contract,
        activeConnectionEpoch: connection.connectionEpoch,
        activeProviderConnectionId: connection.providerConnectionId,
        activeProviderInstanceId: connection.providerInstanceId,
        providerState: 'CONNECTED',
        isProviderConnected: true,
        currentTimeMs: Date.now(),
      });
      expect(executionResult.valid).toBe(true);

      const oldConnection = connection;
      const newConnection = adapter.beginProviderConnection({ providerInstanceId });
      expect(newConnection.connectionEpoch).toBe(oldConnection.connectionEpoch + 1);
      expect(parseAndValidateRedisOptionQuote(
        redisJson,
        contract,
        newConnection.connectionEpoch,
        true,
        Date.now(),
        newConnection.providerConnectionId,
        newConnection.providerInstanceId,
      ).valid).toBe(false);
    });

    it('static guards prevent execution-authority bypasses in production code', () => {
      const repoRoot = join(__dirname, '../../../../..');
      const srcRoot = join(repoRoot, 'packages');
      const productionFiles: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          const stat = statSync(full);
          if (stat.isDirectory()) {
            if (entry === '__tests__' || entry === 'dist' || entry === 'node_modules') continue;
            walk(full);
          } else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) {
            productionFiles.push(full);
          }
        }
      };
      walk(srcRoot);

      const violations: string[] = [];
      for (const file of productionFiles) {
        const rel = relative(repoRoot, file);
        const text = readFileSync(file, 'utf8');

        if (
          /new\s+(?:\([^)]*ValidatedCanonicalOptionProviderTick[^)]*\)|ValidatedCanonicalOptionProviderTick)\s*\(/.test(text) &&
          rel !== 'packages/shared/src/market-data/option-provider/canonical-option-provider-tick.ts'
        ) {
          violations.push(`${rel}: directly constructs ValidatedCanonicalOptionProviderTick`);
        }
        if (
          /mintProviderConnectionIdentity/.test(text) &&
          rel !== 'packages/shared/src/market-data/option-provider/provider-connection-identity.ts' &&
          rel !== 'packages/shared/src/market-data/option-provider/canonical-option-provider-tick.ts' &&
          rel !== 'packages/shared/src/market-data/spot-provider/canonical-spot-provider-tick.ts'
        ) {
          violations.push(`${rel}: directly mints provider identity`);
        }
        if (/provenance:\s*['"]LIVE_PROVIDER['"]/.test(text) && rel !== 'packages/shared/src/market-data/option-provider/canonical-option-quote-record.ts' && rel !== 'packages/shared/src/market-data/execution-quote-validator.ts') {
          violations.push(`${rel}: labels arbitrary payload LIVE_PROVIDER`);
        }
        if (/providerEventTime:\s*Date\.now\(\)|marketEventTime:\s*Date\.now\(\)/.test(text)) {
          violations.push(`${rel}: uses Date.now() as provider marketEventTime`);
        }
        if (/RECONNECTING['"]\s*\|\||\|\|\s*[^;{}]*RECONNECTING['"]|RECONNECTING['"][^;{}]*\?\s*true/.test(text.replace(/\n/g, ' '))) {
          violations.push(`${rel}: may accept RECONNECTING as execution healthy`);
        }
        if (/parseAndValidateRedisOptionQuote\(.*\)\.quote/.test(text.replace(/\n/g, ' '))) {
          violations.push(`${rel}: may bypass canonical execution validation`);
        }
      }

      expect(violations).toEqual([]);
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
