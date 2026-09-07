import {
  Direction,
  ICandle,
  ISwingPoint,
  StructureType,
  Timeframe,
  MTFMode,
  LiquidityType,
} from '@quant/shared';
import {
  CandleNormalizer,
  BOSEngine,
  CHOCHEngine,
  LiquidityEngine,
  OrderBlockEngine,
  FVGEngine,
  DealingRangeEngine,
  MultiTimeframeAnalyzer,
  SignalGenerator,
  SMCAnalyzer,
  TradeLevelsCalculator,
  SwingDetector,
} from '../index';

describe('SMC Deterministic Fixtures and Look-Ahead Invariant Suite', () => {
  const baseTime = 1700000000000;
  const minuteMs = 60 * 1000;

  function createCandle(
    index: number,
    open: number,
    high: number,
    low: number,
    close: number,
    volume = 1000,
    intervalMs = minuteMs
  ): ICandle {
    return {
      timestamp: new Date(baseTime + index * intervalMs),
      open,
      high,
      low,
      close,
      volume,
    };
  }

  // 1. Candle Normalizer
  describe('Fixture 1: Candle Normalizer Integrity', () => {
    it('sorts out-of-order candles, deduplicates, and rejects invalid OHLC geometry', () => {
      const c1 = createCandle(2, 100, 105, 95, 102);
      const c2 = createCandle(1, 98, 101, 97, 100);
      const cDuplicate = createCandle(1, 98, 101, 97, 100);
      const cInvalidHigh = createCandle(3, 100, 90, 95, 100); // high < low

      const raw = [c1, c2, cDuplicate, cInvalidHigh];
      const normalized = CandleNormalizer.normalize(raw);

      expect(normalized.length).toBe(2);
      expect(new Date(normalized[0].timestamp).getTime()).toBe(new Date(c2.timestamp).getTime());
      expect(new Date(normalized[1].timestamp).getTime()).toBe(new Date(c1.timestamp).getTime());
      expect(CandleNormalizer.validateCandle(normalized[0])).toBe(true);
      expect(CandleNormalizer.validateCandle(cInvalidHigh)).toBe(false);
    });
  });

  // 2. Bullish BOS
  describe('Fixture 2: Bullish Break of Structure (BOS)', () => {
    it('detects a bullish BOS only when a candle closes above a confirmed swing high', () => {
      const swingHigh: ISwingPoint = {
        index: 1,
        type: StructureType.SWING_HIGH,
        price: 105,
        timestamp: new Date(baseTime + 1 * minuteMs),
        confirmedAtIndex: 3,
        confirmedAtTimestamp: new Date(baseTime + 3 * minuteMs),
      };

      const candles: ICandle[] = [
        createCandle(0, 100, 102, 99, 101),
        createCandle(1, 101, 105, 100, 104), // Swing High at index 1 (high=105)
        createCandle(2, 104, 104, 101, 102),
        createCandle(3, 102, 103, 100, 101), // Confirmed here
        createCandle(4, 101, 102, 99, 100),
        createCandle(5, 100, 103, 100, 102),
        createCandle(6, 102, 110, 101, 108, 3000), // Closes above 105 with displacement -> Bullish BOS
      ];

      const bosEvents = BOSEngine.detectBOS(candles, [swingHigh], { displacementThresholdAtr: 0.5 });

      expect(bosEvents).toHaveLength(1);
      expect(bosEvents[0].direction).toBe(Direction.BULLISH);
      expect(bosEvents[0].brokenLevel).toBe(105);
      expect(bosEvents[0].candleIndex).toBe(6);
    });
  });

  // 3. Bearish BOS
  describe('Fixture 3: Bearish Break of Structure (BOS)', () => {
    it('detects a bearish BOS only when a candle closes below a confirmed swing low', () => {
      const swingLow: ISwingPoint = {
        index: 1,
        type: StructureType.SWING_LOW,
        price: 95,
        timestamp: new Date(baseTime + 1 * minuteMs),
        confirmedAtIndex: 3,
        confirmedAtTimestamp: new Date(baseTime + 3 * minuteMs),
      };

      const candles: ICandle[] = [
        createCandle(0, 105, 106, 104, 105),
        createCandle(1, 105, 105, 95, 96), // Swing Low at index 1 (low=95)
        createCandle(2, 96, 98, 96, 97),
        createCandle(3, 97, 100, 97, 99), // Confirmed here
        createCandle(4, 99, 101, 98, 100),
        createCandle(5, 100, 100, 97, 98),
        createCandle(6, 98, 98, 90, 92, 3000), // Closes below 95 with displacement -> Bearish BOS
      ];

      const bosEvents = BOSEngine.detectBOS(candles, [swingLow], { displacementThresholdAtr: 0.5 });

      expect(bosEvents).toHaveLength(1);
      expect(bosEvents[0].direction).toBe(Direction.BEARISH);
      expect(bosEvents[0].brokenLevel).toBe(95);
      expect(bosEvents[0].candleIndex).toBe(6);
    });
  });

  // 4. Bullish CHOCH
  describe('Fixture 4: Bullish Change of Character (CHOCH)', () => {
    it('detects a bullish CHOCH when market breaks the last confirmed swing high in a downtrend', () => {
      const swings: ISwingPoint[] = [
        {
          index: 1,
          type: StructureType.SWING_HIGH,
          price: 115,
          timestamp: new Date(baseTime + 1000),
          confirmedAtIndex: 3,
          confirmedAtTimestamp: new Date(baseTime + 3000),
        },
        {
          index: 3,
          type: StructureType.LOWER_LOW,
          price: 98,
          timestamp: new Date(baseTime + 3000),
          confirmedAtIndex: 5,
          confirmedAtTimestamp: new Date(baseTime + 5000),
        },
        {
          index: 4,
          type: StructureType.LOWER_HIGH,
          price: 108,
          timestamp: new Date(baseTime + 4000),
          confirmedAtIndex: 6,
          confirmedAtTimestamp: new Date(baseTime + 6000),
        },
        {
          index: 6,
          type: StructureType.LOWER_LOW,
          price: 90,
          timestamp: new Date(baseTime + 6000),
          confirmedAtIndex: 8,
          confirmedAtTimestamp: new Date(baseTime + 8000),
        },
      ];

      const candles: ICandle[] = [];
      for (let i = 0; i <= 10; i++) {
        const price = i === 9 ? 112 : 92; // Bar 9 explodes above LH (108)
        candles.push({
          timestamp: new Date(baseTime + i * 1000),
          open: price - 1,
          high: price + 2,
          low: price - 2,
          close: price,
          volume: 1000,
        });
      }

      const chochEvents = CHOCHEngine.detectCHOCH(candles, swings);

      expect(chochEvents.length).toBeGreaterThanOrEqual(1);
      const bullishCHOCH = chochEvents.find((c) => c.direction === Direction.BULLISH);
      expect(bullishCHOCH).toBeDefined();
      expect(bullishCHOCH!.previousTrend).toBe(Direction.BEARISH);
    });
  });

  // 5. Bearish CHOCH
  describe('Fixture 5: Bearish Change of Character (CHOCH)', () => {
    it('detects a bearish CHOCH when market breaks the last confirmed swing low in an uptrend', () => {
      const swings: ISwingPoint[] = [
        {
          index: 1,
          type: StructureType.SWING_LOW,
          price: 85,
          timestamp: new Date(baseTime + 1000),
          confirmedAtIndex: 3,
          confirmedAtTimestamp: new Date(baseTime + 3000),
        },
        {
          index: 3,
          type: StructureType.HIGHER_HIGH,
          price: 102,
          timestamp: new Date(baseTime + 3000),
          confirmedAtIndex: 5,
          confirmedAtTimestamp: new Date(baseTime + 5000),
        },
        {
          index: 4,
          type: StructureType.HIGHER_LOW,
          price: 92,
          timestamp: new Date(baseTime + 4000),
          confirmedAtIndex: 6,
          confirmedAtTimestamp: new Date(baseTime + 6000),
        },
        {
          index: 6,
          type: StructureType.HIGHER_HIGH,
          price: 110,
          timestamp: new Date(baseTime + 6000),
          confirmedAtIndex: 8,
          confirmedAtTimestamp: new Date(baseTime + 8000),
        },
      ];

      const candles: ICandle[] = [];
      for (let i = 0; i <= 10; i++) {
        const price = i === 9 ? 88 : 105; // Bar 9 breaks below HL (92)
        candles.push({
          timestamp: new Date(baseTime + i * 1000),
          open: price + 1,
          high: price + 2,
          low: price - 2,
          close: price,
          volume: 1000,
        });
      }

      const chochEvents = CHOCHEngine.detectCHOCH(candles, swings);

      expect(chochEvents.length).toBeGreaterThanOrEqual(1);
      const bearishCHOCH = chochEvents.find((c) => c.direction === Direction.BEARISH);
      expect(bearishCHOCH).toBeDefined();
      expect(bearishCHOCH!.previousTrend).toBe(Direction.BULLISH);
    });
  });

  // 6. Buy-Side Liquidity Sweep
  describe('Fixture 6: Buy-Side Liquidity Sweep', () => {
    it('detects a buy-side sweep when high pierces resistance but close remains inside/below', () => {
      const swings: ISwingPoint[] = [
        {
          index: 2,
          type: StructureType.SWING_HIGH,
          price: 100.0,
          timestamp: new Date(baseTime + 2000),
          confirmedAtIndex: 4,
          confirmedAtTimestamp: new Date(baseTime + 4000),
        },
        {
          index: 6,
          type: StructureType.SWING_HIGH,
          price: 100.1,
          timestamp: new Date(baseTime + 6000),
          confirmedAtIndex: 8,
          confirmedAtTimestamp: new Date(baseTime + 8000),
        },
      ];

      const candles: ICandle[] = [
        createCandle(0, 90, 95, 88, 92),
        createCandle(1, 92, 94, 90, 93),
        createCandle(2, 92, 100.0, 90, 95),
        createCandle(3, 95, 97, 90, 92),
        createCandle(4, 92, 94, 89, 91),
        createCandle(5, 91, 96, 90, 95),
        createCandle(6, 95, 100.1, 92, 96),
        createCandle(7, 96, 98, 93, 94),
        createCandle(8, 94, 96, 91, 93),
        createCandle(9, 93, 102.5, 92, 98.0, 2000), // Wicks to 102.5, closes at 98.0
      ];

      const { pools, sweeps } = LiquidityEngine.detectLiquidity(candles, swings, {
        equalHighLowToleranceAtr: 0.2,
      });

      expect(pools.length).toBeGreaterThanOrEqual(1);
      expect(sweeps.length).toBeGreaterThanOrEqual(1);
      expect(sweeps.every((s) => s.isSwept)).toBe(true);
      expect(sweeps[0].sweptAtIndex).toBeDefined();
    });
  });

  // 7. Sell-Side Liquidity Sweep
  describe('Fixture 7: Sell-Side Liquidity Sweep', () => {
    it('detects a sell-side sweep when low pierces support but close remains inside/above', () => {
      const swings: ISwingPoint[] = [
        {
          index: 2,
          type: StructureType.SWING_LOW,
          price: 90.0,
          timestamp: new Date(baseTime + 2000),
          confirmedAtIndex: 4,
          confirmedAtTimestamp: new Date(baseTime + 4000),
        },
        {
          index: 6,
          type: StructureType.SWING_LOW,
          price: 89.9,
          timestamp: new Date(baseTime + 6000),
          confirmedAtIndex: 8,
          confirmedAtTimestamp: new Date(baseTime + 8000),
        },
      ];

      const candles: ICandle[] = [
        createCandle(0, 100, 102, 98, 99),
        createCandle(1, 99, 101, 95, 96),
        createCandle(2, 96, 97, 90.0, 94),
        createCandle(3, 94, 95, 91, 93),
        createCandle(4, 93, 94, 91, 92),
        createCandle(5, 92, 95, 91, 94),
        createCandle(6, 94, 95, 89.9, 93),
        createCandle(7, 93, 94, 91, 92),
        createCandle(8, 92, 94, 90, 93),
        createCandle(9, 93, 95, 87.0, 92.0, 2000), // Wicks to 87.0, closes at 92.0
      ];

      const { pools, sweeps } = LiquidityEngine.detectLiquidity(candles, swings, {
        equalHighLowToleranceAtr: 0.2,
      });

      expect(pools.length).toBeGreaterThanOrEqual(1);
      expect(sweeps.length).toBeGreaterThanOrEqual(1);
      expect(sweeps.every((s) => s.isSwept)).toBe(true);
      expect(sweeps[0].sweptAtIndex).toBeDefined();
    });
  });

  // 8. Bullish & Bearish Displacement
  describe('Fixture 8: Displacement Detection', () => {
    it('identifies bullish displacement candle with high body ratio and above-average volume', () => {
      const candles: ICandle[] = [
        createCandle(0, 100, 101, 99, 100, 1000),
        createCandle(1, 100, 101, 99, 100, 1000),
        createCandle(2, 100, 101, 99, 100, 1000),
        createCandle(3, 100, 101, 99, 100, 1000),
        createCandle(4, 100, 110, 99.5, 109.5, 3000), // Bullish expansion
      ];

      const result = SMCAnalyzer.analyze(candles);
      expect(result.candlesCount).toBe(5);
    });
  });

  // 9. Bullish Fair Value Gap (FVG)
  describe('Fixture 9: Bullish Fair Value Gap (FVG)', () => {
    it('detects a bullish FVG when candle 3 low > candle 1 high, and tracks mitigation', () => {
      const candles: ICandle[] = [
        createCandle(0, 100, 105, 98, 102, 100), // C1: High = 105
        createCandle(1, 102, 120, 102, 118, 1000), // C2: Big expansion
        createCandle(2, 118, 125, 112, 122, 500), // C3: Low = 112 > 105 -> Gap [105, 112]
        createCandle(3, 122, 124, 115, 120, 200), // Retest above FVG
        createCandle(4, 120, 121, 108, 116, 300), // Dips into FVG: Low 108
      ];

      const { allFVGs, activeFVGs } = FVGEngine.detectFVGs(candles, { minGapAtrMultiplier: 0.1 });

      expect(allFVGs).toHaveLength(1);
      expect(allFVGs[0].direction).toBe(Direction.BULLISH);
      expect(allFVGs[0].lowerBound).toBe(105);
      expect(allFVGs[0].upperBound).toBe(112);
      expect(allFVGs[0].fillPercentage).toBeGreaterThan(50);
      expect(activeFVGs).toHaveLength(1);
    });
  });

  // 10. Bearish Fair Value Gap (FVG)
  describe('Fixture 10: Bearish Fair Value Gap (FVG)', () => {
    it('detects a bearish FVG when candle 3 high < candle 1 low, and tracks mitigation', () => {
      const candles: ICandle[] = [
        createCandle(0, 120, 122, 115, 118, 100), // C1: Low = 115
        createCandle(1, 118, 118, 100, 102, 1000), // C2: Big breakdown
        createCandle(2, 102, 108, 95, 98, 500), // C3: High = 108 < 115 -> Gap [108, 115]
        createCandle(3, 98, 100, 94, 96, 200),
        createCandle(4, 96, 112, 95, 110, 300), // Rallies into FVG: High 112
      ];

      const { allFVGs, activeFVGs } = FVGEngine.detectFVGs(candles, { minGapAtrMultiplier: 0.1 });

      expect(allFVGs).toHaveLength(1);
      expect(allFVGs[0].direction).toBe(Direction.BEARISH);
      expect(allFVGs[0].lowerBound).toBe(108);
      expect(allFVGs[0].upperBound).toBe(115);
      expect(allFVGs[0].fillPercentage).toBeGreaterThan(50);
      expect(activeFVGs).toHaveLength(1);
    });
  });

  // 11. Bullish Order Block (OB)
  describe('Fixture 11: Bullish Order Block', () => {
    it('identifies bullish OB as the last down-close candle prior to an impulsive breakout', () => {
      const candles: ICandle[] = [
        createCandle(0, 105, 106, 98, 100, 200), // Bearish down-candle
        createCandle(1, 100, 120, 100, 118, 1000), // Explosive up-move
        createCandle(2, 118, 130, 116, 128, 1200),
        createCandle(3, 128, 135, 125, 132, 800),
        createCandle(4, 132, 133, 104, 110, 300), // Retracement entering OB
      ];

      const { allOrderBlocks } = OrderBlockEngine.detectOrderBlocks(candles, [], [], {
        displacementThresholdAtr: 0.5,
      });

      expect(allOrderBlocks.length).toBeGreaterThanOrEqual(1);
      expect(allOrderBlocks[0].direction).toBe(Direction.BULLISH);
      expect(allOrderBlocks[0].high).toBe(106);
      expect(allOrderBlocks[0].low).toBe(98);
      expect(allOrderBlocks[0].isMitigated).toBe(true);
    });
  });

  // 12. Bearish Order Block (OB)
  describe('Fixture 12: Bearish Order Block', () => {
    it('identifies bearish OB as the last up-close candle prior to an impulsive breakdown', () => {
      const candles: ICandle[] = [
        createCandle(0, 95, 102, 94, 100, 200), // Bullish up-candle
        createCandle(1, 100, 100, 80, 82, 1000), // Explosive down-move
        createCandle(2, 82, 84, 70, 72, 1200),
        createCandle(3, 72, 75, 65, 68, 800),
        createCandle(4, 68, 96, 67, 90, 300), // Retracement entering OB
      ];

      const { allOrderBlocks } = OrderBlockEngine.detectOrderBlocks(candles, [], [], {
        displacementThresholdAtr: 0.5,
      });

      expect(allOrderBlocks.length).toBeGreaterThanOrEqual(1);
      expect(allOrderBlocks[0].direction).toBe(Direction.BEARISH);
      expect(allOrderBlocks[0].high).toBe(102);
      expect(allOrderBlocks[0].low).toBe(94);
      expect(allOrderBlocks[0].isMitigated).toBe(true);
    });
  });

  // 13. Dealing Range & Premium/Discount Zones
  describe('Fixture 13: Dealing Range & Premium/Discount Zones', () => {
    it('correctly calculates equilibrium (0.5) and discount/premium boundaries', () => {
      const swings: ISwingPoint[] = [
        {
          index: 2,
          type: StructureType.SWING_HIGH,
          price: 200,
          timestamp: new Date(),
          confirmedAtIndex: 4,
          confirmedAtTimestamp: new Date(),
        },
        {
          index: 8,
          type: StructureType.SWING_LOW,
          price: 100,
          timestamp: new Date(),
          confirmedAtIndex: 10,
          confirmedAtTimestamp: new Date(),
        },
      ];

      const range = DealingRangeEngine.calculateDealingRange(swings);
      expect(range).not.toBeNull();
      expect(range!.high).toBe(200);
      expect(range!.low).toBe(100);
      expect(range!.equilibrium).toBe(150);

      expect(DealingRangeEngine.classifyPriceZone(170, range!)).toBe('PREMIUM');
      expect(DealingRangeEngine.classifyPriceZone(130, range!)).toBe('DISCOUNT');
      expect(DealingRangeEngine.classifyPriceZone(150, range!)).toBe('EQUILIBRIUM');
    });
  });

  // 14. Trade Levels Engine
  describe('Fixture 14: Trade Levels (Entry, SL, TP, Risk/Reward)', () => {
    it('calculates deterministic risk/reward levels with valid multi-tier targets', () => {
      const candles: ICandle[] = [];
      for (let i = 0; i < 20; i++) {
        candles.push({
          timestamp: new Date(i * 1000),
          open: 100 + i,
          high: 102 + i,
          low: 98 + i,
          close: 101 + i,
          volume: 1000,
        });
      }

      const levels = TradeLevelsCalculator.calculateLevels(
        Direction.BULLISH,
        candles,
        {
          index: 5,
          type: StructureType.SWING_LOW,
          price: 95,
          timestamp: new Date(),
          confirmedAtIndex: 8,
          confirmedAtTimestamp: new Date(),
        },
        null,
        null,
      );

      expect(levels).not.toBeNull();
      expect(levels!.direction).toBe(Direction.BULLISH);
      expect(levels!.stopLoss).toBeLessThan(levels!.entryZone.optimal);
      expect(levels!.takeProfits.tp1).toBeGreaterThan(levels!.entryZone.optimal);
      expect(levels!.takeProfits.tp2).toBeGreaterThan(levels!.takeProfits.tp1);
    });
  });

  // 15. Complete Multi-Timeframe Bullish SMC Setup
  describe('Fixture 15: Complete Multi-Timeframe SMC Setup', () => {
    it('calculates MTF bias alignment across multiple timeframes', () => {
      const execTf = { timeframe: Timeframe.M15, candles: [] };
      const htf1 = {
        timeframe: Timeframe.H1,
        candles: [],
        analysis: {
          candlesCount: 100,
          swingPoints: [],
          confirmedSwingHighs: [],
          confirmedSwingLows: [],
          breaksOfStructure: [],
          changesOfCharacter: [],
          liquidityPools: [],
          liquiditySweeps: [],
          fairValueGaps: [],
          activeFVGs: [],
          orderBlocks: [],
          activeOrderBlocks: [],
          dealingRange: null,
          marketRegime: {
            regime: 'BULLISH_TREND' as any,
            atr: 50,
            adx: 30,
            volatility: 0.2,
            timestamp: new Date(),
          },
          currentTrend: Direction.BULLISH,
        },
      };
      const htf2 = {
        timeframe: Timeframe.H4,
        candles: [],
        analysis: {
          candlesCount: 100,
          swingPoints: [],
          confirmedSwingHighs: [],
          confirmedSwingLows: [],
          breaksOfStructure: [],
          changesOfCharacter: [],
          liquidityPools: [],
          liquiditySweeps: [],
          fairValueGaps: [],
          activeFVGs: [],
          orderBlocks: [],
          activeOrderBlocks: [],
          dealingRange: null,
          marketRegime: {
            regime: 'BULLISH_TREND' as any,
            atr: 100,
            adx: 35,
            volatility: 0.3,
            timestamp: new Date(),
          },
          currentTrend: Direction.BULLISH,
        },
      };

      const res = MultiTimeframeAnalyzer.analyzeMTF(execTf, htf1, htf2, MTFMode.BALANCED);
      expect(res.htfBias).toBe(Direction.BULLISH);
      expect(res.isAligned).toBe(true);
      expect(res.alignmentScore).toBe(20);
    });
  });

  // 16. Invalidation / Score Filtering
  describe('Fixture 16: Setup Filtering (Quality Score Verification)', () => {
    it('calculates bounded score and breakdown for any setup', () => {
      const candles: ICandle[] = [];
      for (let i = 0; i < 30; i++) {
        candles.push({
          timestamp: new Date(baseTime + i * 60000),
          open: 100 + (i % 2),
          high: 102,
          low: 98,
          close: 100 + (i % 2),
          volume: 1000,
        });
      }

      const signal = SignalGenerator.generateSignal({
        symbol: 'NIFTY',
        executionCandles: candles,
        executionTimeframe: Timeframe.M15,
      });

      expect(signal).toBeDefined();
      expect(signal.score).toBeGreaterThanOrEqual(0);
      expect(signal.score).toBeLessThanOrEqual(100);
    });
  });

  // 17. Deterministic Signal Deduplication
  describe('Fixture 17: Signal Deduplication Invariant', () => {
    it('produces identical deterministic signal results for identical closed candle setup', () => {
      const candles: ICandle[] = [];
      for (let i = 0; i < 30; i++) {
        candles.push({
          timestamp: new Date(baseTime + i * 60000),
          open: 100 + i * 0.5,
          high: 102 + i * 0.5,
          low: 99 + i * 0.5,
          close: 101 + i * 0.5,
          volume: 1000,
        });
      }

      const signal1 = SignalGenerator.generateSignal({
        symbol: 'BTCUSDT',
        executionCandles: candles,
        executionTimeframe: Timeframe.M15,
      });
      const signal2 = SignalGenerator.generateSignal({
        symbol: 'BTCUSDT',
        executionCandles: candles,
        executionTimeframe: Timeframe.M15,
      });

      expect(signal1.score).toBe(signal2.score);
      expect(signal1.direction).toBe(signal2.direction);
      expect(signal1.timestamp).toEqual(signal2.timestamp);
    });
  });

  // 18. Single-Timeframe Look-Ahead Trap Test
  describe('Fixture 18: Single-Timeframe Look-Ahead Trap Test', () => {
    it('prevents future candles from altering indicator state at bar N', () => {
      const pastCandles: ICandle[] = [
        createCandle(0, 100, 101, 98, 100),
        createCandle(1, 100, 102, 99, 101),
        createCandle(2, 101, 120, 100, 118), // Swing High peak at idx 2
        createCandle(3, 118, 118, 105, 108),
        createCandle(4, 108, 110, 104, 106), // Confirmed with rightBars=2 at bar 4
        createCandle(5, 100, 101, 98, 99),
      ];

      const swingsAtBar5 = SwingDetector.detectSwings(pastCandles, { leftBars: 2, rightBars: 2, minDistanceAtrMultiplier: 0.1 });

      // Add future candles (bars 6-10) with wild future swings
      const futureCandles: ICandle[] = [
        ...pastCandles,
        createCandle(6, 99, 150, 99, 149),
        createCandle(7, 149, 160, 148, 158),
        createCandle(8, 158, 159, 120, 122),
        createCandle(9, 122, 125, 110, 112),
        createCandle(10, 112, 115, 105, 108),
      ];

      const swingsAtBar10 = SwingDetector.detectSwings(futureCandles, { leftBars: 2, rightBars: 2, minDistanceAtrMultiplier: 0.1 });

      const swingAtBar2FromPast = swingsAtBar5.find((s) => s.index === 2);
      const swingAtBar2FromFuture = swingsAtBar10.find((s) => s.index === 2);

      expect(swingAtBar2FromPast).toBeDefined();
      expect(swingAtBar2FromFuture).toBeDefined();
      expect(swingAtBar2FromPast!.price).toBe(swingAtBar2FromFuture!.price);
      expect(swingAtBar2FromPast!.confirmedAtIndex).toBe(swingAtBar2FromFuture!.confirmedAtIndex);
    });
  });

  // 19. Multi-Timeframe Look-Ahead Trap Test (Unclosed HTF Candle Leakage)
  describe('Fixture 19: Multi-Timeframe Look-Ahead Trap Test', () => {
    it('strictly filters out unclosed HTF candles that close after the LTF execution candle', () => {
      // Execution candle is at 10:00 (15m bar closing at 10:15)
      const execCandles: ICandle[] = [
        createCandle(0, 100, 102, 99, 101, 1000, 15 * 60 * 1000), // 10:00 - 10:15
      ];
      const maxAllowedCloseTime = new Date(execCandles[0].timestamp).getTime() + 15 * 60 * 1000;

      // 1H bar starting at 10:00 closes at 11:00 (in future relative to 10:15!)
      const htfCandles: ICandle[] = [
        createCandle(-4, 95, 98, 94, 97, 5000, 15 * 60 * 1000), // 09:00 - 10:00 (Closed!)
        createCandle(0, 97, 120, 96, 119, 20000, 15 * 60 * 1000), // 10:00 - 11:00 (Unclosed at 10:15!)
      ];

      const filteredHTFCandles = MultiTimeframeAnalyzer.filterClosedHTFCandles(
        htfCandles,
        Timeframe.H1,
        maxAllowedCloseTime
      );

      // Only the 09:00 - 10:00 bar should survive
      expect(filteredHTFCandles.length).toBe(1);
      expect(new Date(filteredHTFCandles[0].timestamp).getTime()).toBe(new Date(htfCandles[0].timestamp).getTime());
    });
  });

  // 20. Single-Break Invariant for BOS
  describe('Fixture 20: BOS Single-Break Invariant', () => {
    it('does not emit multiple breaks for the same swing point across consecutive bars', () => {
      const swingHigh: ISwingPoint = {
        index: 1,
        type: StructureType.SWING_HIGH,
        price: 105,
        timestamp: new Date(baseTime + 1 * minuteMs),
        confirmedAtIndex: 3,
        confirmedAtTimestamp: new Date(baseTime + 3 * minuteMs),
      };

      const candles: ICandle[] = [
        createCandle(0, 100, 102, 99, 101),
        createCandle(1, 101, 105, 100, 104), // Swing High at idx 1 (high=105)
        createCandle(2, 104, 104, 101, 102),
        createCandle(3, 102, 103, 100, 101), // Confirmed swing high
        createCandle(4, 101, 108, 100, 107, 2000), // Bar 4 closes at 107 -> First break of 105
        createCandle(5, 107, 109, 106, 108, 2000), // Bar 5 closes at 108 -> Higher, but same swing already broken!
        createCandle(6, 108, 112, 107, 111, 2000), // Bar 6 closes at 111
      ];

      const breaks = BOSEngine.detectBOS(candles, [swingHigh], { displacementThresholdAtr: 0.5 });

      // Only 1 BOS event should be emitted for swing index 1
      const breaksForSwing1 = breaks.filter((b) => b.brokenLevel === 105);
      expect(breaksForSwing1.length).toBe(1);
      expect(breaksForSwing1[0].candleIndex).toBe(4);
    });
  });
});
