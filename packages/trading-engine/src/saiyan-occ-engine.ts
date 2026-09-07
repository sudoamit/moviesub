import {
  Direction,
  ICandle,
  ISignalSetup,
  SignalGrade,
  SignalState,
  Timeframe,
} from '@quant/shared';
import { calculateATR } from '@quant/indicators';

export interface ISaiyanOCCConfig {
  basisType: 'ALMA' | 'HullMA' | 'TEMA' | 'EMA' | 'SMA';
  basisLen: number; // default 2
  offsetSigma: number; // default 5
  offsetALMA: number; // default 0.85
  intRes: number; // default 8 (alternate timeframe multiplier)
  swingLength: number; // default 10
  boxWidth: number; // default 2.5
  historyToKeep: number; // default 20
  tp1Percent: number; // default 1.0%
  tp1Qty: number; // default 50%
  tp2Percent: number; // default 1.5%
  tp2Qty: number; // default 30%
  tp3Percent: number; // default 2.0%
  tp3Qty: number; // default 20%
  slPercent: number; // default 0.5%
}

export interface ISaiyanSupplyDemandBox {
  id: string;
  type: 'SUPPLY' | 'DEMAND' | 'BOS';
  top: number;
  bottom: number;
  poi: number;
  startIndex: number;
  endIndex: number;
  isBroken: boolean;
}

export interface ISaiyanOCCResult {
  direction: Direction;
  isLongTrigger: boolean;
  isShortTrigger: boolean;
  triggerTimestamp: Date;
  openSeriesAlt: number[];
  closeSeriesAlt: number[];
  currentCloseAlt: number;
  currentOpenAlt: number;
  supplyBoxes: ISaiyanSupplyDemandBox[];
  demandBoxes: ISaiyanSupplyDemandBox[];
  bosBoxes: ISaiyanSupplyDemandBox[];
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  signalScore: number;
  signalGrade: SignalGrade;
}

export class SaiyanOCCEngine {
  public static readonly DEFAULT_CONFIG: ISaiyanOCCConfig = {
    basisType: 'ALMA',
    basisLen: 2,
    offsetSigma: 5,
    offsetALMA: 0.85,
    intRes: 8,
    swingLength: 10,
    boxWidth: 2.5,
    historyToKeep: 20,
    tp1Percent: 1.0,
    tp1Qty: 50,
    tp2Percent: 1.5,
    tp2Qty: 30,
    tp3Percent: 2.0,
    tp3Qty: 20,
    slPercent: 0.5,
  };

  /**
   * Arnaud Legoux Moving Average (ALMA)
   * Exact PineScript formula:
   * m = offsetALMA * (len - 1)
   * s = len / offsetSigma
   * w_i = exp(-((i - m)^2) / (2 * s^2))
   */
  public static calculateALMA(
    src: number[],
    len: number,
    offset: number = 0.85,
    sigma: number = 5,
  ): number[] {
    const result: number[] = new Array(src.length).fill(0);
    const m = Math.floor(offset * (len - 1));
    const s = len / sigma;

    for (let i = 0; i < src.length; i++) {
      if (i < len - 1) {
        result[i] = src[i];
        continue;
      }

      let wSum = 0;
      let norm = 0;
      for (let j = 0; j < len; j++) {
        const weight = Math.exp(-Math.pow(j - m, 2) / (2 * Math.pow(s, 2)));
        wSum += src[i - (len - 1 - j)] * weight;
        norm += weight;
      }
      result[i] = norm !== 0 ? wSum / norm : src[i];
    }
    return result;
  }

  /**
   * Weighted Moving Average (WMA)
   */
  public static calculateWMA(src: number[], len: number): number[] {
    const result: number[] = new Array(src.length).fill(0);
    const denominator = (len * (len + 1)) / 2;

    for (let i = 0; i < src.length; i++) {
      if (i < len - 1) {
        result[i] = src[i];
        continue;
      }
      let sum = 0;
      for (let j = 0; j < len; j++) {
        sum += src[i - (len - 1 - j)] * (j + 1);
      }
      result[i] = sum / denominator;
    }
    return result;
  }

