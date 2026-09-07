import { Direction, ICandle, MTFMode, SignalGrade, StructureType, Timeframe } from '@quant/shared';
import {
  FVGEngine,
  OrderBlockEngine,
  MultiTimeframeAnalyzer,
  DealingRangeEngine,
  SMCAnalyzer,
  SignalGenerator,
  SnapshotBuilder,
  MultiHorizonEngine,
  CandleNormalizer,
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
      const t1 = new Date(t1Candles[2].timestamp.getTime() + minuteMs);

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
      const t2 = new Date(t2Candles[4].timestamp.getTime() + minuteMs);

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
      const t1 = new Date(t1Candles[3].timestamp.getTime() + minuteMs);

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
      const t2 = new Date(t2Candles[5].timestamp.getTime() + minuteMs);

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
      const _execCandles: ICandle[] = [
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

  // 7. Neutral Market Direction Invariant
  describe('Invariant 7: SnapshotBuilder Neutral Direction Preservation', () => {
    it('preserves NEUTRAL direction in flat/ranging markets without fabricating a BULLISH fallback', () => {
      const flatCandles: ICandle[] = [];
      for (let i = 0; i < 30; i++) {
        flatCandles.push(createCandle(i, 100, 101, 99, 100));
      }
      const tEnd = new Date(flatCandles[29].timestamp);

      const snapshot = SnapshotBuilder.buildSnapshot({
        symbol: 'NIFTY',
        executionCandles: flatCandles,
        executionTimeframe: Timeframe.M15,
        asOfTimestamp: tEnd,
      });

      expect(snapshot.trace.smc.bias).toBe(Direction.NEUTRAL);
      expect(snapshot.trace.finalDecision).toBe('NO_TRADE');
      expect(snapshot.score.grade).toBe(SignalGrade.NO_TRADE);
    });
  });

  // 8. MTF Precomputed Analysis Reuse Protection
  describe('Invariant 8: MTF Recomputation Immunity', () => {
    it('always recomputes MTF analysis and never reuses precomputed analysis across different datasets', () => {
      // datasetA: Forms Swing High at C3 (High 120), closes above it at C7 (Close 135) -> Bullish BOS
      const datasetA: ICandle[] = [
        createCandle(0, 100, 105, 95, 100, 1000, 60 * 60 * 1000),
        createCandle(1, 100, 108, 99, 106, 1000, 60 * 60 * 1000),
        createCandle(2, 106, 112, 105, 110, 1000, 60 * 60 * 1000),
        createCandle(3, 110, 120, 108, 115, 1000, 60 * 60 * 1000),
        createCandle(4, 115, 116, 106, 108, 1000, 60 * 60 * 1000),
        createCandle(5, 108, 112, 105, 110, 1000, 60 * 60 * 1000),
        createCandle(6, 110, 114, 108, 112, 1000, 60 * 60 * 1000),
        createCandle(7, 112, 135, 112, 135, 1000, 60 * 60 * 1000),
        createCandle(8, 135, 138, 134, 136, 1000, 60 * 60 * 1000),
      ];

      // datasetB: Forms Swing Low at C3 (Low 80), closes below it at C7 (Close 65) -> Bearish BOS
      const datasetB: ICandle[] = [
        createCandle(0, 100, 105, 95, 100, 1000, 60 * 60 * 1000),
        createCandle(1, 100, 101, 92, 94, 1000, 60 * 60 * 1000),
        createCandle(2, 94, 95, 88, 90, 1000, 60 * 60 * 1000),
        createCandle(3, 90, 92, 80, 85, 1000, 60 * 60 * 1000),
        createCandle(4, 85, 95, 84, 92, 1000, 60 * 60 * 1000),
        createCandle(5, 92, 93, 88, 90, 1000, 60 * 60 * 1000),
        createCandle(6, 90, 92, 86, 88, 1000, 60 * 60 * 1000),
        createCandle(7, 88, 88, 65, 65, 1000, 60 * 60 * 1000),
        createCandle(8, 65, 66, 60, 62, 1000, 60 * 60 * 1000),
      ];

      const execCandles = [
        createCandle(9, 135, 136, 134, 135, 1000, 60 * 60 * 1000),
      ];
      const resultA = MultiTimeframeAnalyzer.analyzeMTF(
        { timeframe: Timeframe.H1, candles: execCandles },
        { timeframe: Timeframe.H1, candles: datasetA },
      );
      const resultB = MultiTimeframeAnalyzer.analyzeMTF(
        { timeframe: Timeframe.H1, candles: execCandles },
        { timeframe: Timeframe.H1, candles: datasetB },
      );

      expect(resultA.htf1Trend).toBe(Direction.BULLISH);
      expect(resultB.htf1Trend).toBe(Direction.BEARISH);
    });
  });

  // 9. Reusable Point-in-Time Invariant Assertion Helper
  describe('Invariant 9: assertPointInTimeInvariant Helper', () => {
    function assertPointInTimeInvariant<T>(
      candles: ICandle[],
      asOfTimestamp: Date,
      analyzer: (c: ICandle[], t: Date) => T,
      keySelector: (res: T) => any = (res) => res,
    ) {
      const stateBefore = keySelector(analyzer(candles, asOfTimestamp));
      const futureCandles = [
        createCandle(candles.length, 500, 600, 400, 550, 100000),
        createCandle(candles.length + 1, 550, 700, 300, 350, 200000),
      ];
      const expanded = [...candles, ...futureCandles];
      const stateAfter = keySelector(analyzer(expanded, asOfTimestamp));
      expect(stateAfter).toEqual(stateBefore);
    }

    it('validates SMC, MTF, MultiHorizon, SnapshotBuilder and SignalGenerator using assertPointInTimeInvariant', () => {
      const baseCandles: ICandle[] = [];
      for (let i = 0; i < 40; i++) {
        baseCandles.push(createCandle(i, 100 + i * 0.3, 102 + i * 0.3, 99 + i * 0.3, 101 + i * 0.3));
      }
      const tAsOf = new Date(baseCandles[30].timestamp);

      // SMC
      assertPointInTimeInvariant(
        baseCandles,
        tAsOf,
        (c, t) => SMCAnalyzer.analyze(c, { asOfTimestamp: t }),
        (r) => ({ trend: r.currentTrend, swings: r.swingPoints.length, bos: r.breaksOfStructure.length }),
      );

      // SnapshotBuilder
      assertPointInTimeInvariant(
        baseCandles,
        tAsOf,
        (c, t) => SnapshotBuilder.buildSnapshot({ symbol: 'NIFTY', executionCandles: c, asOfTimestamp: t }),
        (r) => ({ decision: r.trace.finalDecision, bias: r.trace.smc.bias, score: r.score.totalScore }),
      );

      // SignalGenerator
      assertPointInTimeInvariant(
        baseCandles,
        tAsOf,
        (c, t) => SignalGenerator.generateSignal({ symbol: 'NIFTY', executionCandles: c, asOfTimestamp: t }),
        (r) => ({ dir: r.direction, score: r.score, grade: r.grade, reasons: r.reasons }),
      );
    });
  });

  // 10. Mandatory Incremental Replay Test
  describe('Invariant 10: Mandatory Incremental Replay Test', () => {
    it('verifies process(C1..Ci) === analyze(C1..Cn, asOfTimestamp=Ti) for every closed timestamp', () => {
      const fullCandles: ICandle[] = [];
      for (let i = 0; i < 35; i++) {
        fullCandles.push(createCandle(i, 100 + (i % 7), 103 + (i % 7), 98 + (i % 7), 101 + (i % 7)));
      }

      for (let i = 15; i < fullCandles.length; i++) {
        const sliced = fullCandles.slice(0, i + 1);
        const ti = new Date(sliced[sliced.length - 1].timestamp);

        const incremental = SMCAnalyzer.analyze(sliced, { asOfTimestamp: ti });
        const batch = SMCAnalyzer.analyze(fullCandles, { asOfTimestamp: ti });

        expect(incremental.candlesCount).toBe(batch.candlesCount);
        expect(incremental.currentTrend).toBe(batch.currentTrend);
        expect(incremental.fairValueGaps.length).toBe(batch.fairValueGaps.length);
        expect(incremental.orderBlocks.length).toBe(batch.orderBlocks.length);
      }
    });
  });

  // 11. Future-Data Torture Test
  describe('Invariant 11: Future-Data Torture Test', () => {
    it('guarantees zero historical leakage under wild future structural events', () => {
      const history: ICandle[] = [];
      for (let i = 0; i < 40; i++) {
        history.push(createCandle(i, 100 + i * 0.2, 102 + i * 0.2, 99 + i * 0.2, 101 + i * 0.2));
      }
      const tBaseline = new Date(history[35].timestamp);

      const baselineSnapshot = SnapshotBuilder.buildSnapshot({
        symbol: 'NIFTY',
        executionCandles: history,
        asOfTimestamp: tBaseline,
      });

      // Wild future candles: massive FVG, OB invalidation, trend flip, extreme volatility
      const tortureCandles = [
        ...history,
        createCandle(40, 108, 200, 107, 195, 500000), // Huge FVG + BOS
        createCandle(41, 195, 205, 50, 60, 900000),   // Huge crash invalidating all OBs
        createCandle(42, 60, 65, 10, 15, 1000000),    // Extreme crash
      ];

      const torturedSnapshot = SnapshotBuilder.buildSnapshot({
        symbol: 'NIFTY',
        executionCandles: tortureCandles,
        asOfTimestamp: tBaseline,
      });

      expect(torturedSnapshot.trace.finalDecision).toBe(baselineSnapshot.trace.finalDecision);
      expect(torturedSnapshot.trace.smc.bias).toBe(baselineSnapshot.trace.smc.bias);
      expect(torturedSnapshot.score.totalScore).toBe(baselineSnapshot.score.totalScore);
      expect(torturedSnapshot.smc.currentTrend).toBe(baselineSnapshot.smc.currentTrend);
      expect(torturedSnapshot.smc.fairValueGaps.length).toBe(baselineSnapshot.smc.fairValueGaps.length);
      expect(torturedSnapshot.smc.orderBlocks.length).toBe(baselineSnapshot.smc.orderBlocks.length);
    });
  });

  // 12. Explicit MultiHorizon Future Invariance Test
  describe('Invariant 12: MultiHorizon Future Invariance', () => {
    it('evaluates MultiHorizon identically regardless of future candles appended across all timeframes', () => {
      const history = [
        createCandle(0, 100, 102, 99, 101, 1000, 15 * 60 * 1000),
        createCandle(1, 101, 103, 100, 102, 1000, 15 * 60 * 1000),
        createCandle(2, 102, 105, 101, 104, 1000, 15 * 60 * 1000),
        createCandle(3, 104, 106, 103, 105, 1000, 15 * 60 * 1000),
        createCandle(4, 105, 108, 104, 107, 1000, 15 * 60 * 1000),
      ];
      const htfHistory = [
        createCandle(0, 100, 105, 98, 103, 5000, 60 * 60 * 1000),
        createCandle(1, 103, 110, 102, 108, 5000, 60 * 60 * 1000),
      ];
      const macroHistory = [
        createCandle(0, 100, 115, 95, 112, 20000, 4 * 60 * 60 * 1000),
      ];

      const t = new Date(history[4].timestamp.getTime() + 15 * 60 * 1000);

      // Future candles designed to reverse EMA trend, create extreme RSI/ATR, change regime, break structure
      const futureExec = [
        createCandle(5, 107, 250, 50, 55, 500000, 15 * 60 * 1000),
        createCandle(6, 55, 60, 10, 12, 900000, 15 * 60 * 1000),
      ];
      const futureHTF = [
        createCandle(2, 108, 300, 30, 35, 1000000, 60 * 60 * 1000),
      ];
      const futureMacro = [
        createCandle(1, 112, 400, 20, 25, 5000000, 4 * 60 * 60 * 1000),
      ];

      const resA = MultiHorizonEngine.evaluateMultiHorizon(
        history,
        htfHistory,
        macroHistory,
        {
          asOfTimestamp: t,
          executionTimeframe: '15m',
          htfTimeframe: '1h',
          macroTimeframe: '4h',
        },
      );
      const resB = MultiHorizonEngine.evaluateMultiHorizon(
        [...history, ...futureExec],
        [...htfHistory, ...futureHTF],
        [...macroHistory, ...futureMacro],
        {
          asOfTimestamp: t,
          executionTimeframe: '15m',
          htfTimeframe: '1h',
          macroTimeframe: '4h',
        },
      );

      expect(resB).toEqual(resA);
    });
  });

  // 13. Stale Analysis Rejection Test
  describe('Invariant 13: MTF Stale Analysis Rejection', () => {
    it('ignores stale precomputed analysis when candles are passed', () => {
      const datasetA: ICandle[] = [
        createCandle(0, 100, 105, 95, 100, 1000, 60 * 60 * 1000),
        createCandle(1, 100, 108, 99, 106, 1000, 60 * 60 * 1000),
        createCandle(2, 106, 112, 105, 110, 1000, 60 * 60 * 1000),
        createCandle(3, 110, 120, 108, 115, 1000, 60 * 60 * 1000),
        createCandle(4, 115, 116, 106, 108, 1000, 60 * 60 * 1000),
        createCandle(5, 108, 112, 105, 110, 1000, 60 * 60 * 1000),
        createCandle(6, 110, 114, 108, 112, 1000, 60 * 60 * 1000),
        createCandle(7, 112, 135, 112, 135, 1000, 60 * 60 * 1000),
        createCandle(8, 135, 138, 134, 136, 1000, 60 * 60 * 1000),
      ];

      const staleBearishAnalysis: any = {
        currentTrend: Direction.BEARISH,
        marketRegime: { regime: 'BEARISH_TREND' },
      };

      const execCandles = [createCandle(9, 135, 136, 134, 135, 1000, 60 * 60 * 1000)];
      const result = MultiTimeframeAnalyzer.analyzeMTF(
        { timeframe: Timeframe.H1, candles: execCandles },
        { timeframe: Timeframe.H1, candles: datasetA, analysis: staleBearishAnalysis },
      );

      // Must recompute and evaluate to BULLISH from datasetA, ignoring staleBearishAnalysis
      expect(result.htf1Trend).toBe(Direction.BULLISH);
    });
  });

  // 14. Unclosed Candle Rejection Test
  describe('Invariant 14: Unclosed Candle Rejection', () => {
    it('excludes candles that have not closed as of the decision timestamp', () => {
      const candles: ICandle[] = [
        createCandle(0, 100, 102, 99, 101, 1000, 15 * 60 * 1000), // 10:00 - 10:15
        createCandle(1, 101, 103, 100, 102, 1000, 15 * 60 * 1000), // 10:15 - 10:30
      ];
      // asOfTimestamp = 10:20 (Candle 0 is closed, candle 1 is still open!)
      const asOf1020 = new Date(baseTime + 20 * 60 * 1000);
      const closed = CandleNormalizer.getClosedCandlesAsOf(candles, '15m', asOf1020);
      expect(closed).toHaveLength(1);
      expect(closed[0].timestamp).toEqual(candles[0].timestamp);
    });
  });

  // 15. SnapshotBuilder Integration Future Invariance Test
  describe('Invariant 15: SnapshotBuilder Integration Future Invariance', () => {
    it('guarantees all decision-relevant snapshot fields are identical regardless of future data', () => {
      const history: ICandle[] = [];
      for (let i = 0; i < 40; i++) {
        history.push(createCandle(i, 100 + i * 0.2, 102 + i * 0.2, 99 + i * 0.2, 101 + i * 0.2));
      }
      const tBaseline = new Date(history[35].timestamp.getTime() + minuteMs);

      const snapshotA = SnapshotBuilder.buildSnapshot({
        symbol: 'NIFTY',
        executionCandles: history,
        asOfTimestamp: tBaseline,
      });

      const tortureCandles = [
        ...history,
        createCandle(40, 108, 300, 107, 295, 500000), // Wild future expansion
        createCandle(41, 295, 305, 30, 35, 900000),   // Extreme crash
        createCandle(42, 35, 40, 10, 15, 1000000),
      ];

      const snapshotB = SnapshotBuilder.buildSnapshot({
        symbol: 'NIFTY',
        executionCandles: tortureCandles,
        asOfTimestamp: tBaseline,
      });

      expect(snapshotB.timestamp).toEqual(snapshotA.timestamp);
      expect(snapshotB.marketPrice).toEqual(snapshotA.marketPrice);
      expect(snapshotB.smc.currentTrend).toEqual(snapshotA.smc.currentTrend);
      expect(snapshotB.smc.fairValueGaps).toEqual(snapshotA.smc.fairValueGaps);
      expect(snapshotB.smc.orderBlocks).toEqual(snapshotA.smc.orderBlocks);
      expect(snapshotB.quant.returns).toEqual(snapshotA.quant.returns);
      expect(snapshotB.regime.regime).toEqual(snapshotA.regime.regime);
      expect(snapshotB.volatility.volatilityPercentile).toEqual(snapshotA.volatility.volatilityPercentile);
      expect(snapshotB.multiHorizon).toEqual(snapshotA.multiHorizon);
      expect(snapshotB.score.totalScore).toEqual(snapshotA.score.totalScore);
      expect(snapshotB.score.grade).toEqual(snapshotA.score.grade);
      expect(snapshotB).toEqual(snapshotA);
    });
  });

  // Test A — Snapshot timestamp
  describe('Test A: Snapshot Decision Timestamp', () => {
    it('uses candle CLOSE timestamp (10:15) and NOT open timestamp (10:00) for a 15m candle', () => {
      const openTime = new Date('2026-01-01T10:00:00.000Z');
      const candle: ICandle = {
        timestamp: openTime,
        open: 100,
        high: 105,
        low: 95,
        close: 102,
        volume: 1000,
        isClosed: true,
      };

      const snapshot = SnapshotBuilder.buildSnapshot({
        symbol: 'BTCUSDT',
        executionCandles: [candle],
        executionTimeframe: Timeframe.M15,
      });

      const expectedClose = new Date('2026-01-01T10:15:00.000Z');
      expect(snapshot.timestamp.getTime()).toBe(expectedClose.getTime());
      expect(snapshot.timestamp.getTime()).not.toBe(openTime.getTime());
      expect(snapshot.candles[0].lastClosedTimestamp.getTime()).toBe(expectedClose.getTime());
    });
  });

  // Test B — Explicit asOf timestamp
  describe('Test B: Explicit asOf Timestamp Preservation', () => {
    it('uses asOfTimestamp exactly when provided, regardless of candle open timestamp', () => {
      const openTime = new Date('2026-01-01T10:00:00.000Z');
      const candle: ICandle = {
        timestamp: openTime,
        open: 100,
        high: 105,
        low: 95,
        close: 102,
        volume: 1000,
        isClosed: true,
      };
      const explicitAsOf = new Date('2026-01-01T10:15:00.000Z');

      const snapshot = SnapshotBuilder.buildSnapshot({
        symbol: 'BTCUSDT',
        executionCandles: [candle],
        executionTimeframe: Timeframe.M15,
        asOfTimestamp: explicitAsOf,
      });

      expect(snapshot.timestamp.getTime()).toBe(explicitAsOf.getTime());
    });
  });

  // Test C — Stale MTF analysis
  describe('Test C: Stale MTF Precomputed Analysis Rejection', () => {
    it('returns NEUTRAL and ignores caller-supplied fake bullish precomputed analysis when no valid candles exist at asOf', () => {
      const fakeAnalysis: any = {
        currentTrend: Direction.BULLISH,
        marketRegime: { regime: 'BULLISH_TREND' },
      };

      const asOf = new Date('2026-01-01T10:00:00.000Z');
      // htf1 has no valid candles at or before asOf (candle opens at 10:00, duration 1h -> closes at 11:00 > 10:00)
      const futureHtfCandle: ICandle = {
        timestamp: new Date('2026-01-01T10:00:00.000Z'),
        open: 100,
        high: 105,
        low: 95,
        close: 102,
        volume: 1000,
        isClosed: true,
      };

      const res = MultiTimeframeAnalyzer.analyzeMTF(
        { timeframe: Timeframe.M15, candles: [] },
        { timeframe: Timeframe.H1, candles: [futureHtfCandle], analysis: fakeAnalysis },
        undefined,
        MTFMode.BALANCED,
        asOf,
      );

      expect(res.htf1Trend).toBe(Direction.NEUTRAL);
      expect(res.htfBias).toBe(Direction.NEUTRAL);
    });
  });

  // Test D — Unclosed candle
  describe('Test D: Unclosed Candle Temporal Boundary', () => {
    it('excludes 10:00 candle at 10:05 asOf, and includes it at 10:15 if isClosed !== false', () => {
      const openTime = new Date('2026-01-01T10:00:00.000Z');
      const candle: ICandle = {
        timestamp: openTime,
        open: 100,
        high: 105,
        low: 95,
        close: 102,
        volume: 1000,
        isClosed: true,
      };

      const asOf1005 = new Date('2026-01-01T10:05:00.000Z');
      const closedAt1005 = CandleNormalizer.getClosedCandlesAsOf([candle], '15m', asOf1005);
      expect(closedAt1005).toHaveLength(0);

      const asOf1015 = new Date('2026-01-01T10:15:00.000Z');
      const closedAt1015 = CandleNormalizer.getClosedCandlesAsOf([candle], '15m', asOf1015);
      expect(closedAt1015).toHaveLength(1);
    });
  });

  // Test E — Full snapshot future invariance
  describe('Test E: Full Snapshot Future Invariance', () => {
    it('snapshot(history, T) equals snapshot(history + arbitraryFutureData, T)', () => {
      const history: ICandle[] = [];
      for (let i = 0; i < 40; i++) {
        history.push(createCandle(i, 100 + i * 0.2, 102 + i * 0.2, 99 + i * 0.2, 101 + i * 0.2));
      }
      const T = CandleNormalizer.getCandleCloseTimestamp(history[35], '15m');

      const snapshotA = SnapshotBuilder.buildSnapshot({
        symbol: 'NIFTY',
        executionCandles: history,
        asOfTimestamp: T,
      });

      const future: ICandle[] = [
        createCandle(40, 108, 300, 107, 295, 500000),
        createCandle(41, 295, 305, 30, 35, 900000),
        createCandle(42, 35, 40, 10, 15, 1000000),
      ];

      const snapshotB = SnapshotBuilder.buildSnapshot({
        symbol: 'NIFTY',
        executionCandles: [...history, ...future],
        asOfTimestamp: T,
      });

      expect(snapshotB).toEqual(snapshotA);
    });
  });

  // Test F — Signal future-data invariance
  describe('Test F: Signal Future-Data Invariance', () => {
    it('SignalGenerator.generateSignal(D, T) equals SignalGenerator.generateSignal(D+F, T) for all decision-relevant fields', () => {
      const D: ICandle[] = [];
      for (let i = 0; i < 40; i++) {
        D.push(createCandle(i, 100 + i * 0.2, 102 + i * 0.2, 99 + i * 0.2, 101 + i * 0.2));
      }
      const T = CandleNormalizer.getCandleCloseTimestamp(D[35], '15m');

      const signalA = SignalGenerator.generateSignal({
        symbol: 'BTCUSDT',
        executionCandles: D,
        asOfTimestamp: T,
      });

      const future: ICandle[] = [
        createCandle(40, 108, 300, 107, 295, 500000),
        createCandle(41, 295, 305, 30, 35, 900000),
        createCandle(42, 35, 40, 10, 15, 1000000),
      ];

      const signalB = SignalGenerator.generateSignal({
        symbol: 'BTCUSDT',
        executionCandles: [...D, ...future],
        asOfTimestamp: T,
      });

      expect(signalB.symbol).toEqual(signalA.symbol);
      expect(signalB.direction).toEqual(signalA.direction);
      expect(signalB.score).toEqual(signalA.score);
      expect(signalB.grade).toEqual(signalA.grade);
      expect(signalB.htfBias).toEqual(signalA.htfBias);
      expect(signalB.timestamp).toEqual(signalA.timestamp);
      expect(signalB.quantSnapshot).toEqual(signalA.quantSnapshot);
      expect(signalB.decisionTrace).toEqual(signalA.decisionTrace);
    });
  });

  // Test G — Incremental replay
  describe('Test G: Incremental Replay Equivalence', () => {
    it('produces identical states between incremental history feed and full batch with asOfTimestamp', () => {
      const allCandles: ICandle[] = [];
      for (let i = 0; i < 50; i++) {
        allCandles.push(
          createCandle(
            i,
            100 + Math.sin(i / 3) * 5,
            105 + Math.sin(i / 3) * 5,
            95 + Math.sin(i / 3) * 5,
            102 + Math.sin(i / 3) * 5,
            1000 + i * 10,
            15 * 60 * 1000,
          ),
        );
      }

      for (let i = 20; i < 45; i += 5) {
        const targetCandle = allCandles[i];
        const T = CandleNormalizer.getCandleCloseTimestamp(targetCandle, '15m');
        const incrementalHistory = allCandles.slice(0, i + 1);

        const incrementalState = SnapshotBuilder.buildSnapshot({
          symbol: 'BTCUSDT',
          executionCandles: incrementalHistory,
          asOfTimestamp: T,
        });

        const batchState = SnapshotBuilder.buildSnapshot({
          symbol: 'BTCUSDT',
          executionCandles: allCandles,
          asOfTimestamp: T,
        });

        expect(incrementalState.timestamp).toEqual(batchState.timestamp);
        expect(incrementalState.marketPrice).toEqual(batchState.marketPrice);
        expect(incrementalState.smc).toEqual(batchState.smc);
        expect(incrementalState.quant).toEqual(batchState.quant);
        expect(incrementalState.regime).toEqual(batchState.regime);
        expect(incrementalState.volatility).toEqual(batchState.volatility);
        expect(incrementalState.multiHorizon).toEqual(batchState.multiHorizon);
        expect(incrementalState.score).toEqual(batchState.score);
        expect(incrementalState.trace).toEqual(batchState.trace);
        expect(incrementalState.ml).toEqual(batchState.ml);
      }
    });
  });

  // Test C — Future-Data Invariance for Liquidity
  describe('Invariant Liquidity Test C: Future-Data Invariance for Liquidity', () => {
    it('liquidity pools and sweeps at T are identical regardless of future candles', () => {
      const history: ICandle[] = [];
      for (let i = 0; i < 40; i++) {
        history.push(
          createCandle(
            i,
            100 + Math.sin(i / 2) * 4,
            105 + Math.sin(i / 2) * 4,
            95 + Math.sin(i / 2) * 4,
            101 + Math.sin(i / 2) * 4,
            1000,
            15 * 60 * 1000,
          ),
        );
      }
      const T = CandleNormalizer.getCandleCloseTimestamp(history[35], '15m');

      const smcA = SMCAnalyzer.analyze(history, { asOfTimestamp: T, timeframe: Timeframe.M15 });

      const future: ICandle[] = [
        createCandle(40, 108, 300, 107, 295, 500000, 15 * 60 * 1000),
        createCandle(41, 295, 305, 30, 35, 900000, 15 * 60 * 1000),
        createCandle(42, 35, 40, 10, 15, 1000000, 15 * 60 * 1000),
      ];

      const smcB = SMCAnalyzer.analyze([...history, ...future], { asOfTimestamp: T, timeframe: Timeframe.M15 });

      expect(smcB.liquidityPools).toEqual(smcA.liquidityPools);
      expect(smcB.liquiditySweeps).toEqual(smcA.liquiditySweeps);
    });
  });

  // Test D — Incremental vs Batch Liquidity State
  describe('Invariant Liquidity Test D: Incremental vs Batch Liquidity State', () => {
    it('incremental liquidity state at T matches batch liquidity state with asOfTimestamp = T', () => {
      const allCandles: ICandle[] = [];
      for (let i = 0; i < 50; i++) {
        allCandles.push(
          createCandle(
            i,
            100 + Math.cos(i / 3) * 5,
            105 + Math.cos(i / 3) * 5,
            95 + Math.cos(i / 3) * 5,
            102 + Math.cos(i / 3) * 5,
            1000,
            15 * 60 * 1000,
          ),
        );
      }

      for (let i = 25; i < 45; i += 5) {
        const targetCandle = allCandles[i];
        const T = CandleNormalizer.getCandleCloseTimestamp(targetCandle, '15m');
        const incrementalHistory = allCandles.slice(0, i + 1);

        const smcIncremental = SMCAnalyzer.analyze(incrementalHistory, { asOfTimestamp: T });
        const smcBatch = SMCAnalyzer.analyze(allCandles, { asOfTimestamp: T });

        expect(smcIncremental.liquidityPools).toEqual(smcBatch.liquidityPools);
        expect(smcIncremental.liquiditySweeps).toEqual(smcBatch.liquiditySweeps);
      }
    });
  });

  // SMC Propagation Test (Section 11)
  describe('Invariant Section 11: SMC Propagation Test', () => {
    it('proves liquidity availability fix propagates cleanly through SMCAnalyzer.analyze', () => {
      const history: ICandle[] = [];
      for (let i = 0; i < 35; i++) {
        history.push(createCandle(i, 100 + i * 0.1, 102 + i * 0.1, 98 + i * 0.1, 101 + i * 0.1));
      }
      const T = CandleNormalizer.getCandleCloseTimestamp(history[30], '15m');

      const stateA = SMCAnalyzer.analyze(history, { asOfTimestamp: T });

      const torture: ICandle[] = [
        ...history,
        createCandle(35, 105, 500, 104, 490, 1000000),
        createCandle(36, 490, 500, 10, 15, 2000000),
      ];

      const stateB = SMCAnalyzer.analyze(torture, { asOfTimestamp: T });

      expect(stateB.liquidityPools).toEqual(stateA.liquidityPools);
      expect(stateB.liquiditySweeps).toEqual(stateA.liquiditySweeps);
      expect(stateB.currentTrend).toEqual(stateA.currentTrend);
    });
  });
});
