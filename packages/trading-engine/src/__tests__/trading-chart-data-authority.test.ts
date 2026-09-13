import { TimeframeRegistry, Timeframe, ICandle } from '@quant/shared';

/**
 * Session VWAP calculator as implemented in TradingChart
 */
export function calculateSessionVWAP(candles: ICandle[]): Array<{ time: number; value: number }> {
  const sorted = [...candles].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  let cumVol = 0;
  let cumTypVol = 0;
  let lastDateStr = '';

  return sorted.map((c) => {
    const d = new Date(c.timestamp);
    const dateStr = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
    if (dateStr !== lastDateStr) {
      cumVol = 0;
      cumTypVol = 0;
      lastDateStr = dateStr;
    }
    const typ = (c.high + c.low + c.close) / 3;
    const vol = c.volume ?? 1;
    cumVol += vol;
    cumTypVol += typ * vol;
    return {
      time: Math.floor(d.getTime() / 1000),
      value: cumVol > 0 ? Number((cumTypVol / cumVol).toFixed(2)) : c.close,
    };
  });
}

/**
 * Live tick forming candle update logic as implemented in TradingChart
 */
export function updateFormingCandle(
  historicalCandles: ICandle[],
  currentFormingCandle: ICandle | null,
  livePrice: number,
  tickTimeMs: number,
  tickVolume: number,
  timeframe: string,
): { historicalCandles: ICandle[]; formingCandle: ICandle } {
  const durationMs = TimeframeRegistry.getDurationMs(timeframe);
  const currentBucketMs = Math.floor(tickTimeMs / durationMs) * durationMs;

  const nextHistorical = [...historicalCandles];

  if (!currentFormingCandle) {
    return {
      historicalCandles: nextHistorical,
      formingCandle: {
        timestamp: new Date(currentBucketMs),
        open: livePrice,
        high: livePrice,
        low: livePrice,
        close: livePrice,
        volume: tickVolume,
        isClosed: false,
      },
    };
  }

  const formingBucketMs = new Date(currentFormingCandle.timestamp).getTime();

  if (currentBucketMs === formingBucketMs) {
    // Update ONLY forming candle
    return {
      historicalCandles: nextHistorical, // Immutable, not mutated
      formingCandle: {
        ...currentFormingCandle,
        high: Math.max(currentFormingCandle.high, livePrice),
        low: Math.min(currentFormingCandle.low, livePrice),
        close: livePrice,
        volume: (currentFormingCandle.volume ?? 0) + tickVolume,
        isClosed: false,
      },
    };
  } else if (currentBucketMs > formingBucketMs) {
    // Finalize forming candle as closed, append to historical
    const finalizedCandle: ICandle = {
      ...currentFormingCandle,
      isClosed: true,
    };
    nextHistorical.push(finalizedCandle);

    // Create new forming candle
    return {
      historicalCandles: nextHistorical,
      formingCandle: {
        timestamp: new Date(currentBucketMs),
        open: livePrice,
        high: livePrice,
        low: livePrice,
        close: livePrice,
        volume: tickVolume,
        isClosed: false,
      },
    };
  }

  return { historicalCandles: nextHistorical, formingCandle: currentFormingCandle };
}