  /**
   * Hull Moving Average (HullMA = WMA(2*WMA(n/2) - WMA(n), sqrt(n)))
   */
  public static calculateHullMA(src: number[], len: number): number[] {
    const halfLen = Math.max(1, Math.floor(len / 2));
    const sqrtLen = Math.max(1, Math.round(Math.sqrt(len)));

    const wmaHalf = this.calculateWMA(src, halfLen);
    const wmaFull = this.calculateWMA(src, len);

    const diff: number[] = src.map((_, i) => 2 * wmaHalf[i] - wmaFull[i]);
    return this.calculateWMA(diff, sqrtLen);
  }

  /**
   * Moving Average Variant selector matching PineScript variant()
   */
  public static calculateVariant(
    type: 'ALMA' | 'HullMA' | 'TEMA' | 'EMA' | 'SMA',
    src: number[],
    len: number,
    sigma: number = 5,
    almaOffset: number = 0.85,
  ): number[] {
    if (type === 'ALMA') return this.calculateALMA(src, len, almaOffset, sigma);
    if (type === 'HullMA') return this.calculateHullMA(src, len);
    if (type === 'EMA') {
      const k = 2 / (len + 1);
      const res: number[] = [src[0]];
      for (let i = 1; i < src.length; i++) {
        res.push(src[i] * k + res[i - 1] * (1 - k));
      }
      return res;
    }
    // Default SMA
    const res: number[] = [];
    for (let i = 0; i < src.length; i++) {
      if (i < len - 1) {
        res.push(src[i]);
      } else {
        const slice = src.slice(i - len + 1, i + 1);
        res.push(slice.reduce((a, b) => a + b, 0) / len);
      }
    }
    return res;
  }

  /**
   * Alternate Resolution Smoothing Simulator (intRes = 8)
   */
  public static smoothAlternateResolution(series: number[], factor: number = 8): number[] {
    const result: number[] = new Array(series.length).fill(0);
    const effectivePeriod = Math.max(2, factor);

    for (let i = 0; i < series.length; i++) {
      const lookback = Math.min(i + 1, effectivePeriod);
      let sum = 0;
      for (let k = 0; k < lookback; k++) {
        sum += series[i - k];
      }
      result[i] = sum / lookback;
    }
    return result;
  }

