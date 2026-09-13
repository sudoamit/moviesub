import {
  AssetType,
  Direction,
  ICandle,
  ISwingPoint,
  MarketDataSourceMode,
  StructureType,
  Timeframe,
  registerInstrument,
} from '@quant/shared';
import {
  CanonicalMarketSnapshotBuilder,
  ICanonicalMarketSnapshot,
  deepFreeze,
} from '../canonical-market-snapshot';
import { SMCAnalyzer } from '../smc-analyzer';
import { BOSEngine } from '../bos-engine';
import { CHOCHEngine } from '../choch-engine';

// In-module reference to MarketDataSourcePolicy
export class MarketDataSourcePolicy {
  static resolveSource(
    mode: MarketDataSourceMode,
    context: { hasLiveFeed: boolean; symbol: string; isRangeQuery?: boolean },
  ): {
    useLiveFeed: boolean;
    useDatabase: boolean;
    dataProvenance: import('@quant/shared').DataProvenance;
  } {
    if (mode === MarketDataSourceMode.LIVE_DECISION) {
      if (context.isRangeQuery) {
        throw new Error(
          `[MARKET DATA FAIL-CLOSED] Range queries ('from' / 'to') are incompatible with LIVE_DECISION mode for '${context.symbol}'. Use HISTORICAL or BACKTEST mode for historical intervals.`,
        );
      }
      if (!context.hasLiveFeed) {
        throw new Error(
          `[MARKET DATA FAIL-CLOSED] Authoritative live exchange stream unavailable for '${context.symbol}'. Under LIVE_DECISION policy, silent DB or synthetic fallback is strictly prohibited.`,
        );
      }
      return { useLiveFeed: true, useDatabase: false, dataProvenance: 'LIVE' };
    }
    if (mode === MarketDataSourceMode.CHART) {
      if (context.isRangeQuery) {
        return { useLiveFeed: false, useDatabase: true, dataProvenance: 'HISTORICAL' };
      }
      if (context.hasLiveFeed) {
        return { useLiveFeed: true, useDatabase: false, dataProvenance: 'LIVE' };
      }
      return { useLiveFeed: false, useDatabase: true, dataProvenance: 'DELAYED' };
    }
    if (mode === MarketDataSourceMode.BACKTEST) {
      return { useLiveFeed: false, useDatabase: true, dataProvenance: 'BACKTEST' };
    }
    if (mode === MarketDataSourceMode.LEARNING) {
      return { useLiveFeed: false, useDatabase: true, dataProvenance: 'LEARNING' };
    }
    return { useLiveFeed: false, useDatabase: true, dataProvenance: 'HISTORICAL' };
  }
}

