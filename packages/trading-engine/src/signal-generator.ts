import {
  Direction,
  ICandle,
  ISignalSetup,
  MTFMode,
  SignalGrade,
  SignalState,
  Timeframe,
} from '@quant/shared';
import { SMCAnalyzer } from './smc-analyzer';
import { IMTFTimeframeData, MultiTimeframeAnalyzer } from './mtf-analyzer';
import { TradeLevelsCalculator } from './trade-levels';
import { IScoringInputs, IScoringWeights, SignalScorer } from './signal-scorer';
import { ReasoningGenerator } from './reasoning-generator';
import { calculateEMA, calculateRSI } from '@quant/indicators';
import { SessionFilter } from './session-filter';
import { SaiyanOCCEngine } from './saiyan-occ-engine';
import { SnapshotBuilder } from './quant/snapshot-builder';
import { CandleNormalizer } from './candle-normalizer';

export interface IGenerateSignalOptions {
  symbol: string;
  executionCandles: ICandle[];
  executionTimeframe?: Timeframe | string;
  htf1Candles?: ICandle[];
  htf1Timeframe?: Timeframe | string;
  htf2Candles?: ICandle[];
  htf2Timeframe?: Timeframe | string;
  mtfMode?: MTFMode;
  strategyMode?: 'SMC' | 'SAIYAN_OCC' | 'HYBRID';
  asOfTimestamp?: Date;
  scoringWeights?: IScoringWeights;
  strategyConfig?: Record<string, any>;
  minimumCandles?: number;
}