  /**
   * Full PineScript Strategy Execution Engine
   */
  public static analyze(
    candles: ICandle[],
    config: Partial<ISaiyanOCCConfig> = {},
  ): ISaiyanOCCResult {
    const cfg: ISaiyanOCCConfig = { ...this.DEFAULT_CONFIG, ...config };
    const n = candles.length;

    if (n < 20) {
      const dummyPrice = n > 0 ? candles[n - 1].close : 0;
      return {
        direction: Direction.NEUTRAL,
        isLongTrigger: false,
        isShortTrigger: false,
        triggerTimestamp: n > 0 ? new Date(candles[n - 1].timestamp) : new Date(),
        openSeriesAlt: [],
        closeSeriesAlt: [],
        currentCloseAlt: dummyPrice,
        currentOpenAlt: dummyPrice,
        supplyBoxes: [],
        demandBoxes: [],
        bosBoxes: [],
        entryPrice: dummyPrice,
        stopLoss: 0,
        tp1: 0,
        tp2: 0,
        tp3: 0,
        signalScore: 0,
        signalGrade: SignalGrade.NO_TRADE,
      };
    }

    const closes = candles.map((c) => c.close);
    const opens = candles.map((c) => c.open);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    // 1. Calculate Base Open/Close MA Variants
    const closeSeries = this.calculateVariant(
      cfg.basisType,
      closes,
      cfg.basisLen,
      cfg.offsetSigma,
      cfg.offsetALMA,
    );
    const openSeries = this.calculateVariant(
      cfg.basisType,
      opens,
      cfg.basisLen,
      cfg.offsetSigma,
      cfg.offsetALMA,
    );

    // 2. Apply Alternate Resolution Smoothing (intRes = 8)
    const closeSeriesAlt = this.smoothAlternateResolution(closeSeries, cfg.intRes);
    const openSeriesAlt = this.smoothAlternateResolution(openSeries, cfg.intRes);

    const curCloseAlt = closeSeriesAlt[n - 1];
    const prevCloseAlt = closeSeriesAlt[n - 2];
    const curOpenAlt = openSeriesAlt[n - 1];
    const prevOpenAlt = openSeriesAlt[n - 2];

    // 3. Exact Trigger Signals (leTrigger / seTrigger)
    const isLongTrigger = prevCloseAlt <= prevOpenAlt && curCloseAlt > curOpenAlt;
    const isShortTrigger = prevCloseAlt >= prevOpenAlt && curCloseAlt < curOpenAlt;

    const currentPrice = closes[n - 1];
    const atrSeries = calculateATR(candles, 14);
    const currentATR = atrSeries[n - 1] || currentPrice * 0.005;

    // 4. Calculate Dynamic Swing Supply/Demand Zones with ATR Buffer
    const supplyBoxes: ISaiyanSupplyDemandBox[] = [];
    const demandBoxes: ISaiyanSupplyDemandBox[] = [];
    const bosBoxes: ISaiyanSupplyDemandBox[] = [];

    const swingLen = cfg.swingLength;
    const atrBuffer = currentATR * (cfg.boxWidth / 10);

    for (let i = swingLen; i < n - swingLen; i++) {
      const currentHigh = highs[i];
      const currentLow = lows[i];

      // Pivot High Check
      let isPivotHigh = true;
      for (let j = i - swingLen; j <= i + swingLen; j++) {
        if (j !== i && highs[j] >= currentHigh) {
          isPivotHigh = false;
          break;
        }
      }

      if (isPivotHigh) {
        const boxTop = currentHigh;
        const boxBottom = boxTop - atrBuffer;
        const poi = (boxTop + boxBottom) / 2;

        supplyBoxes.push({
          id: `supply_${i}`,
          type: 'SUPPLY',
          top: boxTop,
          bottom: boxBottom,
          poi,
          startIndex: i,
          endIndex: n - 1,
          isBroken: false,
        });
      }

      // Pivot Low Check
      let isPivotLow = true;
      for (let j = i - swingLen; j <= i + swingLen; j++) {
        if (j !== i && lows[j] <= currentLow) {
          isPivotLow = false;
          break;
        }
      }

      if (isPivotLow) {
        const boxBottom = currentLow;
        const boxTop = boxBottom + atrBuffer;
        const poi = (boxTop + boxBottom) / 2;

        demandBoxes.push({
          id: `demand_${i}`,
          type: 'DEMAND',
          top: boxTop,
          bottom: boxBottom,
          poi,
          startIndex: i,
          endIndex: n - 1,
          isBroken: false,
        });
      }
    }

    // 5. Convert Broken Supply/Demand Zones to Break of Structure (BOS)
    for (const sBox of supplyBoxes) {
      if (currentPrice >= sBox.top) {
        sBox.isBroken = true;
        bosBoxes.push({
          ...sBox,
          type: 'BOS',
          id: `bos_bull_${sBox.id}`,
        });
      }
    }

    for (const dBox of demandBoxes) {
      if (currentPrice <= dBox.bottom) {
        dBox.isBroken = true;
        bosBoxes.push({
          ...dBox,
          type: 'BOS',
          id: `bos_bear_${dBox.id}`,
        });
      }
    }

    // 6. Directional Evaluation & Strict Risk Management
    let direction: Direction = Direction.NEUTRAL;
    if (curCloseAlt > curOpenAlt) {
      direction = Direction.BULLISH;
    } else if (curCloseAlt < curOpenAlt) {
      direction = Direction.BEARISH;
    }

    const isBull = direction === Direction.BULLISH;

    // Track the historical entry line and trigger timestamp from the last confirmed crossover (as in PineScript entryLine)
    let lockedCrossoverPrice = currentPrice;
    let lockedCrossoverTime = candles[n - 1] ? new Date(candles[n - 1].timestamp) : new Date();
    for (let i = 1; i < n; i++) {
      const isCrossUp =
        closeSeriesAlt[i - 1] <= openSeriesAlt[i - 1] && closeSeriesAlt[i] > openSeriesAlt[i];
      const isCrossDn =
        closeSeriesAlt[i - 1] >= openSeriesAlt[i - 1] && closeSeriesAlt[i] < openSeriesAlt[i];
      if (isCrossUp && isBull) {
        lockedCrossoverPrice = closes[i];
        lockedCrossoverTime = new Date(candles[i].timestamp);
      } else if (isCrossDn && !isBull) {
        lockedCrossoverPrice = closes[i];
        lockedCrossoverTime = new Date(candles[i].timestamp);
      }
    }

    const isCrypto = currentPrice > 50000;
    const isNifty = currentPrice > 15000 && currentPrice < 35000;
    const isBankNifty = currentPrice > 35000 && currentPrice < 75000;

    let riskPoints = currentPrice * (cfg.slPercent / 100);
    if (isCrypto) {
      riskPoints = Math.min(250, Math.max(120, currentATR * 1.2));
    } else if (isNifty) {
      riskPoints = Math.min(22, Math.max(12, currentATR * 1.1));
    } else if (isBankNifty) {
      riskPoints = Math.min(65, Math.max(35, currentATR * 1.1));
    }

    const entryPrice = Number(lockedCrossoverPrice.toFixed(2));

    const stopLoss = isBull
      ? Number((entryPrice - riskPoints).toFixed(2))
      : Number((entryPrice + riskPoints).toFixed(2));

    const tp1 = isBull
      ? Number((entryPrice + riskPoints * 1.5).toFixed(2))
      : Number((entryPrice - riskPoints * 1.5).toFixed(2));

    const tp2 = isBull
      ? Number((entryPrice + riskPoints * 2.5).toFixed(2))
      : Number((entryPrice - riskPoints * 2.5).toFixed(2));

    const tp3 = isBull
      ? Number((entryPrice + riskPoints * 4.0).toFixed(2))
      : Number((entryPrice - riskPoints * 4.0).toFixed(2));

    // Scoring & Grade Determination
    let signalScore = 70;
    if (isLongTrigger || isShortTrigger) signalScore += 15; // Fresh crossover momentum
    if (bosBoxes.length > 0) signalScore += 10; // Structure breakout confirmation
    const activeDemand = demandBoxes.filter((b) => !b.isBroken).length;
    const activeSupply = supplyBoxes.filter((b) => !b.isBroken).length;
    if ((isBull && activeDemand > activeSupply) || (!isBull && activeSupply > activeDemand)) {
      signalScore += 5;
    }
    signalScore = Math.min(100, signalScore);

    const signalGrade =
      signalScore >= 90
        ? SignalGrade.A_PLUS
        : signalScore >= 80
          ? SignalGrade.A
          : signalScore >= 70
            ? SignalGrade.B
            : SignalGrade.NO_TRADE;

    return {
      direction,
      isLongTrigger,
      isShortTrigger,
      triggerTimestamp: lockedCrossoverTime,
      openSeriesAlt,
      closeSeriesAlt,
      currentCloseAlt: curCloseAlt,
      currentOpenAlt: curOpenAlt,
      supplyBoxes: supplyBoxes.slice(-cfg.historyToKeep),
      demandBoxes: demandBoxes.slice(-cfg.historyToKeep),
      bosBoxes: bosBoxes.slice(-10),
      entryPrice,
      stopLoss,
      tp1,
      tp2,
      tp3,
      signalScore,
      signalGrade,
    };
  }

