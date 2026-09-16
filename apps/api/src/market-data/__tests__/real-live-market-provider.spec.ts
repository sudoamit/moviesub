import { RealLiveMarketDataProvider, Timeframe, MarketDataUnavailableError } from '@quant/shared';

describe('RealLiveMarketDataProvider Transport & Canonical Mapping Smoke Test', () => {
  let provider: RealLiveMarketDataProvider;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    provider = new RealLiveMarketDataProvider();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('correctly fetches, validates and converts Binance HTTP transport payloads into canonical LIVE ICandle objects', async () => {
    const nowMs = Date.now();
    const durationMs = 15 * 60 * 1000;
    const candle1Open = nowMs - 2 * durationMs;
    const candle2Open = nowMs - durationMs;

    const mockBinanceData = [
      [candle1Open, '64000.00', '64500.00', '63800.00', '64300.00', '150.5', candle1Open + durationMs - 1],
      [candle2Open, '64300.00', '65000.00', '64200.00', '64900.00', '210.0', candle2Open + durationMs - 1],
    ];

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue(mockBinanceData),
    } as any);

    const candles = await provider.getHistoricalCandles('BTCUSDT', Timeframe.M15, 10);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('api.binance.com/api/v3/klines?symbol=BTCUSDT'));

    expect(candles).toHaveLength(2);
    expect(candles[0].open).toBe(64000);
    expect(candles[0].high).toBe(64500);
    expect(candles[0].low).toBe(63800);
    expect(candles[0].close).toBe(64300);
    expect(candles[0].volume).toBe(150.5);
    expect(candles[0].provenance).toBe('LIVE');
    expect(candles[0].isClosed).toBe(true);

    expect(candles[1].close).toBe(64900);
  });

  it('getLatestCandle returns the latest canonical closed candle from production provider', async () => {
    const nowMs = Date.now();
    const durationMs = 15 * 60 * 1000;
    const candleOpen = nowMs - durationMs;

    const mockBinanceData = [
      [candleOpen, '65000.00', '65300.00', '64900.00', '65200.00', '500.0', candleOpen + durationMs - 1],
    ];

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue(mockBinanceData),
    } as any);

    const latest = await provider.getLatestCandle('BTCUSDT', Timeframe.M15);

    expect(latest).toBeDefined();
    expect(latest.close).toBe(65200);
    expect(latest.provenance).toBe('LIVE');
  });

  it('throws fail-closed error when network payload is empty or invalid', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue([]),
    } as any);

    await expect(provider.getLatestCandle('BTCUSDT', Timeframe.M15)).rejects.toThrow(
      'No market data returned',
    );
  });
});