export class SignalGenerator {
  /**
   * Generates analytical LONG / SHORT / NO_TRADE signal setup with full scoring, levels, and rationale
   * with strictly zero look-ahead bias.
   */
  static generateSignal(options: IGenerateSignalOptions): ISignalSetup {
    const symbol = options.symbol.toUpperCase();
    const executionTf = options.executionTimeframe || Timeframe.M15;
    const htf1Tf = options.htf1Timeframe || Timeframe.H1;
    const htf2Tf = options.htf2Timeframe || Timeframe.H4;
    const strategyMode = options.strategyMode || 'SMC';

    // 1. Canonical normalization & point-in-time decision timestamp calculation
    const rawExecCandles = CandleNormalizer.normalize(options.executionCandles);
    const rawHtf1Candles = options.htf1Candles ? CandleNormalizer.normalize(options.htf1Candles) : [];
    const rawHtf2Candles = options.htf2Candles ? CandleNormalizer.normalize(options.htf2Candles) : undefined;

    let decisionTimestamp: Date;
    if (options.asOfTimestamp) {
      decisionTimestamp = new Date(options.asOfTimestamp.getTime());
    } else {
      const closedExec = rawExecCandles.filter((c) => c.isClosed !== false);
      const lastClosed = closedExec.length > 0 ? closedExec[closedExec.length - 1] : null;
      decisionTimestamp = lastClosed
        ? CandleNormalizer.getCandleCloseTimestamp(lastClosed, executionTf)
        : new Date();
    }

    const execCandles = CandleNormalizer.getClosedCandlesAsOf(rawExecCandles, executionTf, decisionTimestamp);
    const htf1Candles = CandleNormalizer.getClosedCandlesAsOf(rawHtf1Candles, htf1Tf, decisionTimestamp);
    const htf2Candles = rawHtf2Candles
      ? CandleNormalizer.getClosedCandlesAsOf(rawHtf2Candles, htf2Tf, decisionTimestamp)
      : undefined;

    // Candidate Strategy Injection Point: Deterministic signal setup support
    const detList = Array.isArray(options.strategyConfig?.deterministicSignals)
      ? options.strategyConfig.deterministicSignals
      : options.strategyConfig?.deterministicSignal
        ? [options.strategyConfig.deterministicSignal]
        : undefined;

    if (detList && detList.length > 0) {
      const currTime = decisionTimestamp.getTime();
      const candleOpenTime =
        rawExecCandles.length > 0
          ? rawExecCandles[rawExecCandles.length - 1].timestamp instanceof Date
            ? rawExecCandles[rawExecCandles.length - 1].timestamp.getTime()
            : new Date(rawExecCandles[rawExecCandles.length - 1].timestamp).getTime()
          : currTime;

      const det = detList.find((d: any) => {
        if (!d.timestamp) return true;
        const targetTime =
          d.timestamp instanceof Date
            ? d.timestamp.getTime()
            : typeof d.timestamp === 'number'
              ? d.timestamp
              : new Date(d.timestamp).getTime();
        return Math.abs(currTime - targetTime) <= 1000 || Math.abs(candleOpenTime - targetTime) <= 1000;
      });

      if (det) {
        const entryPrice =
          det.entryPrice || (execCandles.length > 0 ? execCandles[execCandles.length - 1].close : 100);
        const baseStopPrice =
          det.stopLoss ||
          (det.direction === Direction.BEARISH ? entryPrice * 1.05 : entryPrice * 0.95);
        const baseStopDist = Math.abs(entryPrice - baseStopPrice);
        const target1 =
          det.takeProfits?.tp1 ??
          det.tp1 ??
          (det.direction === Direction.BEARISH
            ? entryPrice - baseStopDist * 1.5
            : entryPrice + baseStopDist * 1.5);
        const target2 =
          det.takeProfits?.tp2 ??
          det.tp2 ??
          (det.direction === Direction.BEARISH
            ? entryPrice - baseStopDist * 2.5
            : entryPrice + baseStopDist * 2.5);
        const target3 =
          det.takeProfits?.tp3 ??
          det.tp3 ??
          (det.direction === Direction.BEARISH
            ? entryPrice - baseStopDist * 4.0
            : entryPrice + baseStopDist * 4.0);

        const sigScore = det.score ?? 80;
        const configMinScore =
          options.strategyConfig?.minMtfScore ??
          options.strategyConfig?.minScore;
        if (typeof configMinScore === 'number' && Number.isFinite(configMinScore) && sigScore < configMinScore) {
          return SignalGenerator.createNoTradeSignal(
            symbol,
            executionTf,
            `Signal score (${sigScore}) below configured candidate minMtfScore (${configMinScore})`,
            decisionTimestamp,
          );
        }

        return {
          id: det.id || `sig_${currTime}`,
          symbol,
          direction: det.direction,
          score: sigScore,
          grade: det.grade ?? SignalGrade.A_PLUS,
          entryZone: det.entryZone ?? {
            min: entryPrice,
            max: entryPrice,
            optimal: entryPrice,
          },
          stopLoss: baseStopPrice,
          takeProfits: {
            tp1: target1,
            tp2: target2,
            tp3: target3,
          },
          riskRewardRatios: {
            rr1: 1.5,
            rr2: 2.5,
            rr3: 4.0,
          },
          reasoning: {} as any,
          scoreBreakdown: {} as any,
          timeframe: String(executionTf),
          reasons: det.reasons ?? ['Candidate deterministic setup'],
          marketContext: det.marketContext,
          features: det.features,
          marketState: det.marketState,
          prediction: det.prediction,
          timestamp: new Date(currTime),
          state: SignalState.ACTIVE,
        } as any;
      }
      return SignalGenerator.createNoTradeSignal(
        symbol,
        executionTf,
        'No deterministic signal configured for timestamp',
        decisionTimestamp,
      );
    }

    const minCandles = options.minimumCandles !== undefined ? options.minimumCandles : 20;
    if (!execCandles || execCandles.length < minCandles) {
      return SignalGenerator.createNoTradeSignal(
        symbol,
        executionTf,
        execCandles.length === 0
          ? 'No fully closed execution candles available as-of timestamp'
          : 'Insufficient historical candle data',
        decisionTimestamp,
      );
    }

    const lastCandle = execCandles[execCandles.length - 1];

    // 2. Direct Routing if Saiyan OCC Strategy is Selected
    if (strategyMode === 'SAIYAN_OCC') {
      return SaiyanOCCEngine.generateSignal(symbol, execCandles, String(executionTf));
    }

    // 3. Run Execution Timeframe SMC Analysis (strictly point-in-time)
    const execAnalysis = SMCAnalyzer.analyze(execCandles, { asOfTimestamp: decisionTimestamp });

    // 4. Run Multi-Timeframe Alignment (with strict timestamp filtering)
    const execTfData: IMTFTimeframeData = {
      timeframe: executionTf,
      candles: execCandles,
      analysis: execAnalysis,
    };
    const htf1Data: IMTFTimeframeData = {
      timeframe: htf1Tf,
      candles: htf1Candles,
    };
    const htf2Data: IMTFTimeframeData | undefined = htf2Candles
      ? {
          timeframe: htf2Tf,
          candles: htf2Candles,
        }
      : undefined;

    const mtf = MultiTimeframeAnalyzer.analyzeMTF(
      execTfData,
      htf1Data,
      htf2Data,
      options.mtfMode ?? MTFMode.BALANCED,
      decisionTimestamp,
    );

    const currentPrice = lastCandle.close;

    // 5. Determine Directional Candidate with Strict HTF Bias Gate
    let candidateDir = mtf.htfBias;
    if (candidateDir === Direction.NEUTRAL) {
      candidateDir = execAnalysis.currentTrend;
    }

    if (candidateDir === Direction.NEUTRAL) {
      return SignalGenerator.createNoTradeSignal(
        symbol,
        executionTf,
        'No directional trend bias on HTF or execution timeframe (Consolidation/Chop)',
        decisionTimestamp,
      );
    }

    // High-Accuracy Hard Filter 1: Eliminate Counter-Trend Trading against HTF
    if (mtf.htfBias !== Direction.NEUTRAL && candidateDir !== mtf.htfBias) {
      return SignalGenerator.createNoTradeSignal(
        symbol,
        executionTf,
        `Rejected: Execution direction (${candidateDir}) conflicts with ${mtf.htfBias} Higher Timeframe Order Flow`,
        decisionTimestamp,
      );
    }

    // 6. Identify Trigger Components (Liquidity Sweep, Order Block, FVG, Structure Break)
    const recentSweeps = execAnalysis.liquiditySweeps.slice(-4);
    const hasSweep =
      recentSweeps.length > 0 &&
      recentSweeps.some((s) =>
        candidateDir === Direction.BULLISH
          ? s.priceLevel <= currentPrice * 1.005
          : s.priceLevel >= currentPrice * 0.995,
      );

    const recentBOS = execAnalysis.breaksOfStructure.slice(-3);
    const recentCHOCH = execAnalysis.changesOfCharacter.slice(-3);
    const hasStructureBreak =
      recentBOS.some((b) => b.direction === candidateDir) ||
      recentCHOCH.some((c) => c.direction === candidateDir);

    const activeFVG =
      execAnalysis.activeFVGs.filter((f) => f.direction === candidateDir).slice(-1)[0] || null;

    const activeOB =
      execAnalysis.activeOrderBlocks.filter((ob) => ob.direction === candidateDir).slice(-1)[0] ||
      null;

    // High-Accuracy Hard Filter 2: Strict Dealing Range Equilibrium Check (Premium vs Discount)
    const dealingRange = execAnalysis.dealingRange;
    let inCorrectZone = true;
    if (dealingRange) {
      if (candidateDir === Direction.BULLISH && currentPrice > dealingRange.equilibrium * 1.01) {
        inCorrectZone = false; // Buying at range highs is low probability
      } else if (
        candidateDir === Direction.BEARISH &&
        currentPrice < dealingRange.equilibrium * 0.99
      ) {
        inCorrectZone = false; // Selling at range lows is low probability
      }
    }

    // High-Accuracy Filter 3: Indicator Momentum & Trend Alignment
    const closes = execCandles.map((c) => c.close);
    const ema20 = calculateEMA(closes, 20);
    const rsi14 = calculateRSI(closes, 14);
    const lastEma20 = ema20[closes.length - 1] ?? currentPrice;
    const lastRsi = rsi14[closes.length - 1] ?? 50;

    let indicatorsAligned = false;
    if (
      candidateDir === Direction.BULLISH &&
      currentPrice >= lastEma20 &&
      lastRsi >= 42 &&
      lastRsi <= 72
    ) {
      indicatorsAligned = true;
    } else if (
      candidateDir === Direction.BEARISH &&
      currentPrice <= lastEma20 &&
      lastRsi <= 58 &&
      lastRsi >= 28
    ) {
      indicatorsAligned = true;
    }

    // High-Accuracy Filter 4: Relative Volume (RVOL >= 1.25x) & Candle Displacement Body
    const lastVol = lastCandle.volume;
    let avgVol = 0;
    const lookbackVol = Math.min(20, execCandles.length - 1);
    for (let v = execCandles.length - 1 - lookbackVol; v < execCandles.length - 1; v++) {
      avgVol += execCandles[v].volume;
    }
    avgVol = lookbackVol > 0 ? avgVol / lookbackVol : lastVol;
    const rvol = avgVol > 0 ? lastVol / avgVol : 1.0;
    const candleRange = Math.max(0.0001, lastCandle.high - lastCandle.low);
    const candleBody = Math.abs(lastCandle.close - lastCandle.open);
    const bodyRatio = candleBody / candleRange;
    const hasVolumeExpansion = rvol >= 1.2 || bodyRatio >= 0.55;

    // 7. Calculate Trade Levels (Optimal Entry, Stop Loss, Target 1, Target 2, Target 3)
    const anchorSwings =
      candidateDir === Direction.BULLISH
        ? execAnalysis.confirmedSwingLows
        : execAnalysis.confirmedSwingHighs;
    const anchorSwing = anchorSwings.slice(-1)[0] || null;

    const levels = TradeLevelsCalculator.calculateLevels(
      candidateDir,
      execCandles,
      anchorSwing,
      activeOB,
      activeFVG,
    );

    if (!levels) {
      return SignalGenerator.createNoTradeSignal(
        symbol,
        executionTf,
        'Unable to compute valid risk-reward invalidation geometry',
        decisionTimestamp,
      );
    }

    // 8. Institutional Confluence Scoring
    const scoringInputs: IScoringInputs = {
      direction: candidateDir,
      htfAligned: mtf.isAligned,
      htfAlignmentScore: mtf.alignmentScore,
      hasLiquiditySweep: hasSweep,
      hasBOSOrCHOCH: hasStructureBreak,
      hasOBOrFVG: activeFVG !== null || activeOB !== null,
      displacementRatio: activeFVG ? 1.5 : hasStructureBreak ? 1.2 : 0.9,
      inCorrectZone,
      hasVolumeExpansion,
      riskRewardRatio: levels.riskRewardRatios.rr2,
      indicatorsAligned,
    };

    const customWeights = options.scoringWeights || options.strategyConfig?.scoringWeights;
    let { totalScore, grade, breakdown } = SignalScorer.calculateScore(scoringInputs, customWeights);

    // 9. Generate Trigger Description & Detailed Reasoning
    let triggerDesc = 'Micro-structure confirmation and price action trigger';
    const explicitReasons: string[] = [];

    if (mtf.isAligned) {
      explicitReasons.push(`HTF_${candidateDir}_ALIGNED`);
    }
    if (hasSweep) {
      explicitReasons.push(
        candidateDir === Direction.BULLISH ? 'SELL_SIDE_LIQUIDITY_SWEPT' : 'BUY_SIDE_LIQUIDITY_SWEPT',
      );
    }
    if (hasStructureBreak) {
      explicitReasons.push(
        recentCHOCH.length > 0 ? `${candidateDir}_CHOCH_CONFIRMED` : `${candidateDir}_BOS_CONFIRMED`,
      );
    }
    if (activeFVG) {
      explicitReasons.push(`${candidateDir}_FVG_MITIGATION`);
      triggerDesc = `Mitigation tap into active ${candidateDir} Fair Value Gap [${activeFVG.lowerBound.toFixed(2)} - ${activeFVG.upperBound.toFixed(2)}]`;
    } else if (activeOB) {
      explicitReasons.push(`${candidateDir}_ORDER_BLOCK_TAP`);
      triggerDesc = `Institutional ${candidateDir} Order Block tap [${activeOB.low.toFixed(2)} - ${activeOB.high.toFixed(2)}]`;
    } else if (hasStructureBreak) {
      triggerDesc = `Fresh ${candidateDir} structural breakout / CHoCH expansion with ${rvol.toFixed(1)}x RVOL volume`;
    }
    if (inCorrectZone) {
      explicitReasons.push(candidateDir === Direction.BULLISH ? 'DISCOUNT_ZONE' : 'PREMIUM_ZONE');
    }
    if (hasVolumeExpansion) {
      explicitReasons.push('VOLUME_EXPANSION');
    }

    const reasoning = ReasoningGenerator.generateReasoning({
      symbol,
      timeframe: executionTf as string,
      direction: candidateDir,
      grade,
      totalScore,
      mtf,
      scoring: scoringInputs,
      levels,
      triggerDescription: triggerDesc,
    });

    // 10. Hybrid Strategy Confluence Check
    if (strategyMode === 'HYBRID') {
      const saiyanAnalysis = SaiyanOCCEngine.analyze(execCandles);
      if (
        saiyanAnalysis.direction !== candidateDir &&
        saiyanAnalysis.direction !== Direction.NEUTRAL
      ) {
        return SignalGenerator.createNoTradeSignal(
          symbol,
          executionTf,
          `Hybrid Filter: SMC ${candidateDir} bias conflicts with Saiyan OCC ${saiyanAnalysis.direction} momentum`,
          decisionTimestamp,
        );
      }
      reasoning.confirmedChecklist.push(
        `🛡️ Hybrid Confluence: SMC ${candidateDir} confirmed by Saiyan ALMA OCC Momentum Crossover`,
      );
      totalScore = Math.min(100, totalScore + 5);
      if (totalScore >= 90) grade = SignalGrade.A_PLUS;
    }

    // 11. ICT Session Killzone Filter Enrichment
    const session = SessionFilter.getSessionInfo(decisionTimestamp, symbol);
    if (session.isKillZone) {
      reasoning.confirmedChecklist.push(`ICT Killzone: ${session.badge} (${session.timeRange})`);
    } else if (session.activeSession === 'NSE_LUNCH_CHOP') {
      reasoning.confirmedChecklist.push(`⚠️ Midday Chop Session: Exercise lower position sizing`);
    }

    // Candidate Strategy Constraint: Enforce candidate minMtfScore if configured
    const configMinScore =
      options.strategyConfig?.minMtfScore ??
      options.strategyConfig?.minScore;
    if (typeof configMinScore === 'number' && Number.isFinite(configMinScore)) {
      if (totalScore < configMinScore) {
        return SignalGenerator.createNoTradeSignal(
          symbol,
          executionTf,
          `Signal score (${totalScore}) below configured candidate minMtfScore (${configMinScore})`,
          decisionTimestamp,
        );
      }
    }

    const finalDirection = grade === SignalGrade.NO_TRADE ? Direction.NEUTRAL : candidateDir;
    const triggerTag = hasSweep
      ? 'SWEEP'
      : activeOB
        ? 'OB'
        : activeFVG
          ? 'FVG'
          : hasStructureBreak
            ? 'BOS'
            : 'MOMENTUM';

    // Build Canonical Point-In-Time Market Snapshot & Quant Intelligence State
    const snapshot = SnapshotBuilder.buildSnapshot({
      symbol,
      executionCandles: execCandles,
      executionTimeframe: executionTf,
      htf1Candles,
      htf2Candles,
      asOfTimestamp: decisionTimestamp,
    });

    return {
      id: `smc_${symbol}_${executionTf}_${finalDirection}_${triggerTag}_${decisionTimestamp.getTime()}`,
      symbol,
      direction: finalDirection,
      score: totalScore,
      grade,
      scoreBreakdown: breakdown,
      timeframe: executionTf as Timeframe,
      htfBias: mtf.htfBias,
      entryZone: levels.entryZone,
      stopLoss: levels.stopLoss,
      takeProfits: levels.takeProfits,
      riskRewardRatios: levels.riskRewardRatios,
      reasoning,
      reasons: explicitReasons,
      state: SignalState.PENDING,
      timestamp: decisionTimestamp,
      quantSnapshot: snapshot,
      quantScore: snapshot.score,
      regime: snapshot.regime.regime,
      volatilityPercentile: snapshot.volatility.volatilityPercentile,
      forecastVolatility: snapshot.volatility.forecastVolatility,
      mlProbability: snapshot.ml?.probabilityWin ?? undefined,
      expectedR: snapshot.ml?.expectedR ?? undefined,
      decisionTrace: snapshot.trace,
    };
  }