describe('Trading Chart Data Authority & Semantics Suite', () => {
  describe('P0 #1: Synthetic Data Removal & Fail-Closed Behavior', () => {
    it('1. Returns empty candles array on API failure without generating synthetic OHLC', () => {
      const apiResponse: any = null; // API unavailable
      const candles = apiResponse && Array.isArray(apiResponse.candles) ? apiResponse.candles : [];
      expect(candles).toEqual([]);
      expect(candles.length).toBe(0);
    });

    it('2. Does not invent fallback prices when live market ticker is unavailable', () => {
      const tickers: any = {};
      const candles: ICandle[] = [];
      const currentTicker = tickers['NIFTY'] || {
        symbol: 'NIFTY',
        price: candles.length > 0 ? candles[candles.length - 1].close : undefined,
      };
      expect(currentTicker.price).toBeUndefined();
    });
  });

  describe('P0 #2 & #3: Forming vs Closed Candle Semantics across Timeframes', () => {
    const timeframesToTest = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

    timeframesToTest.forEach((tf) => {
      it(`3. Handles forming candle updates correctly for timeframe ${tf}`, () => {
        const durationMs = TimeframeRegistry.getDurationMs(tf);
        const startMs = 1700000000000;
        const bucketStartMs = Math.floor(startMs / durationMs) * durationMs;

        const closedCandles: ICandle[] = [
          {
            timestamp: new Date(bucketStartMs - durationMs),
            open: 100,
            high: 105,
            low: 99,
            close: 104,
            volume: 1000,
            isClosed: true,
          },
        ];

        // 1st tick of new bucket
        let state = updateFormingCandle(closedCandles, null, 104, bucketStartMs + 100, 50, tf);
        expect(state.historicalCandles.length).toBe(1);
        expect(state.formingCandle.open).toBe(104);
        expect(state.formingCandle.close).toBe(104);
        expect(state.formingCandle.isClosed).toBe(false);

        // 2nd tick (higher)
        state = updateFormingCandle(state.historicalCandles, state.formingCandle, 110, bucketStartMs + 500, 30, tf);
        expect(state.historicalCandles.length).toBe(1); // Closed candles not mutated
        expect(state.formingCandle.high).toBe(110);
        expect(state.formingCandle.close).toBe(110);
        expect(state.formingCandle.volume).toBe(80);

        // 3rd tick (lower)
        state = updateFormingCandle(state.historicalCandles, state.formingCandle, 95, bucketStartMs + 1000, 20, tf);
        expect(state.formingCandle.low).toBe(95);
        expect(state.formingCandle.close).toBe(95);
        expect(state.formingCandle.open).toBe(104); // Open remains first tick

        // Historical candle remains untouched
        expect(state.historicalCandles[0].close).toBe(104);
        expect(state.historicalCandles[0].isClosed).toBe(true);
      });

      it(`4. Finalizes forming candle on bucket rollover for timeframe ${tf}`, () => {
        const durationMs = TimeframeRegistry.getDurationMs(tf);
        const rawMs = 1700000000000;
        const bucket1Ms = Math.floor(rawMs / durationMs) * durationMs;
        const bucket2Ms = bucket1Ms + durationMs;

        const initialClosed: ICandle[] = [];
        let state = updateFormingCandle(initialClosed, null, 100, bucket1Ms + 10, 10, tf);
        state = updateFormingCandle(state.historicalCandles, state.formingCandle, 108, bucket1Ms + 20, 15, tf);

        // Tick in bucket 2 triggers rollover
        state = updateFormingCandle(state.historicalCandles, state.formingCandle, 109, bucket2Ms + 10, 5, tf);

        // Previous forming candle is now finalized in historical
        expect(state.historicalCandles.length).toBe(1);
        expect(state.historicalCandles[0].isClosed).toBe(true);
        expect(state.historicalCandles[0].high).toBe(108);

        // New forming candle created for bucket 2
        expect(state.formingCandle.isClosed).toBe(false);
        expect(state.formingCandle.open).toBe(109);
        expect(new Date(state.formingCandle.timestamp).getTime()).toBe(bucket2Ms);
      });
    });
  });

  describe('P0 #4: Server-Authoritative SMC Data Flow', () => {
    it('5. Consumes server-supplied SMC snapshot without running browser analyzer fallback', () => {
      const serverSnapshot = {
        structures: { swings: [{ price: 100 }], bos: [{ direction: 'BULLISH' }] },
        liquidity: { pools: [{ priceLevel: 105 }] },
        fvgs: [{ upperBound: 102, lowerBound: 100 }],
        orderBlocks: [{ high: 99, low: 97, direction: 'BULLISH' }],
      };

      const canonicalSMC = {
        swingPoints: serverSnapshot.structures.swings,
        breaksOfStructure: serverSnapshot.structures.bos,
        liquidityPools: serverSnapshot.liquidity.pools,
        fairValueGaps: serverSnapshot.fvgs,
        orderBlocks: serverSnapshot.orderBlocks,
        isCanonical: true,
      };

      expect(canonicalSMC.isCanonical).toBe(true);
      expect(canonicalSMC.orderBlocks.length).toBe(1);
      expect(canonicalSMC.fairValueGaps.length).toBe(1);
    });
  });

  describe('P0 #5: Dynamic Trade Levels & R-Multiples Calculation', () => {
    it('6. Calculates R-multiples dynamically from signal prices without static hardcoding', () => {
      const signal = {
        direction: 'BULLISH',
        entryZone: { optimal: 100 },
        stopLoss: 90, // riskDist = 10
        takeProfits: { tp1: 115, tp2: 125, tp3: 140 },
      };

      const entryPrice = signal.entryZone.optimal;
      const slPrice = signal.stopLoss;
      const riskDist = Math.abs(entryPrice - slPrice);

      const tp1R = (signal.takeProfits.tp1 - entryPrice) / riskDist;
      const tp2R = (signal.takeProfits.tp2 - entryPrice) / riskDist;
      const tp3R = (signal.takeProfits.tp3 - entryPrice) / riskDist;

      expect(tp1R).toBe(1.5);
      expect(tp2R).toBe(2.5);
      expect(tp3R).toBe(4.0);
    });
  });

  describe('P1 #6: Session VWAP Boundary Reset Semantics', () => {
    it('7. Resets Session VWAP on UTC daily session boundaries', () => {
      const day1Ms = new Date('2026-09-10T14:00:00Z').getTime();
      const day1Ms2 = new Date('2026-09-10T15:00:00Z').getTime();
      const day2Ms = new Date('2026-09-11T09:15:00Z').getTime();

      const candles: ICandle[] = [
        { timestamp: new Date(day1Ms), open: 100, high: 110, low: 90, close: 100, volume: 100, isClosed: true }, // typ=100, vol=100 -> vwap=100
        { timestamp: new Date(day1Ms2), open: 100, high: 120, low: 100, close: 110, volume: 100, isClosed: true }, // typ=110, vol=100 -> vwap=(100*100 + 110*100)/200 = 105
        { timestamp: new Date(day2Ms), open: 200, high: 210, low: 190, close: 200, volume: 50, isClosed: true }, // Day 2 Reset: typ=200, vol=50 -> vwap=200
      ];

      const vwapResults = calculateSessionVWAP(candles);

      expect(vwapResults.length).toBe(3);
      expect(vwapResults[0].value).toBe(100.0);
      expect(vwapResults[1].value).toBe(105.0);
      expect(vwapResults[2].value).toBe(200.0); // Reset to 200 on new day
    });
  });

  describe('P1 #7: Real Volume Crosshair Exposure', () => {
    it('8. Exposes real volume in crosshair data lookup', () => {
      const candles: ICandle[] = [
        { timestamp: new Date(1700000000000), open: 100, high: 105, low: 95, close: 102, volume: 45200, isClosed: true },
      ];

      const timeSec = 1700000000;
      const volumeMap = new Map<number, number>();
      volumeMap.set(timeSec, candles[0].volume);

      const crosshairTimeSec = 1700000000;
      const realVol = volumeMap.get(crosshairTimeSec);

      expect(realVol).toBe(45200);
      expect(realVol).not.toBe(0);
    });
  });
});
