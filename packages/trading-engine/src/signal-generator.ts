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
import { ICanonicalMarketSnapshot } from './canonical-market-snapshot';
import { CandleNormalizer } from './candle-normalizer';

export interface IGenerateFromSnapshotsOptions {
  executionSnapshot: ICanonicalMarketSnapshot;
  htf1Snapshot?: ICanonicalMarketSnapshot;
  htf2Snapshot?: ICanonicalMarketSnapshot;
  mtfMode?: MTFMode;
  strategyMode?: 'SMC' | 'SAIYAN_OCC' | 'HYBRID';
  scoringWeights?: IScoringWeights;
  strategyConfig?: Record<string, any>;
  minimumCandles?: number;
}

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
   * Authoritative Canonical Production Entry Point: Generates signal setup directly from CanonicalMarketSnapshots.
   * STRICT FAIL-CLOSED:
   * - Enforces snapshot decision boundary as the authoritative point-in-time reference
   * - Validates symbol consistency across all snapshots
   * - Rejects HTF snapshots if closedThroughTimestamp > executionSnapshot.decisionTimestamp
   * - Never reads future or forming candles
   */
  static generateFromSnapshots(options: IGenerateFromSnapshotsOptions): ISignalSetup {
    if (!options || !options.executionSnapshot) {
      throw new Error('INVALID_SNAPSHOT: executionSnapshot is required for canonical signal generation');
    }

    const execSnap = options.executionSnapshot;
    const symbol = execSnap.symbol.toUpperCase();
    const decisionTimestamp = execSnap.decisionTimestamp;
    const decisionTimeMs = decisionTimestamp.getTime();

    // 1. Symbol Parity Validation
    if (options.htf1Snapshot && options.htf1Snapshot.symbol.toUpperCase() !== symbol) {
      throw new Error(
        `SNAPSHOT_SYMBOL_MISMATCH: HTF1 symbol '${options.htf1Snapshot.symbol}' does not match execution symbol '${symbol}'`,
      );
    }
    if (options.htf2Snapshot && options.htf2Snapshot.symbol.toUpperCase() !== symbol) {
      throw new Error(
        `SNAPSHOT_SYMBOL_MISMATCH: HTF2 symbol '${options.htf2Snapshot.symbol}' does not match execution symbol '${symbol}'`,
      );
    }

    // 2. Strict Point-in-Time HTF Alignment Invariants (Lookahead Rejection)
    if (options.htf1Snapshot) {
      const htf1ClosedMs = options.htf1Snapshot.closedThroughTimestamp.getTime();
      if (htf1ClosedMs > decisionTimeMs) {
        throw new Error(
          `HTF_LOOKAHEAD_VIOLATION: HTF1 closedThroughTimestamp (${options.htf1Snapshot.closedThroughTimestamp.toISOString()}) exceeds execution decision boundary (${decisionTimestamp.toISOString()})`,
        );
      }
    }

    if (options.htf2Snapshot) {
      const htf2ClosedMs = options.htf2Snapshot.closedThroughTimestamp.getTime();
      if (htf2ClosedMs > decisionTimeMs) {
        throw new Error(
          `HTF_LOOKAHEAD_VIOLATION: HTF2 closedThroughTimestamp (${options.htf2Snapshot.closedThroughTimestamp.toISOString()}) exceeds execution decision boundary (${decisionTimestamp.toISOString()})`,
        );
      }
    }

    // 3. Fail-Closed Invariant: Both HTF1 (H1) and HTF2 (H4) Confirmations are Required for Production Signal Generation
    const missingHtfs: string[] = [];
    if (!options.htf1Snapshot || !options.htf1Snapshot.candles || options.htf1Snapshot.candles.length === 0) {
      missingHtfs.push('H1');
    }
    if (!options.htf2Snapshot || !options.htf2Snapshot.candles || options.htf2Snapshot.candles.length === 0) {
      missingHtfs.push('H4');
    }

    if (missingHtfs.length > 0) {
      const execCandles = execSnap.candles as ICandle[];
      const lastCandle = execCandles && execCandles.length > 0 ? execCandles[execCandles.length - 1] : null;
      const currentPrice = lastCandle ? lastCandle.close : 0;

      return {
        id: `sig_${symbol}_${execSnap.executionTimeframe}_${decisionTimeMs}`,
        symbol,
        timeframe: execSnap.executionTimeframe as any,
        direction: Direction.NEUTRAL,
        state: SignalState.INVALIDATED,
        grade: SignalGrade.NO_TRADE,
        score: 0,
        canonicalCandleTime: decisionTimeMs,
        canonicalDecisionTime: decisionTimestamp,
        timestamp: decisionTimestamp,
        entryZone: { min: currentPrice, max: currentPrice, optimal: currentPrice },
        stopLoss: currentPrice,
        takeProfits: { tp1: currentPrice, tp2: currentPrice, tp3: currentPrice },
        riskRewardRatios: { rr1: 0, rr2: 0, rr3: 0 },
        reasoning: {
          htfStructure: `NO_TRADE: Required Higher Timeframe (${missingHtfs.join(', ')}) snapshot was unavailable or empty`,
          execStructure: 'NO_TRADE: Missing HTF alignment context',
          orderBlock: 'None',
          fvg: 'None',
          liquidity: 'None',
          confluenceSummary: `Fail-closed: Missing HTF (${missingHtfs.join(', ')}) market snapshot`,
        } as any,
        reasons: [`HTF_DATA_UNAVAILABLE: Required ${missingHtfs.join(', ')} market data was unavailable or empty`],
        scoreBreakdown: {
          htfTrend: 0,
          structureBreak: 0,
          liquiditySweep: 0,
          fvg: 0,
          orderBlock: 0,
          rsiAlignment: 0,
          volumeDisplacement: 0,
          riskRewardRatio: 0,
        } as any,
        triggerEvidence: {},
      };
    }

    // 3. Delegate to canonical execution using confirmed immutable snapshot candles
    return SignalGenerator.generateSignal({
      symbol,
      executionCandles: execSnap.candles as ICandle[],
      executionTimeframe: execSnap.executionTimeframe,
      htf1Candles: options.htf1Snapshot ? (options.htf1Snapshot.candles as ICandle[]) : undefined,
      htf1Timeframe: options.htf1Snapshot ? options.htf1Snapshot.executionTimeframe : undefined,
      htf2Candles: options.htf2Snapshot ? (options.htf2Snapshot.candles as ICandle[]) : undefined,
      htf2Timeframe: options.htf2Snapshot ? options.htf2Snapshot.executionTimeframe : undefined,
      mtfMode: options.mtfMode,
      strategyMode: options.strategyMode,
      asOfTimestamp: decisionTimestamp,
      scoringWeights: options.scoringWeights,
      strategyConfig: options.strategyConfig,
      minimumCandles: options.minimumCandles,
    });
  }

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
      const isProduction =
        process.env.NODE_ENV === 'production' ||
        process.env.APP_ENV === 'production';
      if (isProduction) {
        throw new Error(
          'DETERMINISTIC_SIGNAL_INJECTION_PROHIBITED: Deterministic test signal injection is strictly prohibited in production mode',
        );
      }
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
        const rr1 = det.riskRewardRatios?.rr1 ?? (det.rr1 ?? 2.0);
        const rr2 = det.riskRewardRatios?.rr2 ?? (det.rr2 ?? 3.5);
        const rr3 = det.riskRewardRatios?.rr3 ?? (det.rr3 ?? 6.0);
        const maxPotentialR = det.maxPotentialR ?? rr3;

        const target1 =
          det.takeProfits?.tp1 ??
          det.tp1 ??
          (det.direction === Direction.BEARISH
            ? entryPrice - baseStopDist * rr1
            : entryPrice + baseStopDist * rr1);
        const target2 =
          det.takeProfits?.tp2 ??
          det.tp2 ??
          (det.direction === Direction.BEARISH
            ? entryPrice - baseStopDist * rr2
            : entryPrice + baseStopDist * rr2);
        const target3 =
          det.takeProfits?.tp3 ??
          det.tp3 ??
          (det.direction === Direction.BEARISH
            ? entryPrice - baseStopDist * rr3
            : entryPrice + baseStopDist * rr3);

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
          entry: entryPrice,
          stopLoss: baseStopPrice,
          takeProfits: {
            tp1: target1,
            tp2: target2,
            tp3: target3,
          },
          tp1: target1,
          tp2: target2,
          tp3: target3,
          riskRewardRatios: {
            rr1,
            rr2,
            rr3,
          },
          rr1,
          rr2,
          rr3,
          maxPotentialR,
          reasoning: det.reasoning || ({} as any),
          scoreBreakdown: {} as any,
          triggerEvidence: det.triggerEvidence || {
            orderBlock: { matched: true },
            fvg: { matched: true },
            liquiditySweep: { matched: true },
            structureBreak: { matched: true },
          },
          timeframe: String(executionTf),
          reasons: det.reasons ?? ['Candidate deterministic setup'],
          marketContext: det.marketContext,
          features: det.features,
          marketState: det.marketState,
          prediction: det.prediction,
          canonicalCandleTime: det.canonicalCandleTime ?? currTime,
          canonicalDecisionTime: det.canonicalDecisionTime ?? decisionTimestamp,
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

    const triggerEvidence = {
      orderBlock: {
        matched: activeOB !== null,
        id: activeOB?.id,
        direction: activeOB?.direction,
        timestamp: activeOB?.timestamp,
        candleTime: activeOB?.timestamp ? new Date(activeOB.timestamp).getTime() : (activeOB !== null ? decisionTimestamp.getTime() : undefined),
        timeframe: String(executionTf),
        symbol,
        details: activeOB ? `Order Block tap [${activeOB.low.toFixed(2)} - ${activeOB.high.toFixed(2)}]` : undefined,
      },
      fvg: {
        matched: activeFVG !== null,
        id: activeFVG?.id,
        direction: activeFVG?.direction,
        timestamp: activeFVG?.timestamp,
        candleTime: activeFVG?.timestamp ? new Date(activeFVG.timestamp).getTime() : (activeFVG !== null ? decisionTimestamp.getTime() : undefined),
        timeframe: String(executionTf),
        symbol,
        details: activeFVG ? `FVG mitigation [${activeFVG.lowerBound.toFixed(2)} - ${activeFVG.upperBound.toFixed(2)}]` : undefined,
      },
      liquiditySweep: {
        matched: hasSweep,
        timestamp: hasSweep && recentSweeps.length > 0 ? recentSweeps[recentSweeps.length - 1].sweptTimestamp || decisionTimestamp : undefined,
        candleTime: hasSweep && recentSweeps.length > 0 ? (recentSweeps[recentSweeps.length - 1].sweptTimestamp ? new Date(recentSweeps[recentSweeps.length - 1].sweptTimestamp!).getTime() : decisionTimestamp.getTime()) : (hasSweep ? decisionTimestamp.getTime() : undefined),
        timeframe: String(executionTf),
        symbol,
        details: hasSweep ? 'Liquidity pool swept' : undefined,
      },
      structureBreak: {
        matched: hasStructureBreak,
        timestamp: hasStructureBreak ? decisionTimestamp : undefined,
        candleTime: hasStructureBreak ? decisionTimestamp.getTime() : undefined,
        timeframe: String(executionTf),
        symbol,
        details: hasStructureBreak ? 'Structure break / CHoCH' : undefined,
      },
    };

    return {
      id: `smc_${symbol}_${executionTf}_${finalDirection}_${triggerTag}_${decisionTimestamp.getTime()}`,
      symbol,
      direction: finalDirection,
      score: totalScore,
      grade,
      scoreBreakdown: breakdown,
      triggerEvidence,
      timeframe: executionTf as Timeframe,
      htfBias: mtf.htfBias,
      entryZone: levels.entryZone,
      entry: levels.entry,
      stopLoss: levels.stopLoss,
      takeProfits: levels.takeProfits,
      tp1: levels.tp1,
      tp2: levels.tp2,
      tp3: levels.tp3,
      riskRewardRatios: levels.riskRewardRatios,
      rr1: levels.rr1,
      rr2: levels.rr2,
      rr3: levels.rr3,
      maxPotentialR: levels.maxPotentialR,
      reasoning,
      reasons: explicitReasons,
      state: SignalState.ACTIVE,
      timestamp: decisionTimestamp,
      canonicalCandleTime: decisionTimestamp.getTime(),
      canonicalDecisionTime: decisionTimestamp,
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
      entry: 0,
      stopLoss: 0,
      takeProfits: { tp1: 0, tp2: 0, tp3: 0 },
      tp1: 0,
      tp2: 0,
      tp3: 0,
      riskRewardRatios: { rr1: 0, rr2: 0, rr3: 0 },
      rr1: 0,
      rr2: 0,
      rr3: 0,
      maxPotentialR: 0,
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
      canonicalCandleTime: timestamp.getTime(),
      canonicalDecisionTime: timestamp,
    };
  }
}