  private static createNoTradeSignal(
    symbol: string,
    timeframe: Timeframe | string,
    reason: string,
    timestamp: Date = new Date(),
  ): ISignalSetup {
    return {
      symbol,
      direction: Direction.NEUTRAL,
      score: 0,
      grade: SignalGrade.NO_TRADE,
      scoreBreakdown: {
        htfBias: 0,
        liquiditySweep: 0,
        bos: 0,
        fvg: 0,
        orderBlock: 0,
        displacement: 0,
        premiumDiscount: 0,
        volumeConfirmation: 0,
        riskReward: 0,
        indicatorAlignment: 0,
        totalScore: 0,
        grade: SignalGrade.NO_TRADE,
      },
      timeframe: timeframe as Timeframe,
      htfBias: Direction.NEUTRAL,
      entryZone: { min: 0, max: 0, optimal: 0 },
      stopLoss: 0,
      takeProfits: { tp1: 0, tp2: 0, tp3: 0 },
      riskRewardRatios: { rr1: 0, rr2: 0, rr3: 0 },
      reasoning: {
        htfStructure: reason,
        liquidityReason: 'N/A',
        triggerReason: 'N/A',
        invalidationReason: 'N/A',
        confirmedChecklist: [],
        summary: `Setup Score: 0/100 (NO_TRADE). ${reason}`,
      },
      reasons: ['NO_VALID_SETUP'],
      state: SignalState.CANCELLED,
      timestamp,
    };
  }
}

