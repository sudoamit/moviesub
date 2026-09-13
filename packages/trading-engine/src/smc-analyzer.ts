import { Direction, ICandle, StructureType } from '@quant/shared';
import { ISMCAnalysisConfig, ISMCAnalysisResult } from './types';
import { SwingDetector } from './swing-detector';
import { BOSEngine } from './bos-engine';
import { CHOCHEngine } from './choch-engine';
import { LiquidityEngine } from './liquidity-engine';
import { FVGEngine } from './fvg-engine';
import { OrderBlockEngine } from './order-block-engine';
import { DealingRangeEngine } from './dealing-range';
import { MarketRegimeEngine } from './market-regime';
import { CandleNormalizer } from './candle-normalizer';

export class SMCAnalyzer {
  /**
   * Performs full deterministic Smart Money Concepts (SMC) analysis on candle series
   * with strict point-in-time correctness.
   */
  static analyze(rawCandles: ICandle[], config: ISMCAnalysisConfig = {}): ISMCAnalysisResult {
    if (!rawCandles || rawCandles.length === 0) {
      return {
        candlesCount: 0,
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
          regime: 'RANGE' as any,
          atr: 0,
          adx: 0,
          volatility: 0,
          timestamp: new Date(),
        },
        currentTrend: Direction.NEUTRAL,
        isDegraded: false,
        gapCount: 0,
        dataGaps: [],
      };
    }

    const { closedCandles: candles, formingCandle } = CandleNormalizer.partitionCandles(rawCandles, {
      asOfTimestamp: config.asOfTimestamp,
      timeframe: config.timeframe,
    });

    if (candles.length === 0) {
      return {
        candlesCount: 0,
        formingCandle,
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
          regime: 'RANGE' as any,
          atr: 0,
          adx: 0,
          volatility: 0,
          timestamp: config.asOfTimestamp || new Date(),
        },
        currentTrend: Direction.NEUTRAL,
        isDegraded: false,
        gapCount: 0,
        dataGaps: [],
      };
    }

    const closedThrough = CandleNormalizer.getCandleCloseTimestamp(
      candles[candles.length - 1],
      config.timeframe,
    );

    // Detect data gaps
    const gaps = config.timeframe
      ? CandleNormalizer.detectGaps(candles, config.timeframe)
      : [];
    const isDegraded = gaps.length > 0;

    // 1. Detect Swings (Zero look-ahead bias)
    const swingPoints = SwingDetector.detectSwings(candles, {
      leftBars: config.swingLeftBars,
      rightBars: config.swingRightBars,
      minDistanceAtrMultiplier: config.minSwingDistanceAtrMultiplier,
      asOfTimestamp: config.asOfTimestamp,
      timeframe: config.timeframe ? String(config.timeframe) : undefined,
    });

    const confirmedSwingHighs = swingPoints.filter(
      (s) =>
        s.type === StructureType.SWING_HIGH ||
        s.type === StructureType.HIGHER_HIGH ||
        s.type === StructureType.LOWER_HIGH,
    );

    const confirmedSwingLows = swingPoints.filter(
      (s) =>
        s.type === StructureType.SWING_LOW ||
        s.type === StructureType.HIGHER_LOW ||
        s.type === StructureType.LOWER_LOW,
    );

    // 2. Detect Breaks of Structure (BOS)
    const breaksOfStructure = BOSEngine.detectBOS(candles, swingPoints, {
      displacementThresholdAtr: config.displacementThresholdAtr,
      confirmationType: config.bosConfirmationType,
      minDisplacementScore: config.minDisplacementScore,
      asOfTimestamp: config.asOfTimestamp,
      timeframe: config.timeframe ? String(config.timeframe) : undefined,
    });

    // 3. Detect Change of Character (CHoCH)
    const changesOfCharacter = CHOCHEngine.detectCHOCH(candles, swingPoints, {
      confirmationType: config.bosConfirmationType,
      minDisplacementScore: config.minDisplacementScore,
      asOfTimestamp: config.asOfTimestamp,
      timeframe: config.timeframe ? String(config.timeframe) : undefined,
    });

    // 4. Detect Liquidity Pools & Sweeps
    const { pools: liquidityPools, sweeps: liquiditySweeps } = LiquidityEngine.detectLiquidity(
      candles,
      swingPoints,
      {
        equalHighLowToleranceAtr: config.equalHighLowToleranceAtr,
        asOfTimestamp: config.asOfTimestamp,
        timeframe: config.timeframe ? String(config.timeframe) : undefined,
      },
    );

    // 5. Detect Fair Value Gaps (FVG)
    const { allFVGs: fairValueGaps, activeFVGs } = FVGEngine.detectFVGs(candles, {
      minGapAtrMultiplier: config.fvgMinGapAtr,
      asOfTimestamp: config.asOfTimestamp,
      timeframe: String(config.timeframe || ''),
    });

    // 6. Detect Order Blocks (OB)
    const { allOrderBlocks: orderBlocks, activeOrderBlocks } = OrderBlockEngine.detectOrderBlocks(
      candles,
      breaksOfStructure,
      fairValueGaps,
      {
        displacementThresholdAtr: config.displacementThresholdAtr,
        minDisplacementScore: config.minDisplacementScore,
        asOfTimestamp: config.asOfTimestamp,
        timeframe: String(config.timeframe || ''),
      },
    );

    // 7. Calculate Dealing Range (Premium/Discount)
    const dealingRange = DealingRangeEngine.calculateDealingRange(swingPoints);

    // 8. Classify Market Regime
    const marketRegime = MarketRegimeEngine.classifyRegime(candles, swingPoints);

    // Determine current structural trend from confirmed structure breaks at or before asOfTimestamp
    let currentTrend: Direction = Direction.NEUTRAL;
    if (breaksOfStructure.length > 0) {
      currentTrend = breaksOfStructure[breaksOfStructure.length - 1].direction;
    } else if (changesOfCharacter.length > 0) {
      currentTrend = changesOfCharacter[changesOfCharacter.length - 1].direction;
    }

    return {
      candlesCount: candles.length,
      closedThrough,
      formingCandle,
      isDegraded,
      gapCount: gaps.length,
      dataGaps: gaps,
      swingPoints,
      confirmedSwingHighs,
      confirmedSwingLows,
      breaksOfStructure,
      changesOfCharacter,
      liquidityPools,
      liquiditySweeps,
      fairValueGaps,
      activeFVGs,
      orderBlocks,
      activeOrderBlocks,
      dealingRange,
      marketRegime,
      currentTrend,
    };
  }
}
