import {
  Direction,
  ICandle,
  IMarketDataProvider,
  MarketDataSourceMode,
  MarketDataSourcePolicy,
  RealLiveMarketDataProvider,
  Timeframe,
  toPrismaTimeframe,
  toPrismaTimeframeOrDefault,
} from '@quant/shared';
import {
  CanonicalMarketSnapshotBuilder,
  SignalGenerator,
  SMCAnalyzer,
} from '../index';

describe('MASTER ENGINEERING FIX — Cross-Module Authority & Invariant Enforcement', () => {
  const baseTime = new Date('2026-01-01T10:00:00.000Z').getTime();

  const createCandles = (count: number, tfMinutes = 15, startPrice = 100): ICandle[] => {
    const candles: ICandle[] = [];
    let p = startPrice;
    for (let i = 0; i < count; i++) {
      const open = p;
      const close = p + 0.5;
      const high = close + 0.2;
      const low = open - 0.2;
      candles.push({
        timestamp: new Date(baseTime + i * tfMinutes * 60 * 1000),
        open,
        high,
        low,
        close,
        volume: 1000,
        isClosed: true,
        provenance: 'LIVE',
      });
      p = close;
    }
    return candles;
  };

  // ============================================================
  // 1 & 2 & 12. Scanner Uses Canonical LIVE_DECISION & No Raw Candle / Prisma DB Bypass
  // ============================================================
  it('1, 2, 12. Scanner uses canonical snapshots and generateFromSnapshots without raw array or DB bypass', () => {
    const m15Candles = createCandles(30, 15, 100);
    const h1Candles = createCandles(20, 60, 100);
    const h4Candles = createCandles(15, 240, 100);

    const executionSnapshot = CanonicalMarketSnapshotBuilder.build({
      symbol: 'BTCUSDT',
      executionCandles: m15Candles,
      executionTimeframe: Timeframe.M15,
      dataProvenance: 'LIVE',
    });

    const htf1Snapshot = CanonicalMarketSnapshotBuilder.build({
      symbol: 'BTCUSDT',
      executionCandles: h1Candles,
      executionTimeframe: Timeframe.H1,
      asOfTimestamp: executionSnapshot.decisionTimestamp,
      dataProvenance: 'LIVE',
    });

    const htf2Snapshot = CanonicalMarketSnapshotBuilder.build({
      symbol: 'BTCUSDT',
      executionCandles: h4Candles,
      executionTimeframe: Timeframe.H4,
      asOfTimestamp: executionSnapshot.decisionTimestamp,
      dataProvenance: 'LIVE',
    });

    const signal = SignalGenerator.generateFromSnapshots({
      executionSnapshot,
      htf1Snapshot,
      htf2Snapshot,
    });

    expect(signal).toBeDefined();
    expect(signal.symbol).toBe('BTCUSDT');
    expect(signal.timeframe).toBe('15m');
  });

  // ============================================================
  // 3. Scanner Fails Closed When Live Feed Is Unavailable
  // ============================================================
  it('3. MarketDataSourcePolicy fails closed when live feed is unavailable under LIVE_DECISION', () => {
    expect(() => {
      MarketDataSourcePolicy.resolveSource(MarketDataSourceMode.LIVE_DECISION, {
        hasLiveFeed: false,
        symbol: 'BTCUSDT',
      });
    }).toThrow(/Authoritative live exchange stream unavailable/);
  });

  // ============================================================
  // 4. HTF Cannot Exceed Execution Decision Timestamp
  // ============================================================
  it('4. SignalGenerator.generateFromSnapshots rejects HTF snapshot that exceeds execution decision timestamp', () => {
    const m15Candles = createCandles(25, 15, 100);
    const futureH1Candles = createCandles(30, 60, 100); // extends beyond M15

    const executionSnapshot = CanonicalMarketSnapshotBuilder.build({
      symbol: 'BTCUSDT',
      executionCandles: m15Candles,
      executionTimeframe: Timeframe.M15,
      dataProvenance: 'LIVE',
    });

    // Unconstrained HTF snapshot whose closedThroughTimestamp is after executionSnapshot.decisionTimestamp
    const invalidHtfSnapshot = CanonicalMarketSnapshotBuilder.build({
      symbol: 'BTCUSDT',
      executionCandles: futureH1Candles,
      executionTimeframe: Timeframe.H1,
      dataProvenance: 'LIVE',
    });

    expect(() => {
      SignalGenerator.generateFromSnapshots({
        executionSnapshot,
        htf1Snapshot: invalidHtfSnapshot,
      });
    }).toThrow(/HTF_LOOKAHEAD_VIOLATION/);
  });

  // ============================================================
  // 5, 6, 7. Source Separation & Provider Isolation
  // ============================================================
  it('5. BACKTEST mode asserts and rejects live feed usage', () => {
    expect(() => {
      MarketDataSourcePolicy.assertAllowedSource(MarketDataSourceMode.BACKTEST, 'LIVE');
    }).toThrow(/Live feed is prohibited under BACKTEST mode/);
  });

  it('6. LEARNING mode asserts and rejects live feed usage', () => {
    expect(() => {
      MarketDataSourcePolicy.assertAllowedSource(MarketDataSourceMode.LEARNING, 'LIVE');
    }).toThrow(/Live feed is prohibited under LEARNING mode/);
  });

  it('7. LIVE_DECISION mode asserts and rejects historical/DB provider usage', () => {
    expect(() => {
      MarketDataSourcePolicy.assertAllowedSource(MarketDataSourceMode.LIVE_DECISION, 'HISTORICAL');
    }).toThrow(/Source 'HISTORICAL' is prohibited under LIVE_DECISION/);

    expect(() => {
      MarketDataSourcePolicy.assertAllowedSource(MarketDataSourceMode.LIVE_DECISION, 'DELAYED');
    }).toThrow(/Source 'DELAYED' is prohibited under LIVE_DECISION/);
  });

  // ============================================================
  // 8. Invalid Timeframe Fails Closed
  // ============================================================
  it('8. toPrismaTimeframe throws INVALID_TIMEFRAME on invalid input and toPrismaTimeframeOrDefault handles UI fallback', () => {
    expect(() => toPrismaTimeframe('invalid')).toThrow(/INVALID_TIMEFRAME/);
    expect(() => toPrismaTimeframe('')).toThrow(/INVALID_TIMEFRAME/);
    expect(() => toPrismaTimeframe(null as any)).toThrow(/INVALID_TIMEFRAME/);
    expect(() => toPrismaTimeframe(undefined as any)).toThrow(/INVALID_TIMEFRAME/);

    expect(toPrismaTimeframe('15m')).toBe('M15');
    expect(toPrismaTimeframe('1h')).toBe('H1');
    expect(toPrismaTimeframe('4h')).toBe('H4');
    expect(toPrismaTimeframe('1d')).toBe('D1');
    expect(toPrismaTimeframe('1m')).toBe('M1');
    expect(toPrismaTimeframe('5m')).toBe('M5');

    expect(toPrismaTimeframeOrDefault('invalid')).toBe('M15');
    expect(toPrismaTimeframeOrDefault(null, Timeframe.H1)).toBe('H1');
  });

  // ============================================================
  // 9 & 10. Market Identity: XAUUSD Never Receives PAXGUSDT Data
  // ============================================================
  it('9 & 10. RealLiveMarketDataProvider decouples XAUUSD from PAXGUSDT and preserves market identity', async () => {
    const provider = new RealLiveMarketDataProvider();
    
    // Attempting to fetch XAUUSD should resolve to Yahoo GC=F, NOT Binance PAXGUSDT
    // We mock fetch to verify the destination URL
    const originalFetch = global.fetch;
    const fetchCalls: string[] = [];
    global.fetch = jest.fn().mockImplementation((url: string) => {
      fetchCalls.push(url);
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            chart: {
              result: [
                {
                  timestamp: [Math.floor(Date.now() / 1000)],
                  indicators: {
                    quote: [
                      {
                        open: [2850],
                        high: [2860],
                        low: [2845],
                        close: [2855],
                        volume: [1000],
                      },
                    ],
                  },
                },
              ],
            },
          }),
      });
    }) as any;

    try {
      await provider.getHistoricalCandles('XAUUSD', '15m', 10);
      expect(fetchCalls.length).toBeGreaterThan(0);
      expect(fetchCalls[0]).toContain('GC%3DF'); // Yahoo GC=F
      expect(fetchCalls[0]).not.toContain('PAXGUSDT'); // NEVER Binance PAXGUSDT
    } finally {
      global.fetch = originalFetch;
    }
  });

  // ============================================================
  // 11. Canonical Snapshot Path Is Deterministic
  // ============================================================
  it('11. Canonical snapshot construction and analysis is 100% deterministic', () => {
    const candles = createCandles(30, 15, 100);

    const snapshot1 = CanonicalMarketSnapshotBuilder.build({
      symbol: 'BTCUSDT',
      executionCandles: candles,
      executionTimeframe: Timeframe.M15,
      dataProvenance: 'LIVE',
    });

    const snapshot2 = CanonicalMarketSnapshotBuilder.build({
      symbol: 'BTCUSDT',
      executionCandles: candles,
      executionTimeframe: Timeframe.M15,
      dataProvenance: 'LIVE',
    });

    const analysis1 = SMCAnalyzer.analyzeSnapshot(snapshot1);
    const analysis2 = SMCAnalyzer.analyzeSnapshot(snapshot2);

    expect(analysis1.currentTrend).toBe(analysis2.currentTrend);
    expect(analysis1.candlesCount).toBe(analysis2.candlesCount);
    expect(analysis1.swingPoints.length).toBe(analysis2.swingPoints.length);
  });

  // ============================================================
  // 13. Canonical Provenance Is Preserved End-to-End
  // ============================================================
  it('13. Canonical provenance is preserved explicitly for LIVE, BACKTEST, and LEARNING', () => {
    const candles = createCandles(20, 15, 100);

    const liveSnap = CanonicalMarketSnapshotBuilder.build({
      symbol: 'BTCUSDT',
      executionCandles: candles,
      executionTimeframe: Timeframe.M15,
      dataProvenance: 'LIVE',
    });
    expect(liveSnap.dataProvenance).toBe('LIVE');

    const backtestSnap = CanonicalMarketSnapshotBuilder.build({
      symbol: 'BTCUSDT',
      executionCandles: candles,
      executionTimeframe: Timeframe.M15,
      dataProvenance: 'BACKTEST',
    });
    expect(backtestSnap.dataProvenance).toBe('BACKTEST');

    const learningSnap = CanonicalMarketSnapshotBuilder.build({
      symbol: 'BTCUSDT',
      executionCandles: candles,
      executionTimeframe: Timeframe.M15,
      dataProvenance: 'LEARNING',
    });
    expect(learningSnap.dataProvenance).toBe('LEARNING');
  });

  // ============================================================
  // 14 & 15. Inactive & Unknown Instruments Fail Closed
  // ============================================================
  it('14. Inactive instrument fails closed during snapshot construction', () => {
    const candles = createCandles(20, 15, 100);

    // If an instrument is inactive in registry
    expect(() => {
      CanonicalMarketSnapshotBuilder.build({
        symbol: 'INACTIVE_COIN',
        executionCandles: candles,
        executionTimeframe: Timeframe.M15,
      });
    }).toThrow(/FAIL-CLOSED/);
  });

  it('15. Unknown instrument fails closed during snapshot construction', () => {
    const candles = createCandles(20, 15, 100);

    expect(() => {
      CanonicalMarketSnapshotBuilder.build({
        symbol: 'UNKNOWN_RANDOM_SYMBOL_123',
        executionCandles: candles,
        executionTimeframe: Timeframe.M15,
      });
    }).toThrow(/FAIL-CLOSED/);
  });

  // ============================================================
  // LIVE_DECISION Historical asOf Rejection
  // ============================================================
  it('LIVE_DECISION rejects historical asOfTimestamp queries', () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

    expect(() => {
      MarketDataSourcePolicy.resolveSource(MarketDataSourceMode.LIVE_DECISION, {
        hasLiveFeed: true,
        symbol: 'BTCUSDT',
        asOfTimestamp: twoDaysAgo,
        timeframeDurationMs: 15 * 60 * 1000,
      });
    }).toThrow(/LIVE_DECISION AS-OF REJECTED/);
  });
});
