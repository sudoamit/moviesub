import {
  createMarketSnapshot,
  validatePointInTimeSnapshot
} from '../shadow-execution/index';

describe('Phase 11 — Point-in-Time Market Snapshot', () => {
  const validOHLCV = {
    open: 100000,
    high: 100500,
    low: 99800,
    close: 100200,
    volume: 50.5
  };

  const validInstrument = {
    symbol: 'BTCUSDT',
    market: 'BINANCE_SPOT',
    tickSize: 0.1,
    lotSize: 0.001
  };

  it('creates an immutable, deep-frozen MarketSnapshot with valid PIT properties', () => {
    const timestamp = 1700000000000;
    const snapshot = createMarketSnapshot({
      snapshotId: 'snap-btc-01',
      instrument: validInstrument,
      timestamp,
      exchangeTimestamp: timestamp - 100,
      ohlcv: validOHLCV,
      bid: 100195,
      ask: 100205,
      volume: 50.5,
      dataSource: 'binance-websocket',
      dataVersion: '1.0'
    });

    expect(snapshot.snapshotId).toBe('snap-btc-01');
    expect(snapshot.spread).toBe(10); // 100205 - 100195
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.ohlcv)).toBe(true);
    expect(Object.isFrozen(snapshot.instrument)).toBe(true);

    expect(() => {
      (snapshot as any).bid = 99999;
    }).toThrow();
  });

  it('rejects future data leakage when exchangeTimestamp exceeds snapshot timestamp', () => {
    const timestamp = 1700000000000;
    expect(() => {
      createMarketSnapshot({
        snapshotId: 'snap-future-leak',
        instrument: validInstrument,
        timestamp,
        exchangeTimestamp: timestamp + 500, // Future timestamp relative to snapshot
        ohlcv: validOHLCV,
        bid: 100195,
        ask: 100205,
        volume: 50.5,
        dataSource: 'binance-websocket',
        dataVersion: '1.0'
      });
    }).toThrow(/FUTURE_DATA_LEAKAGE/);
  });

  it('fails closed when OHLCV relationships or spread are invalid', () => {
    const timestamp = 1700000000000;

    // High < Low
    expect(() => {
      createMarketSnapshot({
        instrument: validInstrument,
        timestamp,
        ohlcv: { ...validOHLCV, high: 99000, low: 100000 },
        bid: 100,
        ask: 101,
        volume: 1,
        dataSource: 'test',
        dataVersion: '1.0'
      });
    }).toThrow(/INVALID_MARKET_SNAPSHOT: OHLCV price relationships invalid/);

    // Negative spread (bid > ask)
    expect(() => {
      createMarketSnapshot({
        instrument: validInstrument,
        timestamp,
        ohlcv: validOHLCV,
        bid: 100210,
        ask: 100200,
        volume: 1,
        dataSource: 'test',
        dataVersion: '1.0'
      });
    }).toThrow(/INVALID_MARKET_SNAPSHOT: Negative spread detected/);
  });
});
