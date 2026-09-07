import { Direction, ICandle, StructureType, Timeframe } from '@quant/shared';
import {
  FVGEngine,
  OrderBlockEngine,
  MultiTimeframeAnalyzer,
  DealingRangeEngine,
  SMCAnalyzer,
  SignalGenerator,
  SwingDetector,
} from '../index';

describe('Point-in-Time Correctness & Look-Ahead Invariants Suite', () => {
  const baseTime = 1700000000000;
  const minuteMs = 60 * 1000;

  function createCandle(
    index: number,
    open: number,
    high: number,
    low: number,
    close: number,
    volume = 1000,
    intervalMs = minuteMs,
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

  // 1. FVG Point-in-Time State
  describe('Invariant 1: FVG Point-in-Time State', () => {
    it('evaluates FVG state incrementally so future candles cannot mutate historical state at T1', () => {
      // Bar 0, 1, 2 form Bullish FVG [105, 112]
      const t1Candles: ICandle[] = [
        createCandle(0, 100, 105, 98, 102, 100), // C0: High = 105
        createCandle(1, 102, 120, 102, 118, 1000), // C1: Big up move
        createCandle(2, 118, 125, 112, 122, 500), // C2: Low = 112 > 105 -> Gap [105, 112]
      ];
      const t1 = new Date(t1Candles[2].timestamp);

      // Analyze at T1
      const fvgAtT1_before = FVGEngine.detectFVGs(t1Candles, { asOfTimestamp: t1 });
      expect(fvgAtT1_before.allFVGs).toHaveLength(1);
      expect(fvgAtT1_before.allFVGs[0].isFilled).toBe(false);
      expect(fvgAtT1_before.allFVGs[0].fillPercentage).toBe(0);
      expect(fvgAtT1_before.activeFVGs).toHaveLength(1);

      // Append future candles at T2 where bar 4 dips down to 104, completely filling the FVG
      const t2Candles: ICandle[] = [
        ...t1Candles,
        createCandle(3, 122, 124, 115, 120, 200),
        createCandle(4, 120, 121, 104, 116, 800), // Fills FVG completely (low 104 < 105)
      ];
      const t2 = new Date(t2Candles[4].timestamp);

      // Re-analyze at T1 using the complete t2Candles dataset with asOfTimestamp = T1
      const fvgAtT1_after = FVGEngine.detectFVGs(t2Candles, { asOfTimestamp: t1 });
      expect(fvgAtT1_after.allFVGs).toHaveLength(1);
      expect(fvgAtT1_after.allFVGs[0].isFilled).toBe(false);
      expect(fvgAtT1_after.allFVGs[0].fillPercentage).toBe(0);
      expect(fvgAtT1_after.activeFVGs).toHaveLength(1);

      // Analyze at T2 -> Now it must be filled
      const fvgAtT2 = FVGEngine.detectFVGs(t2Candles, { asOfTimestamp: t2 });
      expect(fvgAtT2.allFVGs).toHaveLength(1);
      expect(fvgAtT2.allFVGs[0].isFilled).toBe(true);
      expect(fvgAtT2.allFVGs[0].fillPercentage).toBe(100);
      expect(fvgAtT2.activeFVGs).toHaveLength(0);
    });
  });

  // 2. Order Block Point-in-Time State
  describe('Invariant 2: Order Block Point-in-Time State', () => {
    it('evaluates OB confirmation and mitigation strictly point-in-time', () => {
      // OB formed at candle 0, confirmed at candle 3 (i + 3)
      const t1Candles: ICandle[] = [
        createCandle(0, 105, 106, 98, 100, 200), // Down candle (OB zone: 98 - 106)
        createCandle(1, 100, 120, 100, 118, 1000), // Displacement 1
        createCandle(2, 118, 130, 116, 128, 1200), // Displacement 2
        createCandle(3, 128, 135, 125, 132, 800), // Displacement 3 (Confirmed here!)
      ];
      const t1 = new Date(t1Candles[3].timestamp);

      const obAtT1_before = OrderBlockEngine.detectOrderBlocks(t1Candles, [], [], {
        displacementThresholdAtr: 0.5,
        asOfTimestamp: t1,
      });

      expect(obAtT1_before.allOrderBlocks).toHaveLength(1);
      expect(obAtT1_before.allOrderBlocks[0].isMitigated).toBe(false);
      expect(obAtT1_before.allOrderBlocks[0].confirmedAtTimestamp).toEqual(
        new Date(t1Candles[3].timestamp),
      );
      expect(obAtT1_before.activeOrderBlocks).toHaveLength(1);

      // Append future candles at T2 where bar 5 enters the OB (low 102 <= 106)
      const t2Candles: ICandle[] = [
        ...t1Candles,
        createCandle(4, 132, 134, 120, 122, 300),
        createCandle(5, 122, 123, 102, 110, 500), // Mitigates OB
      ];
      const t2 = new Date(t2Candles[5].timestamp);

      // Re-evaluate at T1 with complete dataset
      const obAtT1_after = OrderBlockEngine.detectOrderBlocks(t2Candles, [], [], {
        displacementThresholdAtr: 0.5,
        asOfTimestamp: t1,
      });
      expect(obAtT1_after.allOrderBlocks).toHaveLength(1);
      expect(obAtT1_after.allOrderBlocks[0].isMitigated).toBe(false);
      expect(obAtT1_after.activeOrderBlocks).toHaveLength(1);

      // Evaluate at T2
      const obAtT2 = OrderBlockEngine.detectOrderBlocks(t2Candles, [], [], {
        displacementThresholdAtr: 0.5,
        asOfTimestamp: t2,
      });
      const bullOBAtT2 = obAtT2.allOrderBlocks.find((ob) => ob.id === 'ob-bull-0');
      expect(bullOBAtT2).toBeDefined();
      expect(bullOBAtT2!.isMitigated).toBe(true);
      expect(bullOBAtT2!.mitigatedAtIndex).toBe(5);
      expect(obAtT2.activeOrderBlocks.find((ob) => ob.id === 'ob-bull-0')).toBeUndefined();
    });
  });

  // 3. Multi-Timeframe Closed-Candle Isolation
  describe('Invariant 3: MTF Closed-Candle Isolation', () => {
    it('strictly forbids unclosed HTF bars from leaking into lower timeframe analysis', () => {
      // 15m execution bar at 10:00 (closes at 10:15)
      const execCandles: ICandle[] = [
        createCandle(0, 100, 102, 99, 101, 1000, 15 * 60 * 1000), // 10:00 - 10:15
      ];
      const asOf1015 = new Date(baseTime + 15 * 60 * 1000);

      // 1H bars: 09:00-10:00 (closed) and 10:00-11:00 (unclosed at 10:15!)
      const htfCandles: ICandle[] = [
        createCandle(-4, 95, 98, 94, 97, 5000, 15 * 60 * 1000), // 09:00 - 10:00
        createCandle(0, 97, 130, 96, 129, 20000, 15 * 60 * 1000), // 10:00 - 11:00 (Wild future breakout)
      ];

      const filteredAt1015 = MultiTimeframeAnalyzer.filterClosedHTFCandles(
        htfCandles,
        Timeframe.H1,
        asOf1015.getTime(),
      );

      // Only the completed 09:00-10:00 candle is eligible
      expect(filteredAt1015).toHaveLength(1);
      expect(new Date(filteredAt1015[0].timestamp).getTime()).toBe(new Date(htfCandles[0].timestamp).getTime());

      // At 11:00 (asOf1100), the 10:00-11:00 candle becomes closed and eligible
      const asOf1100 = new Date(baseTime + 60 * 60 * 1000);
      const filteredAt1100 = MultiTimeframeAnalyzer.filterClosedHTFCandles(
        htfCandles,
        Timeframe.H1,
        asOf1100.getTime(),
      );
      expect(filteredAt1100).toHaveLength(2);
    });
  });

  // 4. Dealing Range & Structural Trend Point-in-Time
  describe('Invariant 4: Dealing Range & Trend Point-in-Time', () => {
    it('dealing range at T uses only structural levels confirmed by T', () => {
      const pastSwings = [
        {
          index: 2,
          type: StructureType.SWING_HIGH,
          price: 150,
          timestamp: new Date(baseTime + 2000),
          confirmedAtIndex: 4,
          confirmedAtTimestamp: new Date(baseTime + 4000),
        },
        {
          index: 5,
          type: StructureType.SWING_LOW,
          price: 100,
          timestamp: new Date(baseTime + 5000),
          confirmedAtIndex: 7,
          confirmedAtTimestamp: new Date(baseTime + 7000),
        },
      ];

      const rangeAtT = DealingRangeEngine.calculateDealingRange(pastSwings);
      expect(rangeAtT).not.toBeNull();
      expect(rangeAtT!.high).toBe(150);
      expect(rangeAtT!.low).toBe(100);
      expect(rangeAtT!.equilibrium).toBe(125);

      // Add a future extreme swing (High 300) confirmed much later
      const futureSwings = [
        ...pastSwings,
        {
          index: 12,
          type: StructureType.SWING_HIGH,
          price: 300,
          timestamp: new Date(baseTime + 12000),
          confirmedAtIndex: 14,
          confirmedAtTimestamp: new Date(baseTime + 14000),
        },
      ];

      // Slicing swings confirmed at or before index 7 preserves the exact historical range
      const swingsConfirmedAtT = futureSwings.filter((s) => s.confirmedAtIndex <= 7);
      const rangeConfirmedAtT = DealingRangeEngine.calculateDealingRange(swingsConfirmedAtT);
      expect(rangeConfirmedAtT!.high).toBe(150);
      expect(rangeConfirmedAtT!.equilibrium).toBe(125);
    });
  });

  // 5. Full Immutability Regression Test
  describe('Invariant 5: Full Immutability Regression Test', () => {
    it('produces identical analysis at timestamp T whether analyzed in real-time or from expanded future dataset', () => {
      const baseCandles: ICandle[] = [];
      for (let i = 0; i < 40; i++) {
        baseCandles.push(createCandle(i, 100 + i * 0.5, 102 + i * 0.5, 99 + i * 0.5, 101 + i * 0.5));
      }
      const tDecision = new Date(baseCandles[39].timestamp);

      // Run point-in-time analysis on initial 40 candles
      const resultAtT_realtime = SMCAnalyzer.analyze(baseCandles, { asOfTimestamp: tDecision });

      // Create expanded dataset with 30 additional future candles
      const futureExpandedCandles = [...baseCandles];
      for (let i = 40; i < 70; i++) {
        futureExpandedCandles.push(
          createCandle(i, 120 + (i % 5), 125 + (i % 5), 115 + (i % 5), 122 + (i % 5)),
        );
      }

      // Re-run analysis on expanded future dataset asking for state asOf tDecision
      const resultAtT_historical = SMCAnalyzer.analyze(futureExpandedCandles, {
        asOfTimestamp: tDecision,
      });

      expect(resultAtT_historical.candlesCount).toBe(resultAtT_realtime.candlesCount);
      expect(resultAtT_historical.currentTrend).toBe(resultAtT_realtime.currentTrend);
      expect(resultAtT_historical.swingPoints.length).toBe(resultAtT_realtime.swingPoints.length);
      expect(resultAtT_historical.breaksOfStructure.length).toBe(
        resultAtT_realtime.breaksOfStructure.length,
      );
      expect(resultAtT_historical.fairValueGaps.length).toBe(resultAtT_realtime.fairValueGaps.length);
      expect(resultAtT_historical.orderBlocks.length).toBe(resultAtT_realtime.orderBlocks.length);
    });
  });

  // 6. Future-Data Extreme Shock Resistance Test
  describe('Invariant 6: Future-Data Extreme Shock Resistance', () => {
    it('historical signals and scores at T remain completely unaltered even if future price experiences +20% / -20% shocks', () => {
      const baseCandles: ICandle[] = [];
      for (let i = 0; i < 30; i++) {
        baseCandles.push(createCandle(i, 100 + i * 0.2, 102 + i * 0.2, 99 + i * 0.2, 101 + i * 0.2));
      }
      const tDecision = new Date(baseCandles[29].timestamp);

      const signalAtT_original = SignalGenerator.generateSignal({
        symbol: 'NIFTY',
        executionCandles: baseCandles,
        executionTimeframe: Timeframe.M15,
        asOfTimestamp: tDecision,
      });

      // Append extreme +20% / -20% shock candles into future
      const shockCandles = [
        ...baseCandles,
        createCandle(30, 105, 130, 104, 128, 50000), // +20% expansion
        createCandle(31, 128, 135, 75, 80, 80000),   // -40% crash
        createCandle(32, 80, 85, 70, 72, 30000),
      ];

      const signalAtT_shocked = SignalGenerator.generateSignal({
        symbol: 'NIFTY',
        executionCandles: shockCandles,
        executionTimeframe: Timeframe.M15,
        asOfTimestamp: tDecision,
      });

      expect(signalAtT_shocked.score).toBe(signalAtT_original.score);
      expect(signalAtT_shocked.direction).toBe(signalAtT_original.direction);
      expect(signalAtT_shocked.timestamp).toEqual(signalAtT_original.timestamp);
      expect(signalAtT_shocked.reasons).toEqual(signalAtT_original.reasons);
    });
  });
});
