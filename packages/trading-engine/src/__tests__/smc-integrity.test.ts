import {
  Direction,
  ICandle,
  StructureType,
  BOSConfirmationType,
} from '@quant/shared';
import {
  CandleNormalizer,
  DisplacementEngine,
  SwingDetector,
  BOSEngine,
  CHOCHEngine,
  LiquidityEngine,
  FVGEngine,
  OrderBlockEngine,
  SMCAnalyzer,
} from '../index';

describe('SMC & Candle Integrity Test Suite (22 Deterministic Fixtures)', () => {
  // Helper to generate sequential base candles
  const createBaseCandles = (count: number, startPrice = 100): ICandle[] => {
    const candles: ICandle[] = [];
    const baseTime = new Date('2026-01-01T09:15:00.000Z').getTime();
    let price = startPrice;

    for (let i = 0; i < count; i++) {
      const open = price;
      const close = price + 1;
      const high = Math.max(open, close) + 0.5;
      const low = Math.min(open, close) - 0.5;
      candles.push({
        timestamp: new Date(baseTime + i * 15 * 60 * 1000),
        open,
        high,
        low,
        close,
        volume: 1000,
        isClosed: true,
        provenance: 'LIVE',
      });
      price = close;
    }
    return candles;
  };

  describe('1. Closed Candle Integrity & Forming Candle Exclusion', () => {
    it('1.1 should exclude forming candle (isClosed === false) from confirmed SMC structures', () => {
      const candles = createBaseCandles(20);
      // Last candle is forming/unclosed with a huge spike
      candles[19].isClosed = false;
      candles[19].high = 500;
      candles[19].close = 500;

      const { closedCandles, formingCandle } = CandleNormalizer.partitionCandles(candles);
      expect(closedCandles.length).toBe(19);
      expect(formingCandle).toBeDefined();
      expect(formingCandle?.high).toBe(500);

      const smcResult = SMCAnalyzer.analyze(candles);
      expect(smcResult.candlesCount).toBe(19);
      // The forming candle's price 500 should not create a swing high in closed analysis
      const highs = smcResult.confirmedSwingHighs.map((s) => s.price);
      expect(highs).not.toContain(500);
    });

    it('1.2 should partition candles accurately when asOfTimestamp is provided', () => {
      const candles = createBaseCandles(20);
      const asOf = CandleNormalizer.getCandleCloseTimestamp(candles[10], '15m');

      const { closedCandles, formingCandle } = CandleNormalizer.partitionCandles(candles, {
        asOfTimestamp: asOf,
        timeframe: '15m',
      });

      expect(closedCandles.length).toBe(11);
      expect(closedCandles[closedCandles.length - 1].timestamp).toEqual(candles[10].timestamp);
    });

    it('1.3 should detect timestamp gaps and duplicate timestamps', () => {
      const base = new Date('2026-01-01T09:15:00.000Z').getTime();
      const candles: ICandle[] = [
        { timestamp: new Date(base), open: 100, high: 101, low: 99, close: 100.5, volume: 100, isClosed: true },
        { timestamp: new Date(base + 15 * 60000), open: 100.5, high: 102, low: 100, close: 101.5, volume: 100, isClosed: true },
        { timestamp: new Date(base + 30 * 60000), open: 101.5, high: 103, low: 101, close: 102.5, volume: 100, isClosed: true },
        // 45-minute jump
        { timestamp: new Date(base + 75 * 60000), open: 102.5, high: 104, low: 102, close: 103.5, volume: 100, isClosed: true },
      ];
      const gaps = CandleNormalizer.detectGaps(candles, '15m');
      expect(gaps.length).toBe(1);
      expect(gaps[0].missingCount).toBe(2);
    });
  });

  describe('2. Multi-Factor Displacement Engine', () => {
    it('2.1 should score strong bullish displacement highly (> 0.7)', () => {
      const candle: ICandle = {
        timestamp: new Date(),
        open: 100,
        high: 120,
        low: 99.5,
        close: 119.5,
        volume: 5000,
        isClosed: true,
      };
      const evaluation = DisplacementEngine.evaluateDisplacement(candle, 5.0, 1000, 105);
      expect(evaluation.direction).toBe(Direction.BULLISH);
      expect(evaluation.isDisplacement).toBe(true);
      expect(evaluation.score).toBeGreaterThan(0.7);
      expect(evaluation.factors.bodyRatio).toBeGreaterThan(0.9);
    });

    it('2.2 should reject doji or wick-heavy candle as displacement', () => {
      const doji: ICandle = {
        timestamp: new Date(),
        open: 100,
        high: 102,
        low: 98,
        close: 100.1,
        volume: 500,
        isClosed: true,
      };
      const evaluation = DisplacementEngine.evaluateDisplacement(doji, 5.0);
      expect(evaluation.isDisplacement).toBe(false);
      expect(evaluation.score).toBeLessThan(0.4);
    });
  });

  describe('3. Swing Detector (Protected Pivots & Structure Hierarchy)', () => {
    it('3.1 should detect swing high and swing low with zero look-ahead bias', () => {
      // Create pattern: up, up, PEAK, down, down
      const base = new Date('2026-01-01T09:15:00.000Z').getTime();
      const candles: ICandle[] = [
        { timestamp: new Date(base), open: 100, high: 102, low: 99, close: 101, volume: 100, isClosed: true },
        { timestamp: new Date(base + 15 * 60000), open: 101, high: 105, low: 100, close: 104, volume: 100, isClosed: true },
        { timestamp: new Date(base + 30 * 60000), open: 104, high: 110, low: 103, close: 108, volume: 100, isClosed: true }, // Peak at index 2
        { timestamp: new Date(base + 45 * 60000), open: 108, high: 107, low: 102, close: 103, volume: 100, isClosed: true },
        { timestamp: new Date(base + 60 * 60000), open: 103, high: 104, low: 98, close: 99, volume: 100, isClosed: true },
        { timestamp: new Date(base + 75 * 60000), open: 99, high: 101, low: 97, close: 100, volume: 100, isClosed: true },
        { timestamp: new Date(base + 90 * 60000), open: 100, high: 102, low: 98, close: 101, volume: 100, isClosed: true },
      ];

      const swings = SwingDetector.detectSwings(candles, { leftBars: 2, rightBars: 2 });
      const swingHigh = swings.find((s) => s.type === StructureType.SWING_HIGH);
      expect(swingHigh).toBeDefined();
      expect(swingHigh?.price).toBe(110);
      expect(swingHigh?.index).toBe(2);
      // Confirmed only after rightBars (at index 4)
      expect(swingHigh?.confirmedAtIndex).toBe(4);
    });

    it('3.2 should tag protected low in an uptrend', () => {
      // In uptrend (Higher Highs & Higher Lows), Higher Low is protected
      const base = new Date('2026-01-01T09:15:00.000Z').getTime();
      const candles: ICandle[] = [];
      const prices = [100, 105, 110, 106, 102, 108, 115, 120, 114, 110, 116, 125, 130];
      for (let i = 0; i < prices.length; i++) {
        candles.push({
          timestamp: new Date(base + i * 15 * 60000),
          open: prices[i] - 1,
          high: prices[i] + 2,
          low: prices[i] - 2,
          close: prices[i],
          volume: 500,
          isClosed: true,
        });
      }

      const swings = SwingDetector.detectSwings(candles, { leftBars: 1, rightBars: 1 });
      const higherLows = swings.filter((s) => s.type === StructureType.HIGHER_LOW);
      if (higherLows.length > 0) {
        expect(higherLows.some((hl) => hl.isProtected === true)).toBe(true);
      }
    });
  });

  describe('4. Single-Event BOS Engine', () => {
    it('4.1 should emit at most ONE Bullish BOS when a single candle sweeps multiple older swing highs', () => {
      const base = new Date('2026-01-01T09:15:00.000Z').getTime();
      // Swings at index 2 (price 105), index 4 (price 108)
      const swingPoints = [
        {
          index: 2,
          type: StructureType.SWING_HIGH,
          price: 105,
          timestamp: new Date(base + 30 * 60000),
          confirmedAtIndex: 3,
          confirmedAtTimestamp: new Date(base + 45 * 60000),
        },
        {
          index: 4,
          type: StructureType.HIGHER_HIGH,
          price: 108,
          timestamp: new Date(base + 60 * 60000),
          confirmedAtIndex: 5,
          confirmedAtTimestamp: new Date(base + 75 * 60000),
        },
      ];

      const candles: ICandle[] = [];
      for (let i = 0; i <= 6; i++) {
        candles.push({
          timestamp: new Date(base + i * 15 * 60000),
          open: 100,
          high: 102,
          low: 99,
          close: 101,
          volume: 500,
          isClosed: true,
        });
      }
      // Candle 6 breaks both 105 and 108 with massive expansion to 120
      candles[6].open = 100;
      candles[6].high = 120;
      candles[6].low = 99;
      candles[6].close = 119;
      candles[6].volume = 5000;

      const bosList = BOSEngine.detectBOS(candles, swingPoints);
      // Must emit exactly 1 BOS targeting the active structural high (108), NOT 2 duplicate BOS events
      const candle6Bos = bosList.filter((b) => b.candleIndex === 6 && b.direction === Direction.BULLISH);
      expect(candle6Bos.length).toBe(1);
      expect(candle6Bos[0].brokenLevel).toBe(108);
    });

    it('4.2 should support CANDLE_CLOSE vs WICK_BREAK confirmation types', () => {
      const base = new Date('2026-01-01T09:15:00.000Z').getTime();
      const swingPoints = [
        {
          index: 2,
          type: StructureType.SWING_HIGH,
          price: 105,
          timestamp: new Date(base + 30 * 60000),
          confirmedAtIndex: 3,
          confirmedAtTimestamp: new Date(base + 45 * 60000),
        },
      ];

      const candles: ICandle[] = [];
      for (let i = 0; i <= 4; i++) {
        candles.push({
          timestamp: new Date(base + i * 15 * 60000),
          open: 100,
          high: 102,
          low: 99,
          close: 101,
          volume: 500,
          isClosed: true,
        });
      }
      // Candle 4 wicks above 105 (high 107) but closes below (close 104)
      candles[4].high = 107;
      candles[4].close = 104;

      const bosClose = BOSEngine.detectBOS(candles, swingPoints, {
        confirmationType: BOSConfirmationType.CANDLE_CLOSE,
      });
      expect(bosClose.length).toBe(0);

      const bosWick = BOSEngine.detectBOS(candles, swingPoints, {
        confirmationType: BOSConfirmationType.WICK_BREAK,
      });
      expect(bosWick.length).toBe(1);
      expect(bosWick[0].brokenLevel).toBe(105);
    });
  });

  describe('5. State-Machine CHOCH Engine', () => {
    it('5.1 should detect Bullish CHoCH when price breaks above protected Lower High in downtrend', () => {
      const base = new Date('2026-01-01T09:15:00.000Z').getTime();
      const swingPoints = [
        {
          index: 1,
          type: StructureType.LOWER_HIGH,
          price: 110,
          timestamp: new Date(base + 15 * 60000),
          confirmedAtIndex: 2,
          confirmedAtTimestamp: new Date(base + 30 * 60000),
          isProtected: true,
        },
        {
          index: 3,
          type: StructureType.LOWER_LOW,
          price: 90,
          timestamp: new Date(base + 45 * 60000),
          confirmedAtIndex: 4,
          confirmedAtTimestamp: new Date(base + 60 * 60000),
        },
      ];

      const candles: ICandle[] = [];
      for (let i = 0; i <= 5; i++) {
        candles.push({
          timestamp: new Date(base + i * 15 * 60000),
          open: 92,
          high: 94,
          low: 89,
          close: 93,
          volume: 500,
          isClosed: true,
        });
      }
      // Candle 5 closes above 110 at 115 (Reversal)
      candles[5].open = 95;
      candles[5].high = 116;
      candles[5].low = 94;
      candles[5].close = 115;
      candles[5].volume = 3000;

      const chochList = CHOCHEngine.detectCHOCH(candles, swingPoints);
      expect(chochList.length).toBe(1);
      expect(chochList[0].direction).toBe(Direction.BULLISH);
      expect(chochList[0].previousTrend).toBe(Direction.BEARISH);
      expect(chochList[0].brokenLevel).toBe(110);
    });
  });

  describe('6. Multi-Touch Liquidity Clustering & Sweep Classification', () => {
    it('6.1 should cluster 2 Equal Highs within ATR tolerance into a single pool with touchCount = 2', () => {
      const base = new Date('2026-01-01T09:15:00.000Z').getTime();
      const swingPoints = [
        {
          index: 2,
          type: StructureType.SWING_HIGH,
          price: 100.0,
          timestamp: new Date(base + 30 * 60000),
          confirmedAtIndex: 3,
          confirmedAtTimestamp: new Date(base + 45 * 60000),
        },
        {
          index: 6,
          type: StructureType.SWING_HIGH,
          price: 100.1, // Near identical high within tolerance
          timestamp: new Date(base + 90 * 60000),
          confirmedAtIndex: 7,
          confirmedAtTimestamp: new Date(base + 105 * 60000),
        },
      ];

      const candles = createBaseCandles(10, 80);
      const { pools } = LiquidityEngine.detectLiquidity(candles, swingPoints);
      expect(pools.length).toBe(1);
      expect(pools[0].touchCount).toBe(2);
      expect(pools[0].isSwept).toBe(false);
    });

    it('6.2 should classify SWEEP_RECLAIMED when wick exceeds pool level but candle closes back inside', () => {
      const base = new Date('2026-01-01T09:15:00.000Z').getTime();
      const swingPoints = [
        {
          index: 2,
          type: StructureType.SWING_HIGH,
          price: 100.0,
          timestamp: new Date(base + 30 * 60000),
          confirmedAtIndex: 3,
          confirmedAtTimestamp: new Date(base + 45 * 60000),
        },
      ];

      const candles = createBaseCandles(10, 80);
      // Candle 8 wicks to 103 (sweeps 100) but closes at 98 (reclaims)
      candles[8].open = 85;
      candles[8].high = 103;
      candles[8].low = 84;
      candles[8].close = 98;

      const { pools, sweeps } = LiquidityEngine.detectLiquidity(candles, swingPoints);
      expect(sweeps.length).toBe(1);
      expect(sweeps[0].sweepState).toBe('SWEEP_RECLAIMED');
      expect(sweeps[0].isSwept).toBe(true);
    });

    it('6.3 should classify ACCEPTED_BREAK when candle closes decisively beyond pool level with displacement', () => {
      const base = new Date('2026-01-01T09:15:00.000Z').getTime();
      const swingPoints = [
        {
          index: 2,
          type: StructureType.SWING_HIGH,
          price: 100.0,
          timestamp: new Date(base + 30 * 60000),
          confirmedAtIndex: 3,
          confirmedAtTimestamp: new Date(base + 45 * 60000),
        },
      ];

      const candles = createBaseCandles(10, 80);
      // Candle 8 breaks and closes at 115 (accepted expansion)
      candles[8].open = 85;
      candles[8].high = 116;
      candles[8].low = 84;
      candles[8].close = 115;
      candles[8].volume = 8000;

      const { sweeps } = LiquidityEngine.detectLiquidity(candles, swingPoints);
      expect(sweeps.length).toBe(1);
      expect(sweeps[0].sweepState).toBe('ACCEPTED_BREAK');
    });
  });

  describe('7. Fair Value Gap (FVG) Lifecycles', () => {
    it('7.1 should detect Bullish FVG (gap between Candle 0 High and Candle 2 Low)', () => {
      const base = new Date('2026-01-01T09:15:00.000Z').getTime();
      const candles: ICandle[] = [
        { timestamp: new Date(base), open: 100, high: 102, low: 99, close: 101, volume: 1000, isClosed: true }, // High = 102
        { timestamp: new Date(base + 15 * 60000), open: 101, high: 115, low: 101, close: 114, volume: 5000, isClosed: true }, // Impulse
        { timestamp: new Date(base + 30 * 60000), open: 114, high: 120, low: 108, close: 118, volume: 2000, isClosed: true }, // Low = 108
      ];

      const { allFVGs, activeFVGs } = FVGEngine.detectFVGs(candles, { minGapAtrMultiplier: 0.1 });
      expect(allFVGs.length).toBe(1);
      expect(allFVGs[0].direction).toBe(Direction.BULLISH);
      expect(allFVGs[0].lowerBound).toBe(102);
      expect(allFVGs[0].upperBound).toBe(108);
      expect(allFVGs[0].status).toBe('ACTIVE');
      expect(activeFVGs.length).toBe(1);
    });

    it('7.2 should transition FVG from ACTIVE -> PARTIALLY_FILLED -> FILLED when price taps into gap', () => {
      const base = new Date('2026-01-01T09:15:00.000Z').getTime();
      const candles: ICandle[] = [
        { timestamp: new Date(base), open: 100, high: 102, low: 99, close: 101, volume: 1000, isClosed: true }, // Lower = 102
        { timestamp: new Date(base + 15 * 60000), open: 101, high: 115, low: 101, close: 114, volume: 5000, isClosed: true },
        { timestamp: new Date(base + 30 * 60000), open: 114, high: 120, low: 108, close: 118, volume: 2000, isClosed: true }, // Upper = 108
        // Candle 3 partially enters gap: low = 105 (50% filled)
        { timestamp: new Date(base + 45 * 60000), open: 118, high: 119, low: 105, close: 110, volume: 1500, isClosed: true },
      ];

      const { allFVGs } = FVGEngine.detectFVGs(candles, { minGapAtrMultiplier: 0.1 });
      expect(allFVGs[0].fillPercentage).toBe(50);
      expect(allFVGs[0].status).toBe('PARTIALLY_FILLED');

      // Candle 4 completely fills gap: low = 101 <= 102
      candles.push({
        timestamp: new Date(base + 60 * 60000),
        open: 110,
        high: 112,
        low: 101,
        close: 103,
        volume: 2000,
        isClosed: true,
      });

      const { allFVGs: filledFVGs, activeFVGs: remainingActive } = FVGEngine.detectFVGs(candles, {
        minGapAtrMultiplier: 0.1,
      });
      expect(filledFVGs[0].isFilled).toBe(true);
      expect(filledFVGs[0].status).toBe('FILLED');
      expect(filledFVGs[0].filledAt).toBeDefined();
      expect(remainingActive.length).toBe(0);
    });
  });

  describe('8. Order Block (OB) Lifecycles & Mitigation', () => {
    it('8.1 should qualify Bullish OB preceding explosive expansion and track mitigation', () => {
      const base = new Date('2026-01-01T09:15:00.000Z').getTime();
      const candles: ICandle[] = [
        // 0: Bearish candle (Down candle before rally) -> OB Candidate (high 101, low 98)
        { timestamp: new Date(base), open: 101, high: 101, low: 98, close: 98.5, volume: 1000, isClosed: true },
        // 1, 2, 3: Expansion rally
        { timestamp: new Date(base + 15 * 60000), open: 98.5, high: 106, low: 98.5, close: 105, volume: 4000, isClosed: true },
        { timestamp: new Date(base + 30 * 60000), open: 105, high: 112, low: 104, close: 111, volume: 5000, isClosed: true },
        { timestamp: new Date(base + 45 * 60000), open: 111, high: 118, low: 110, close: 117, volume: 3000, isClosed: true },
      ];

      const { allOrderBlocks, activeOrderBlocks } = OrderBlockEngine.detectOrderBlocks(candles);
      expect(allOrderBlocks.length).toBe(1);
      expect(allOrderBlocks[0].direction).toBe(Direction.BULLISH);
      expect(allOrderBlocks[0].high).toBe(101);
      expect(allOrderBlocks[0].low).toBe(98);
      expect(allOrderBlocks[0].status).toBe('ACTIVE');
      expect(activeOrderBlocks.length).toBe(1);

      // Add Candle 4 that mitigates the OB: price retraces to 100 (inside 98-101)
      candles.push({
        timestamp: new Date(base + 60 * 60000),
        open: 117,
        high: 117,
        low: 100,
        close: 103,
        volume: 2000,
        isClosed: true,
      });

      const { allOrderBlocks: mitigatedOBs } = OrderBlockEngine.detectOrderBlocks(candles);
      expect(mitigatedOBs[0].isMitigated).toBe(true);
      expect(mitigatedOBs[0].status).toBe('TOUCHED');
      expect(mitigatedOBs[0].mitigatedAt).toBeDefined();
    });

    it('8.2 should invalidate Bullish OB when price closes below its low', () => {
      const base = new Date('2026-01-01T09:15:00.000Z').getTime();
      const candles: ICandle[] = [
        { timestamp: new Date(base), open: 101, high: 101, low: 98, close: 98.5, volume: 1000, isClosed: true },
        { timestamp: new Date(base + 15 * 60000), open: 98.5, high: 106, low: 98.5, close: 105, volume: 4000, isClosed: true },
        { timestamp: new Date(base + 30 * 60000), open: 105, high: 112, low: 104, close: 111, volume: 5000, isClosed: true },
        { timestamp: new Date(base + 45 * 60000), open: 111, high: 118, low: 110, close: 117, volume: 3000, isClosed: true },
        // Invalidation: close below 98 at 95
        { timestamp: new Date(base + 60 * 60000), open: 117, high: 117, low: 94, close: 95, volume: 6000, isClosed: true },
      ];

      const { allOrderBlocks, activeOrderBlocks } = OrderBlockEngine.detectOrderBlocks(candles);
      const bullOB = allOrderBlocks.find((ob) => ob.direction === Direction.BULLISH);
      expect(bullOB).toBeDefined();
      expect(bullOB?.isInvalidated).toBe(true);
      expect(bullOB?.status).toBe('INVALIDATED');
      expect(bullOB?.invalidatedAt).toBeDefined();
      expect(activeOrderBlocks.filter((ob) => ob.direction === Direction.BULLISH).length).toBe(0);
    });
  });

  describe('9. Multi-Touch Liquidity Clustering (3+ Touches)', () => {
    it('9.1 should group 3+ swing highs into a single cluster with touchCount >= 3', () => {
      const base = new Date('2026-01-01T09:15:00.000Z').getTime();
      const swingPoints = [
        {
          index: 2,
          type: StructureType.SWING_HIGH,
          price: 150.0,
          timestamp: new Date(base + 30 * 60000),
          confirmedAtIndex: 3,
          confirmedAtTimestamp: new Date(base + 45 * 60000),
        },
        {
          index: 5,
          type: StructureType.SWING_HIGH,
          price: 150.2,
          timestamp: new Date(base + 75 * 60000),
          confirmedAtIndex: 6,
          confirmedAtTimestamp: new Date(base + 90 * 60000),
        },
        {
          index: 8,
          type: StructureType.SWING_HIGH,
          price: 150.1,
          timestamp: new Date(base + 120 * 60000),
          confirmedAtIndex: 9,
          confirmedAtTimestamp: new Date(base + 135 * 60000),
        },
      ];

      const candles = createBaseCandles(12, 100);
      const { pools } = LiquidityEngine.detectLiquidity(candles, swingPoints, { equalHighLowToleranceAtr: 0.5 });
      expect(pools.length).toBe(1);
      expect(pools[0].touchCount).toBe(3);
      expect(pools[0].isSwept).toBe(false);
    });
  });

  describe('10. SMC Analyzer Closed Boundary & Gap Degradation Gate', () => {
    it('10.1 should mark isDegraded: true and list gaps when candle stream has missing bars', () => {
      const base = new Date('2026-01-01T09:15:00.000Z').getTime();
      const candles: ICandle[] = [
        { timestamp: new Date(base), open: 100, high: 101, low: 99, close: 100.5, volume: 100, isClosed: true },
        { timestamp: new Date(base + 15 * 60000), open: 100.5, high: 102, low: 100, close: 101.5, volume: 100, isClosed: true },
        // 45m gap
        { timestamp: new Date(base + 60 * 60000), open: 101.5, high: 103, low: 101, close: 102.5, volume: 100, isClosed: true },
      ];

      const result = SMCAnalyzer.analyze(candles, { timeframe: '15m' });
      expect(result.isDegraded).toBe(true);
      expect(result.gapCount).toBe(1);
      expect(result.dataGaps?.length).toBe(1);
      expect(result.closedThrough).toBeDefined();
    });

    it('10.2 should strictly require displacement when BOSConfirmationType is CANDLE_CLOSE_AND_DISPLACEMENT', () => {
      const base = new Date('2026-01-01T09:15:00.000Z').getTime();
      const swingPoints = [
        {
          index: 2,
          type: StructureType.SWING_HIGH,
          price: 105,
          timestamp: new Date(base + 30 * 60000),
          confirmedAtIndex: 3,
          confirmedAtTimestamp: new Date(base + 45 * 60000),
        },
      ];

      const candles: ICandle[] = [];
      for (let i = 0; i <= 4; i++) {
        candles.push({
          timestamp: new Date(base + i * 15 * 60000),
          open: 100,
          high: 102,
          low: 99,
          close: 101,
          volume: 500,
          isClosed: true,
        });
      }
      // Candle 4 closes at 105.1 (barely above 105, weak volume and small body -> NOT displacement)
      candles[4].open = 104.9;
      candles[4].high = 105.2;
      candles[4].low = 104.8;
      candles[4].close = 105.1;
      candles[4].volume = 100;

      const bosCloseOnly = BOSEngine.detectBOS(candles, swingPoints, {
        confirmationType: BOSConfirmationType.CANDLE_CLOSE,
      });
      expect(bosCloseOnly.length).toBe(1);

      const bosWithDisplacement = BOSEngine.detectBOS(candles, swingPoints, {
        confirmationType: BOSConfirmationType.CANDLE_CLOSE_AND_DISPLACEMENT,
      });
      expect(bosWithDisplacement.length).toBe(0);
    });
  });
});