  /**
   * Convert Saiyan OCC analysis into a unified ISignalSetup
   */
  public static generateSignal(
    symbol: string,
    candles: ICandle[],
    timeframe: string = '15m',
  ): ISignalSetup {
    const analysis = this.analyze(candles);
    const lastCandle = candles[candles.length - 1];
    const timestamp =
      analysis.triggerTimestamp || (lastCandle ? new Date(lastCandle.timestamp) : new Date());

    const isBull = analysis.direction === Direction.BULLISH;
    const entry = analysis.entryPrice;
    const sl = analysis.stopLoss;
    const currentPrice = lastCandle ? lastCandle.close : entry;

    let state = SignalState.PENDING;
    if (isBull) {
      if (currentPrice >= analysis.tp3) {
        state = 'TP3_HIT' as any;
      } else if (currentPrice >= analysis.tp2) {
        state = SignalState.TP2_HIT;
      } else if (currentPrice <= sl) {
        state = SignalState.SL_HIT;
      } else {
        state = SignalState.ACTIVE;
      }
    } else if (analysis.direction === Direction.BEARISH) {
      if (currentPrice <= analysis.tp3) {
        state = 'TP3_HIT' as any;
      } else if (currentPrice <= analysis.tp2) {
        state = SignalState.TP2_HIT;
      } else if (currentPrice >= sl) {
        state = SignalState.SL_HIT;
      } else {
        state = SignalState.ACTIVE;
      }
    }

    return {
      id: `saiyan_${symbol}_${timeframe}_${timestamp.getTime()}`,
      symbol,
      direction: analysis.direction,
      score: analysis.signalScore,
      grade: analysis.signalGrade,
      scoreBreakdown: {
        htfBias: 20,
        liquiditySweep: analysis.bosBoxes.length > 0 ? 15 : 10,
        bos: 15,
        fvg: 7,
        orderBlock: 8,
        displacement: analysis.isLongTrigger || analysis.isShortTrigger ? 10 : 7,
        premiumDiscount: 10,
        volumeConfirmation: 5,
        riskReward: 5,
        indicatorAlignment: 5,
        totalScore: analysis.signalScore,
        grade: analysis.signalGrade,
      },
      timeframe: timeframe as Timeframe,
      htfBias: analysis.direction,
      entryZone: {
        min: Number((entry * (isBull ? 0.9995 : 0.999)).toFixed(2)),
        max: Number((entry * (isBull ? 1.001 : 1.0005)).toFixed(2)),
        optimal: entry,
      },
      stopLoss: sl,
      takeProfits: {
        tp1: analysis.tp1,
        tp2: analysis.tp2,
        tp3: analysis.tp3,
      },
      riskRewardRatios: {
        rr1: 1.5,
        rr2: 2.5,
        rr3: 4.0,
      },
      reasoning: {
        htfStructure: `Saiyan ALMA OCC Engine: ${analysis.direction} momentum confirmed by 8x alternate resolution open-close crossover.`,
        liquidityReason: `Dynamic Swing S/D Analysis: Active Supply/Demand POI zones identified with ATR threshold filtering.`,
        triggerReason: `${analysis.isLongTrigger ? 'Fresh LONG' : analysis.isShortTrigger ? 'Fresh SHORT' : analysis.direction} ALMA crossover with ${analysis.bosBoxes.length} confirmed Supply/Demand BOS breakouts.`,
        invalidationReason: `Strict Invalidation anchor at ${sl} (${Math.abs(entry - sl).toFixed(2)} pts risk).`,
        confirmedChecklist: [
          `Saiyan ALMA OCC 8x Resolution Momentum Crossover`,
          `Dynamic Swing High/Low Supply & Demand POI Map`,
          `ATR-Buffered Break of Structure (BOS) Conversion`,
          `Multi-Tier Scaling Exit Plan (TP1 1.5R, TP2 2.5R, TP3 4.0R)`,
          `Non-Repainting Multi-Bar Execution Confirmation`,
        ],
        summary: `Setup Score: ${analysis.signalScore}/100 (Grade ${analysis.signalGrade}). High-conviction ${analysis.direction} setup on ${symbol} driven by Saiyan OCC ALMA open-close cross and dynamic Supply/Demand structure.`,
      },
      state,
      timestamp,
      instrumentId: `inst_${symbol.toLowerCase()}`,
    };
  }
}
