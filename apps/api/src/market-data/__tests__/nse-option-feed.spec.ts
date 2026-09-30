import { IndianOptionsExpiryEngine } from '@quant/trading-engine';
import { RealMarketStreamerService } from '../real-market-streamer.service';

/**
 * Live NSE option quote producer: Groww option chain -> validated canonical option quotes.
 * Before this feed existed nothing published option quotes, so every NIFTY option order was rejected
 * and option positions could not be monitored.
 */
describe('NSE option quote feed (NSE_REST_OPTION_PROVIDER)', () => {
  const tradedExpiry = IndianOptionsExpiryEngine.getUpcomingExpiries('NIFTY')[0].dateString; // e.g. 06-Oct-2026
  const toIso = (dmy: string) => {
    const d = new Date(dmy);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  let streamer: RealMarketStreamerService;
  let fetchSpy: jest.SpyInstance;

  // Canonical option quotes are HMAC-signed; the feed cannot publish without a configured secret.
  beforeAll(() => {
    process.env.CANONICAL_OPTION_QUOTE_SECRET = 'test-canonical-option-quote-secret';
  });

  const chain = (opts: { expiry: string; lastTradeSec: number; strikes?: number[] }) => ({
    optionChain: {
      expiryDetailsDto: { currentExpiry: opts.expiry },
      optionChains: (opts.strikes ?? [22750, 22800, 24800]).map((k) => ({
        strikePrice: k * 100, // Groww reports strikes in paise
        callOption: { ltp: 145.45, lastTradeTime: opts.lastTradeSec, close: 156.1, open: 139.9, high: 172.1, low: 99.8 },
        putOption: { ltp: 124.7, lastTradeTime: opts.lastTradeSec, close: 110.2 },
      })),
    },
  });

  beforeEach(() => {
    const redis: any = {
      getClient: () => ({ status: 'ready', set: jest.fn().mockResolvedValue('OK'), publish: jest.fn() }),
      set: jest.fn(),
      get: jest.fn(),
      publish: jest.fn(),
    };
    streamer = new RealMarketStreamerService(redis);
    // Spot so the near-the-money window (+/- 15 strikes) applies
    (streamer as any).tickers.set('NIFTY', { symbol: 'NIFTY', price: 22782.2 });
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    streamer.onModuleDestroy();
  });

  const mockFetch = (niftyBody: any) => {
    fetchSpy = jest.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => ({
      ok: true,
      json: async () => (String(url).includes('/nifty-bank') ? { optionChain: { optionChains: [] } } : niftyBody),
    }));
  };

  it('publishes fresh near-the-money CE/PE quotes that execution can read via getOptionTicker', async () => {
    mockFetch(chain({ expiry: toIso(tradedExpiry), lastTradeSec: Math.floor(Date.now() / 1000) }));

    await (streamer as any).fetchRealNseOptionQuotes();

    const ce = streamer.getOptionTicker('NIFTY 22800 CE');
    const pe = streamer.getOptionTicker('NIFTY 22800 PE');
    expect(ce?.price).toBe(145.45);
    expect(ce?.provenance).toBe('LIVE_PROVIDER');
    expect(pe?.price).toBe(124.7);
    // Far-from-money strike (24800, ~2000 points away) is outside the window and not published
    expect(streamer.getOptionTicker('NIFTY 24800 CE')).toBeNull();
  });

  it('never publishes stale quotes (no recent trade, e.g. after market close)', async () => {
    mockFetch(chain({ expiry: toIso(tradedExpiry), lastTradeSec: Math.floor(Date.now() / 1000) - 3600 }));

    await (streamer as any).fetchRealNseOptionQuotes();

    expect(streamer.getOptionTicker('NIFTY 22800 CE')).toBeNull();
  });

  it('never publishes quotes from a different expiry than the one the contract resolver trades', async () => {
    mockFetch(chain({ expiry: '2099-01-01', lastTradeSec: Math.floor(Date.now() / 1000) }));

    await (streamer as any).fetchRealNseOptionQuotes();

    expect(streamer.getOptionTicker('NIFTY 22800 CE')).toBeNull();
  });
});

/**
 * F-6: NSE spot quotes keep the provider's REAL event time (never re-stamped with the poll time), so delayed
 * data is rejected as stale instead of being presented as live. One stale symbol must not take down others.
 */
describe('NSE spot quotes use honest provider timestamps', () => {
  let streamer: RealMarketStreamerService;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    const redis: any = { getClient: () => ({ status: 'ready', set: jest.fn(), publish: jest.fn() }), set: jest.fn(), get: jest.fn(), publish: jest.fn() };
    streamer = new RealMarketStreamerService(redis);
  });
  afterEach(() => {
    fetchSpy?.mockRestore();
    streamer.onModuleDestroy();
  });

  const mockFeeds = (opts: { indexTsSec: number; yahooTsSec: number }) => {
    fetchSpy = jest.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes('latest_indices_ohlc/NIFTY') || u.includes('latest_indices_ohlc/BANKNIFTY')) {
        const isBank = u.includes('BANKNIFTY');
        return { ok: true, json: async () => ({ value: isBank ? 54633.05 : 22620.45, tsInMillis: opts.indexTsSec, close: 22716.2, open: 22665, high: 22809.35, low: 22595.2, dayChange: -95.75, dayChangePerc: -0.42 }) };
      }
      // Yahoo chart meta for equities
      return { ok: true, json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 1300.5, regularMarketTime: opts.yahooTsSec, chartPreviousClose: 1290 } }] } }) };
    });
  };

  it('ingests a fresh Groww index quote with its own timestamp', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockFeeds({ indexTsSec: nowSec, yahooTsSec: nowSec - 20 }); // equities 20s delayed
    await (streamer as any).fetchRealNSEQuotes();

    const t = streamer.getValidatedTicker('NIFTY', 5);
    expect(t.price).toBe(22620.45);
    // The delayed equity quote was not ingested, and did not mark the provider unavailable
    expect(() => streamer.getValidatedTicker('RELIANCE', 5)).toThrow();
  });

  it('rejects a delayed index quote instead of stamping it with the poll time', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockFeeds({ indexTsSec: nowSec - 30, yahooTsSec: nowSec - 30 });
    await (streamer as any).fetchRealNSEQuotes();

    expect(() => streamer.getValidatedTicker('NIFTY', 5)).toThrow();
  });
});