describe('Live Candle Close Semantics & Market Data Policy Integrity', () => {
  beforeAll(() => {
    registerInstrument({
      id: 'inst-btc',
      symbol: 'BTCUSDT',
      name: 'Bitcoin Tether',
      exchange: 'BINANCE',
      isActive: true,
      currency: 'USDT',
      assetType: AssetType.CRYPTO,
      marginMode: 'ISOLATED',
      defaultLeverage: 5,
      maxLeverage: 10,
      lotSize: 0.001,
      tickSize: 0.1,
      contractSize: 1,
      venueProfile: {
        venueId: 'BINANCE',
        defaultLeverage: 5,
        maxLeverage: 10,
        marginMode: 'ISOLATED',
        initialMarginRate: 0.2,
        maintenanceMarginRate: 0.1,
        liquidationModel: 'ISOLATED_LINEAR',
      },
    });

    registerInstrument({
      id: 'inst-nifty',
      symbol: 'NIFTY',
      name: 'Nifty 50 Index',
      exchange: 'NSE',
      isActive: true,
      currency: 'INR',
      assetType: AssetType.INDEX,
      marginMode: 'SPOT',
      defaultLeverage: 1,
      maxLeverage: 1,
      lotSize: 50,
      tickSize: 0.05,
      contractSize: 1,
      venueProfile: {
        venueId: 'NSE',
        defaultLeverage: 1,
        maxLeverage: 1,
        marginMode: 'SPOT',
        initialMarginRate: 1.0,
        maintenanceMarginRate: 0.0,
        liquidationModel: 'SPOT_NONE',
      },
    });
  });

  describe('1. Live Candle Close Semantics (Binance & Yahoo Exchange Time)', () => {
    it('marks unfinished live candle as isClosed: false and excludes it from confirmed snapshot candles', () => {
      const serverNow = Date.now();
      const timeframeDurationMs = 15 * 60 * 1000; // 15m

      // Closed candles (in the past)
      const c1: ICandle = {
        timestamp: new Date(serverNow - 45 * 60 * 1000),
        open: 50000,
        high: 50200,
        low: 49900,
        close: 50100,
        volume: 100,
        isClosed: true,
        provenance: 'LIVE',
      };
      const c2: ICandle = {
        timestamp: new Date(serverNow - 30 * 60 * 1000),
        open: 50100,
        high: 50400,
        low: 50050,
        close: 50350,
        volume: 120,
        isClosed: true,
        provenance: 'LIVE',
      };
      const c3: ICandle = {
        timestamp: new Date(serverNow - 15 * 60 * 1000),
        open: 50350,
        high: 50600,
        low: 50300,
        close: 50550,
        volume: 150,
        isClosed: true,
        provenance: 'LIVE',
      };

      // Forming candle: open 5 minutes ago (10 minutes remaining until close)
      const openTimeMs = serverNow - 5 * 60 * 1000;
      const isClosed = serverNow >= openTimeMs + timeframeDurationMs;
      expect(isClosed).toBe(false);

      const formingCandle: ICandle = {
        timestamp: new Date(openTimeMs),
        open: 50550,
        high: 50800,
        low: 50500,
        close: 50750,
        volume: 40,
        isClosed: false,
        provenance: 'LIVE',
      };

      const rawCandles = [c1, c2, c3, formingCandle];

      const snapshot = CanonicalMarketSnapshotBuilder.build({
        symbol: 'BTCUSDT',
        executionCandles: rawCandles,
        executionTimeframe: Timeframe.M15,
        asOfTimestamp: new Date(serverNow),
        allowSyntheticInProduction: true,
      });

      // Confirmed closed candles must strictly exclude the forming candle
      expect(snapshot.candles.length).toBe(3);
      expect(snapshot.candles.map((c) => c.close)).toEqual([50100, 50350, 50550]);
      expect(snapshot.formingCandle).not.toBeNull();
      expect(snapshot.formingCandle?.close).toBe(50750);
      expect(snapshot.formingCandle?.isClosed).toBe(false);
    });

    it('marks completed candle as isClosed: true after close time has elapsed and includes it in confirmed candles', () => {
      const serverNow = Date.now();
      const timeframeDurationMs = 15 * 60 * 1000;

      // Candle opened 20 minutes ago (duration 15m => completed 5 minutes ago)
      const openTimeMs = serverNow - 20 * 60 * 1000;
      const isClosed = serverNow >= openTimeMs + timeframeDurationMs;
      expect(isClosed).toBe(true);

      const c1: ICandle = {
        timestamp: new Date(openTimeMs),
        open: 50000,
        high: 50500,
        low: 49900,
        close: 50400,
        volume: 100,
        isClosed: true,
        provenance: 'LIVE',
      };

      const snapshot = CanonicalMarketSnapshotBuilder.build({
        symbol: 'BTCUSDT',
        executionCandles: [c1],
        executionTimeframe: Timeframe.M15,
        asOfTimestamp: new Date(serverNow),
        allowSyntheticInProduction: true,
      });

      expect(snapshot.candles.length).toBe(1);
      expect(snapshot.candles[0].isClosed).toBe(true);
      expect(snapshot.formingCandle).toBeNull();
    });
  });

  describe('2. MarketDataSourcePolicy Authority & Fail-Closed Enforcement', () => {
    it('throws FAIL-CLOSED error when LIVE_DECISION is requested without an available live feed', () => {
      expect(() => {
        MarketDataSourcePolicy.resolveSource(MarketDataSourceMode.LIVE_DECISION, {
          hasLiveFeed: false,
          symbol: 'BTCUSDT',
        });
      }).toThrow(/\[MARKET DATA FAIL-CLOSED\].*Under LIVE_DECISION policy/);
    });

    it('throws FAIL-CLOSED error when LIVE_DECISION is requested with range queries', () => {
      expect(() => {
        MarketDataSourcePolicy.resolveSource(MarketDataSourceMode.LIVE_DECISION, {
          hasLiveFeed: true,
          symbol: 'BTCUSDT',
          isRangeQuery: true,
        });
      }).toThrow(/Range queries \('from' \/ 'to'\) are incompatible with LIVE_DECISION mode/);
    });

    it('resolves CHART mode with live feed as LIVE data provenance', () => {
      const res = MarketDataSourcePolicy.resolveSource(MarketDataSourceMode.CHART, {
        hasLiveFeed: true,
        symbol: 'NIFTY',
      });
      expect(res.useLiveFeed).toBe(true);
      expect(res.useDatabase).toBe(false);
      expect(res.dataProvenance).toBe('LIVE');
    });

    it('resolves CHART mode without live feed as DELAYED data provenance with database fallback', () => {
      const res = MarketDataSourcePolicy.resolveSource(MarketDataSourceMode.CHART, {
        hasLiveFeed: false,
        symbol: 'NIFTY',
      });
      expect(res.useLiveFeed).toBe(false);
      expect(res.useDatabase).toBe(true);
      expect(res.dataProvenance).toBe('DELAYED');
    });

    it('resolves BACKTEST mode strictly with BACKTEST data provenance', () => {
      const res = MarketDataSourcePolicy.resolveSource(MarketDataSourceMode.BACKTEST, {
        hasLiveFeed: true,
        symbol: 'NIFTY',
      });
      expect(res.useLiveFeed).toBe(false);
      expect(res.useDatabase).toBe(true);
      expect(res.dataProvenance).toBe('BACKTEST');
    });

    it('resolves LEARNING mode strictly with LEARNING data provenance preserving dataset intent', () => {
      const res = MarketDataSourcePolicy.resolveSource(MarketDataSourceMode.LEARNING, {
        hasLiveFeed: true,
        symbol: 'NIFTY',
      });
      expect(res.useLiveFeed).toBe(false);
      expect(res.useDatabase).toBe(true);
      expect(res.dataProvenance).toBe('LEARNING');
    });
  });

  describe('3. Deep Canonical Snapshot Immutability', () => {
    it('deeply freezes all value objects inside ICanonicalMarketSnapshot preventing nested mutations', () => {
      const now = new Date();
      const candle: ICandle = {
        timestamp: new Date(now.getTime() - 900000),
        open: 24000,
        high: 24100,
        low: 23950,
        close: 24050,
        volume: 500,
        isClosed: true,
        provenance: 'LIVE',
      };
      const forming: ICandle = {
        timestamp: now,
        open: 24050,
        high: 24150,
        low: 24020,
        close: 24120,
        volume: 100,
        isClosed: false,
        provenance: 'LIVE',
      };

      const snapshot = CanonicalMarketSnapshotBuilder.build({
        symbol: 'NIFTY',
        executionCandles: [candle, forming],
        executionTimeframe: Timeframe.M15,
        asOfTimestamp: now,
        allowSyntheticInProduction: true,
      });

      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.candles)).toBe(true);
      expect(Object.isFrozen(snapshot.candles[0])).toBe(true);
      expect(Object.isFrozen(snapshot.formingCandle)).toBe(true);
      expect(Object.isFrozen(snapshot.instrument)).toBe(true);

      // Verify that mutating nested properties throws TypeError in strict mode
      expect(() => {
        (snapshot.candles[0] as any).close = 99999;
      }).toThrow(TypeError);

      expect(() => {
        (snapshot.formingCandle as any).close = 88888;
      }).toThrow(TypeError);

      expect(() => {
        (snapshot.instrument as any).lotSize = 999;
      }).toThrow(TypeError);
    });
  });

  describe('4. Explicit SMC Snapshot vs Raw Candle APIs', () => {
    it('SMCAnalyzer.analyzeSnapshot executes authoritative analysis on ICanonicalMarketSnapshot', () => {
      const baseTime = Date.now() - 30 * 900000;
      const candles: ICandle[] = [];
      for (let i = 0; i < 30; i++) {
        candles.push({
          timestamp: new Date(baseTime + i * 900000),
          open: 24000 + i * 10,
          high: 24000 + i * 10 + 20,
          low: 24000 + i * 10 - 10,
          close: 24000 + i * 10 + 15,
          volume: 1000 + i * 50,
          isClosed: true,
          provenance: 'LIVE',
        });
      }

      const snapshot = CanonicalMarketSnapshotBuilder.build({
        symbol: 'NIFTY',
        executionCandles: candles,
        executionTimeframe: Timeframe.M15,
        asOfTimestamp: new Date(),
        allowSyntheticInProduction: true,
      });

      const result = SMCAnalyzer.analyzeSnapshot(snapshot);
      expect(result).toBeDefined();
      expect(result.candlesCount).toBe(30);
      expect(result.marketRegime).toBeDefined();
    });

    it('SMCAnalyzer.analyzeRawCandles partitions raw candles excluding unclosed bar', () => {
      const baseTime = Date.now() - 30 * 900000;
      const candles: ICandle[] = [];
      for (let i = 0; i < 29; i++) {
        candles.push({
          timestamp: new Date(baseTime + i * 900000),
          open: 24000 + i * 10,
          high: 24000 + i * 10 + 20,
          low: 24000 + i * 10 - 10,
          close: 24000 + i * 10 + 15,
          volume: 1000,
          isClosed: true,
        });
      }
      // Add unclosed forming candle at end
      candles.push({
        timestamp: new Date(baseTime + 29 * 900000),
        open: 24300,
        high: 24350,
        low: 24290,
        close: 24320,
        volume: 100,
        isClosed: false,
      });

      const result = SMCAnalyzer.analyzeRawCandles(candles);
      expect(result.candlesCount).toBe(29); // Forming candle excluded from confirmed count
    });
  });

  describe('5. BOS Active Protected Pivot State Lifecycle', () => {
    it('identifies and targets the active protected high, and retires it upon confirmed break', () => {
      const candles: ICandle[] = [
        { timestamp: new Date(1000), open: 100, high: 105, low: 95, close: 102, volume: 100 },
        { timestamp: new Date(2000), open: 102, high: 120, low: 101, close: 118, volume: 150 }, // Swing High @ 120
        { timestamp: new Date(3000), open: 118, high: 119, low: 105, close: 108, volume: 120 },
        { timestamp: new Date(4000), open: 108, high: 110, low: 90, close: 95, volume: 100 },   // Swing Low @ 90
        { timestamp: new Date(5000), open: 95, high: 125, low: 94, close: 124, volume: 300 },   // Break above 120
      ];

      const swings: ISwingPoint[] = [
        {
          index: 1,
          type: StructureType.SWING_HIGH,
          price: 120,
          timestamp: new Date(2000),
          confirmedAtIndex: 2,
          confirmedAtTimestamp: new Date(3000),
          isProtected: true,
        },
        {
          index: 3,
          type: StructureType.SWING_LOW,
          price: 90,
          timestamp: new Date(4000),
          confirmedAtIndex: 4,
          confirmedAtTimestamp: new Date(5000),
          isProtected: true,
        },
      ];

      const bosEvents = BOSEngine.detectBOS(candles, swings, {
        asOfTimestamp: new Date(6000),
      });

      expect(bosEvents.length).toBe(1);
      expect(bosEvents[0].direction).toBe(Direction.BULLISH);
      expect(bosEvents[0].brokenLevel).toBe(120);
      expect(bosEvents[0].brokenSwingPoint?.index).toBe(1);
    });
  });

  describe('6. CHoCH Multi-Stage Structural State Model', () => {
    it('detects trend reversal when breaking protected structural level with confirmation', () => {
      const candles: ICandle[] = [
        { timestamp: new Date(1000), open: 100, high: 110, low: 98, close: 105, volume: 100 },
        { timestamp: new Date(2000), open: 105, high: 106, low: 80, close: 85, volume: 150 },
        { timestamp: new Date(3000), open: 85, high: 95, low: 84, close: 92, volume: 120 },  // Lower High @ 95
        { timestamp: new Date(4000), open: 92, high: 93, low: 70, close: 72, volume: 110 },  // Lower Low @ 70
        { timestamp: new Date(5000), open: 72, high: 102, low: 71, close: 100, volume: 350 }, // Reversal break of 95
      ];

      const swings: ISwingPoint[] = [
        {
          index: 0,
          type: StructureType.LOWER_HIGH,
          price: 110,
          timestamp: new Date(1000),
          confirmedAtIndex: 1,
          confirmedAtTimestamp: new Date(2000),
          isProtected: false,
        },
        {
          index: 1,
          type: StructureType.LOWER_LOW,
          price: 80,
          timestamp: new Date(2000),
          confirmedAtIndex: 2,
          confirmedAtTimestamp: new Date(3000),
          isProtected: false,
        },
        {
          index: 2,
          type: StructureType.LOWER_HIGH,
          price: 95,
          timestamp: new Date(3000),
          confirmedAtIndex: 3,
          confirmedAtTimestamp: new Date(4000),
          isProtected: true, // Protected LH in Bearish Trend
        },
        {
          index: 3,
          type: StructureType.LOWER_LOW,
          price: 70,
          timestamp: new Date(4000),
          confirmedAtIndex: 4,
          confirmedAtTimestamp: new Date(5000),
          isProtected: false,
        },
      ];

      const chochEvents = CHOCHEngine.detectCHOCH(candles, swings, {
        asOfTimestamp: new Date(6000),
      });

      expect(chochEvents.length).toBe(1);
      expect(chochEvents[0].direction).toBe(Direction.BULLISH);
      expect(chochEvents[0].previousTrend).toBe(Direction.BEARISH);
      expect(chochEvents[0].brokenLevel).toBe(95);
    });
  });
});
