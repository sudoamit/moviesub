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
import { ICanonicalMarketSnapshot } from './canonical-market-snapshot';

export class SMCAnalyzer {
  /**
   * Performs full deterministic Smart Money Concepts (SMC) analysis on candle series
   * or a CanonicalMarketSnapshot with strict point-in-time correctness.
   */
  static analyze(
    input: ICandle[] | ICanonicalMarketSnapshot,
    config: ISMCAnalysisConfig = {},
  ): ISMCAnalysisResult {
    let closedCandles: ICandle[];
    let formingCandle: ICandle | null = null;
    let closedThrough: Date | undefined;
    let gaps: any[] = [];
    let isDegraded = false;
    const effectiveConfig: ISMCAnalysisConfig = { ...config };

    if (input && typeof input === 'object' && 'candles' in input && 'decisionTimestamp' in input) {
      // Input is an authoritative ICanonicalMarketSnapshot
      const snapshot = input as ICanonicalMarketSnapshot;
      closedCandles = [...snapshot.candles];
      formingCandle = snapshot.formingCandle ? { ...snapshot.formingCandle } : null;
      closedThrough = snapshot.closedThroughTimestamp;
      gaps = [...snapshot.gapDetails];
      isDegraded = snapshot.gapStatus === 'DETECTED';
      if (!effectiveConfig.timeframe) {
        effectiveConfig.timeframe = snapshot.executionTimeframe;
      }
      if (!effectiveConfig.asOfTimestamp) {
        effectiveConfig.asOfTimestamp = snapshot.decisionTimestamp;
      }
    } else {
      const rawCandles = (input as ICandle[]) || [];
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

      const partition = CandleNormalizer.partitionCandles(rawCandles, {
        asOfTimestamp: effectiveConfig.asOfTimestamp,
        timeframe: effectiveConfig.timeframe,
      });
      closedCandles = partition.closedCandles;
      formingCandle = partition.formingCandle;
      if (closedCandles.length > 0) {
        closedThrough = CandleNormalizer.getCandleCloseTimestamp(
          closedCandles[closedCandles.length - 1],
          effectiveConfig.timeframe,
        );
      }
      gaps = effectiveConfig.timeframe
        ? CandleNormalizer.detectGaps(closedCandles, effectiveConfig.timeframe)
        : [];
      isDegraded = gaps.length > 0;
    }

    if (closedCandles.length === 0) {
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
          timestamp: effectiveConfig.asOfTimestamp || new Date(),
        },
        currentTrend: Direction.NEUTRAL,
        isDegraded,
        gapCount: gaps.length,
        dataGaps: gaps,
      };
    }

    // 1. Detect Swings (Zero look-ahead bias)
    const swingPoints = SwingDetector.detectSwings(closedCandles, {
      leftBars: effectiveConfig.swingLeftBars,
      rightBars: effectiveConfig.swingRightBars,
      minDistanceAtrMultiplier: effectiveConfig.minSwingDistanceAtrMultiplier,
      asOfTimestamp: effectiveConfig.asOfTimestamp,
      timeframe: effectiveConfig.timeframe ? String(effectiveConfig.timeframe) : undefined,
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
    const breaksOfStructure = BOSEngine.detectBOS(closedCandles, swingPoints, {
      displacementThresholdAtr: effectiveConfig.displacementThresholdAtr,
      confirmationType: effectiveConfig.bosConfirmationType,
      minDisplacementScore: effectiveConfig.minDisplacementScore,
      asOfTimestamp: effectiveConfig.asOfTimestamp,
      timeframe: effectiveConfig.timeframe ? String(effectiveConfig.timeframe) : undefined,
    });

    // 3. Detect Change of Character (CHoCH)
    const changesOfCharacter = CHOCHEngine.detectCHOCH(closedCandles, swingPoints, {
      confirmationType: effectiveConfig.bosConfirmationType,
      minDisplacementScore: effectiveConfig.minDisplacementScore,
      asOfTimestamp: effectiveConfig.asOfTimestamp,
      timeframe: effectiveConfig.timeframe ? String(effectiveConfig.timeframe) : undefined,
    });

    // 4. Detect Liquidity Pools & Sweeps
    const { pools: liquidityPools, sweeps: liquiditySweeps } = LiquidityEngine.detectLiquidity(
      closedCandles,
      swingPoints,
      {
        equalHighLowToleranceAtr: effectiveConfig.equalHighLowToleranceAtr,
        asOfTimestamp: effectiveConfig.asOfTimestamp,
        timeframe: effectiveConfig.timeframe ? String(effectiveConfig.timeframe) : undefined,
      },
    );

    // 5. Detect Fair Value Gaps (FVG)
    const { allFVGs: fairValueGaps, activeFVGs } = FVGEngine.detectFVGs(closedCandles, {
      minGapAtrMultiplier: effectiveConfig.fvgMinGapAtr,
      asOfTimestamp: effectiveConfig.asOfTimestamp,
      timeframe: String(effectiveConfig.timeframe || ''),
    });

    // 6. Detect Order Blocks (OB)
    const { allOrderBlocks: orderBlocks, activeOrderBlocks } = OrderBlockEngine.detectOrderBlocks(
      closedCandles,
      breaksOfStructure,
      fairValueGaps,
      {
        displacementThresholdAtr: effectiveConfig.displacementThresholdAtr,
        minDisplacementScore: effectiveConfig.minDisplacementScore,
        asOfTimestamp: effectiveConfig.asOfTimestamp,
        timeframe: String(effectiveConfig.timeframe || ''),
      },
    );

    // 7. Calculate Dealing Range (Premium/Discount)
    const dealingRange = DealingRangeEngine.calculateDealingRange(swingPoints);

    // 8. Classify Market Regime
    const marketRegime = MarketRegimeEngine.classifyRegime(closedCandles, swingPoints);

    // Determine current structural trend from confirmed structure breaks at or before asOfTimestamp
    let currentTrend: Direction = Direction.NEUTRAL;
    if (breaksOfStructure.length > 0) {
      currentTrend = breaksOfStructure[breaksOfStructure.length - 1].direction;
    } else if (changesOfCharacter.length > 0) {
      currentTrend = changesOfCharacter[changesOfCharacter.length - 1].direction;
    }

    return {
      candlesCount: closedCandles.length,
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
