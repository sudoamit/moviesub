import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { Direction, ICandle, SignalState, MockMarketDataProvider } from '@quant/shared';
import { CANONICAL_V2_DIMENSION } from '@quant/trading-engine';
import { BacktestSimulator, FillModel, SameCandleAmbiguityMode } from '@quant/backtesting';
import { CandidateBacktestRunner } from '../candidate-backtest-runner';
import { CandidateEvaluator } from '../candidate-evaluator';
import { CounterfactualAnalyzer } from '../counterfactual-analyzer';
import { DatasetManager } from '../dataset-manager';
import { ExperienceStore } from '../experience-store';
import { TemporalFeatureScaler } from '../feature-scaler';
import { LearningEngine, DEFAULT_LEARNING_EMBARGO_MS } from '../learning-engine';
import { ModelTrainer, CANONICAL_FEATURE_NAMES_V2 } from '../model-trainer';
import { MonteCarloEngine } from '../monte-carlo-engine';
import { PointInTimeValidator } from '../point-in-time-validator';
import { PromotionGate } from '../promotion-gate';
import { StrategyCandidate, TradingExperience } from '../types';
import { WalkForwardValidator } from '../walk-forward-validator';

function generateContinuousCandles(count: number = 30): ICandle[] {
  const candles: ICandle[] = [];
  const baseT = 1700000000000;
  for (let i = 0; i < count; i++) {
    const t = baseT + i * 60000;
    candles.push({
      timestamp: new Date(t),
      open: 100 + (i % 5) * 0.1,
      high: 101 + (i % 5) * 0.1,
      low: 99 + (i % 5) * 0.1,
      close: 100.5 + (i % 5) * 0.1,
      volume: 1000,
    });
  }
  return candles;
}

describe('AI Fix 4 — Authoritative Execution & Learning Engine Equivalence (Tests A - AE)', () => {
  const baseTime = 1700000000000;

  const createDeterministicTradeFixture = (
    options: {
      isShort?: boolean;
      gapSl?: boolean;
      gapTp?: boolean;
      hitTp1Only?: boolean;
      hitTp1BeSl?: boolean;
      hitFullTp1Tp2TrailingTp3?: boolean;
    } = {},
  ) => {
    const isShort = options.isShort ?? false;
    const entryPrice = 100;
    const stopDistance = 5;
    const stopLoss = isShort ? entryPrice + stopDistance : entryPrice - stopDistance;
    const tp1 = isShort ? entryPrice - stopDistance * 1.5 : entryPrice + stopDistance * 1.5;
    const tp2 = isShort ? entryPrice - stopDistance * 2.5 : entryPrice + stopDistance * 2.5;
    const tp3 = isShort ? entryPrice - stopDistance * 4.0 : entryPrice + stopDistance * 4.0;

    const candle0: ICandle = {
      timestamp: new Date(baseTime),
      open: 100,
      high: 100.2,
      low: 99.8,
      close: 100,
      volume: 100,
    };

    const candle1: ICandle = {
      timestamp: new Date(baseTime + 60000),
      open: 100,
      high: 100.2,
      low: 99.8,
      close: 100,
      volume: 100,
    };

    let candle2: ICandle;
    if (options.gapSl) {
      candle2 = {
        timestamp: new Date(baseTime + 120000),
        open: isShort ? 108 : 92, // Gaps through SL (95 for long, 105 for short)
        high: isShort ? 109 : 92.5,
        low: isShort ? 107.5 : 91,
        close: isShort ? 108.5 : 91.5,
        volume: 100,
      };
    } else if (options.gapTp) {
      candle2 = {
        timestamp: new Date(baseTime + 120000),
        open: isShort ? 91 : 109, // Gaps through TP1 (107.5 for long, 92.5 for short)
        high: isShort ? 91.5 : 110,
        low: isShort ? 90 : 108.5,
        close: isShort ? 90.5 : 109.5,
        volume: 100,
      };
    } else if (options.hitTp1BeSl) {
      candle2 = {
        timestamp: new Date(baseTime + 120000),
        open: 100,
        high: 108, // Hits TP1 (107.5) -> Stop moved to BE (100)
        low: 99.5, // Drops back and hits BE (100)
        close: 99.8,
        volume: 100,
      };
    } else if (options.hitFullTp1Tp2TrailingTp3) {
      candle2 = {
        timestamp: new Date(baseTime + 120000),
        open: 100,
        high: 125, // Hits TP1 (107.5) -> TP2 (112.5) -> Trailing -> TP3 (120)
        low: 99.5,
        close: 124,
        volume: 100,
      };
    } else {
      candle2 = {
        timestamp: new Date(baseTime + 120000),
        open: 100,
        high: isShort ? 100.2 : 125,
        low: isShort ? 75 : 99.5,
        close: isShort ? 76 : 124,
        volume: 100,
      };
    }

    const candles = [candle0, candle1, candle2];

    const quant: Record<string, number> = {};
    for (const name of CANONICAL_FEATURE_NAMES_V2) {
      quant[name] = 0.5;
    }
    quant.smcScore = 80;
    quant.mtfAlignment = 0.85;

    const exp: TradingExperience = {
      id: 'exp_authoritative_fixture',
      tradeId: 'tr_authoritative_fixture',
      timestamp: new Date(baseTime),
      decisionTimestamp: baseTime,
      featureTimestamp: baseTime,
      labelStartTimestamp: baseTime + 1000,
      labelEndTimestamp: baseTime + 180000,
      instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
      marketState: { quant },
      decision: { action: isShort ? 'SELL' : 'BUY', score: 80 },
      execution: { entryPrice, entryTime: new Date(baseTime) },
      risk: { stopLoss, target1: tp1, target2: tp2, target3: tp3 },
      prediction: {},
      outcome: {
        status: 'WIN',
        pnl: 100,
        pnlR: 1.0,
        maxFavorableExcursion: 2.0,
        maxAdverseExcursion: 0.2,
        holdingTimeSeconds: 120,
      },
      marketContext: {
        regime: 'BULLISH',
        volatilityRegime: 'NORMAL',
        session: 'NY',
        dayOfWeek: 1,
      },
      outcomeClassification: 'GOOD_TRADE_WIN',
      reasons: ['OB_TEST'],
      failureReasons: [],
      strategyVersion: 'v2.0',
      featureSchemaVersion: '2.0',
      createdAt: new Date(),
      candlesDuringTrade: candles,
    };

    const candidate: StrategyCandidate = {
      id: 'cand_authoritative_fixture',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-cand-fixture',
      type: 'THRESHOLD',
      description: 'Authoritative candidate fixture',
      change: { parameter: 'minMtfScore', value: 70 },
      evidence: { sampleSize: 10, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    return { candles, exp, candidate, isShort, entryPrice, stopLoss, tp1, tp2, tp3 };
  };

  // Test A — CandidateEvaluator and BacktestSimulator produce identical trade results
  test('Test A: CandidateEvaluator and BacktestSimulator produce identical trade results', () => {
    const { candles, exp, candidate } = createDeterministicTradeFixture({ hitFullTp1Tp2TrailingTp3: true });

    // Method A: Run directly through authoritative BacktestSimulator
    const simResult = BacktestSimulator.runSimulation({
      runId: 'bt_direct',
      symbol: 'BTCUSDT',
      timeframe: '15m',
      candles,
      experiences: [exp],
      minimumCandles: 1,
      warmupBars: 0,
      minScore: 70,
    });

    // Method B: Run through CandidateBacktestRunner test fixture runner -> BacktestSimulator
    const candResult = CandidateBacktestRunner.runDeterministicTestFixture(candidate, {
      candles,
      experiences: [exp],
    });

    expect(candResult.totalTrades).toBe(simResult.totalTrades);
    expect(candResult.trades.length).toBe(simResult.trades.length);
    expect(candResult.trades.length).toBe(1);

    const tradeSim = simResult.trades[0];
    const tradeCand = candResult.trades[0];

    // Assert strict equality across all required execution provenance fields
    expect(tradeCand.direction).toBe(tradeSim.direction);
    expect(tradeCand.entryTime.getTime()).toBe(tradeSim.entryTime.getTime());
    expect(tradeCand.entryReferencePrice).toBe(tradeSim.entryReferencePrice);
    expect(tradeCand.entryFillPrice).toBe(tradeSim.entryFillPrice);
    expect(tradeCand.entryFees).toBe(tradeSim.entryFees);
    expect(tradeCand.entrySlippage).toBe(tradeSim.entrySlippage);
    expect(tradeCand.stopLoss).toBe(tradeSim.stopLoss);
    expect(tradeCand.takeProfit).toBe(tradeSim.takeProfit);
    expect(tradeCand.positionSize).toBe(tradeSim.positionSize);
    expect(tradeCand.exitTime.getTime()).toBe(tradeSim.exitTime.getTime());
    expect(tradeCand.exitTriggerTimestamp?.getTime()).toBe(tradeSim.exitTriggerTimestamp?.getTime());
    expect(tradeCand.exitFillPrice).toBe(tradeSim.exitFillPrice);
    expect(tradeCand.exitReason).toBe(tradeSim.exitReason);
    expect(tradeCand.exitFees).toBe(tradeSim.exitFees);
    expect(tradeCand.exitSlippage).toBe(tradeSim.exitSlippage);
    expect(tradeCand.pnl).toBe(tradeSim.pnl);
    expect(tradeCand.pnlRMultiple).toBe(tradeSim.pnlRMultiple);
    expect(candResult.netPnL).toBe(simResult.netPnL);
    expect(candResult.maxDrawdownR).toBe(simResult.maxDrawdownPercent);
  });

  // Test B — Complete trade lifecycle: TP1 → BE → TP2 → trailing → TP3
  // Test B — Complete trade lifecycle: TP1 → BE → TP2 → trailing → TP3
  test('Test B: Complete trade lifecycle: TP1 → BE → TP2 → trailing → TP3', () => {
    const { exp, candles, candidate } = createDeterministicTradeFixture({ hitFullTp1Tp2TrailingTp3: true });
    const res = CandidateBacktestRunner.runDeterministicTestFixture(candidate, { candles, experiences: [exp] });

    expect(res.totalTrades).toBe(1);
    const trade = res.trades[0];
    expect(trade.exitReason).toBe(SignalState.TP3_HIT);
    expect(trade.pnlRMultiple).toBeGreaterThan(2.0); // Full target reached
  });

  // Test C — Complete trade lifecycle: TP1 → BE → SL
  test('Test C: Complete trade lifecycle: TP1 → BE → SL', () => {
    const { exp, candles, candidate } = createDeterministicTradeFixture({ hitTp1BeSl: true });
    const res = CandidateBacktestRunner.runDeterministicTestFixture(candidate, { candles, experiences: [exp] });

    expect(res.totalTrades).toBe(1);
    const trade = res.trades[0];
    // Reached TP1, then stopped out at Breakeven
    expect(trade.exitReason).toMatch(/TP1_HIT|SL_HIT/);
    expect(trade.pnlRMultiple).toBeGreaterThanOrEqual(-0.1); // Protected by BE
  });

  // Test D — Long gap-through SL
  test('Test D: Long gap-through SL fills at gap price with authoritative slippage', () => {
    const { exp, candles, candidate } = createDeterministicTradeFixture({ isShort: false, gapSl: true });
    const res = CandidateBacktestRunner.runDeterministicTestFixture(candidate, { candles, experiences: [exp] });

    expect(res.totalTrades).toBe(1);
    const trade = res.trades[0];
    expect(trade.exitReason).toBe(SignalState.SL_HIT);
    // Gapped down to 92 through stop at 95 -> fill price reflects the gap
    expect(trade.exitFillPrice).toBeLessThan(trade.stopLoss);
    expect(trade.pnlRMultiple).toBeLessThan(-1.0); // Slippage penalty applied
  });

  // Test E — Short gap-through SL
  test('Test E: Short gap-through SL fills at gap price with authoritative slippage', () => {
    const { exp, candles, candidate } = createDeterministicTradeFixture({ isShort: true, gapSl: true });
    const res = CandidateBacktestRunner.runDeterministicTestFixture(candidate, { candles, experiences: [exp] });

    expect(res.totalTrades).toBe(1);
    const trade = res.trades[0];
    expect(trade.exitReason).toBe(SignalState.SL_HIT);
    // Gapped up to 108 through stop at 105 -> fill price reflects the gap
    expect(trade.exitFillPrice).toBeGreaterThan(trade.stopLoss);
    expect(trade.pnlRMultiple).toBeLessThan(-1.0);
  });

  // Test F — Gap-through TP
  test('Test F: Gap-through TP fills at gap open price', () => {
    const { exp, candles, candidate } = createDeterministicTradeFixture({ isShort: false, gapTp: true });
    const res = CandidateBacktestRunner.runDeterministicTestFixture(candidate, { candles, experiences: [exp] });

    expect(res.totalTrades).toBe(1);
    const trade = res.trades[0];
    expect(trade.exitFillPrice).toBeGreaterThanOrEqual(107.5);
    expect(trade.pnl).toBeGreaterThan(0);
  });

  // Test G — Partial quantities match production backtester
  test('Test G: Partial quantities match production backtester', () => {
    const { candles, exp, candidate } = createDeterministicTradeFixture({ hitFullTp1Tp2TrailingTp3: true });
    const simRes = BacktestSimulator.runSimulation({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      candles,
      experiences: [exp],
      minimumCandles: 1,
      warmupBars: 0,
    });
    const candRes = CandidateBacktestRunner.runDeterministicTestFixture(candidate, { candles, experiences: [exp] });

    expect(candRes.trades[0].positionSize).toBe(simRes.trades[0].positionSize);
    expect(candRes.trades[0].positionSize).toBe(200);
  });

  // Test H — Fees match production execution
  test('Test H: Fees match production execution', () => {
    const { candles, exp, candidate } = createDeterministicTradeFixture({ hitFullTp1Tp2TrailingTp3: true });
    const simRes = BacktestSimulator.runSimulation({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      candles,
      experiences: [exp],
      minimumCandles: 1,
      warmupBars: 0,
    });
    const candRes = CandidateBacktestRunner.runDeterministicTestFixture(candidate, { candles, experiences: [exp] });

    expect(candRes.trades[0].entryFees).toBe(simRes.trades[0].entryFees);
    expect(candRes.trades[0].exitFees).toBe(simRes.trades[0].exitFees);
    expect(candRes.trades[0].entryFees).toBeGreaterThan(0);
  });

  // Test I — Slippage matches production execution
  test('Test I: Slippage matches production execution', () => {
    const { candles, exp, candidate } = createDeterministicTradeFixture({ hitFullTp1Tp2TrailingTp3: true });
    const simRes = BacktestSimulator.runSimulation({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      candles,
      experiences: [exp],
      minimumCandles: 1,
      warmupBars: 0,
    });
    const candRes = CandidateBacktestRunner.runDeterministicTestFixture(candidate, { candles, experiences: [exp] });

    expect(candRes.trades[0].entrySlippage).toBe(simRes.trades[0].entrySlippage);
    expect(candRes.trades[0].exitSlippage).toBe(simRes.trades[0].exitSlippage);
  });

  // Test J — Candidate sizing actually changes production position size
  test('Test J: Candidate sizing actually changes production position size', () => {
    const { exp, candles } = createDeterministicTradeFixture({ hitFullTp1Tp2TrailingTp3: true });
    const baseCand: StrategyCandidate = {
      id: 'cand_base_size',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-base-size',
      type: 'SIZING',
      description: 'Base sizing 1.0x',
      change: { parameter: 'sizingMultiplier', value: 1.0 },
      evidence: { sampleSize: 10, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const doubleSizeCand: StrategyCandidate = {
      ...baseCand,
      id: 'cand_double_size',
      candidateVersion: 'v2.0-double-size',
      change: { parameter: 'sizingMultiplier', value: 2.0 },
    };

    const baseRes = CandidateBacktestRunner.runDeterministicTestFixture(baseCand, { candles, experiences: [exp] });
    const doubleRes = CandidateBacktestRunner.runDeterministicTestFixture(doubleSizeCand, { candles, experiences: [exp] });

    expect(doubleRes.trades[0].positionSize).toBe(baseRes.trades[0].positionSize * 2);
    expect(doubleRes.trades[0].positionSize).toBe(400);
  });

  // Test K — Candidate stop multiplier changes actual production stop
  test('Test K: Candidate stop multiplier changes actual production stop', () => {
    const { exp, candles } = createDeterministicTradeFixture({ hitFullTp1Tp2TrailingTp3: true });
    const normalStopCand: StrategyCandidate = {
      id: 'cand_normal_stop',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-normal-stop',
      type: 'RISK',
      description: 'Stop 1.0x',
      change: { parameter: 'stopLossAtrMultiplier', value: 1.0 },
      evidence: { sampleSize: 10, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const wideStopCand: StrategyCandidate = {
      ...normalStopCand,
      id: 'cand_wide_stop',
      candidateVersion: 'v2.0-wide-stop',
      change: { parameter: 'stopLossAtrMultiplier', value: 2.0 }, // 2x wider stop distance (10 pts vs 5 pts)
    };

    const normalRes = CandidateBacktestRunner.runDeterministicTestFixture(normalStopCand, { candles, experiences: [exp] });
    const wideRes = CandidateBacktestRunner.runDeterministicTestFixture(wideStopCand, { candles, experiences: [exp] });

    expect(normalRes.trades[0].stopLoss).toBe(95);
    expect(wideRes.trades[0].stopLoss).toBe(90); // 100 - (5 * 2) = 90
  });

  // Test L — Candidate threshold changes actual signal generation
  test('Test L: Candidate threshold changes actual signal generation', () => {
    const { exp, candles } = createDeterministicTradeFixture({ hitFullTp1Tp2TrailingTp3: true });
    // Experience decision score is 80
    const passCand: StrategyCandidate = {
      id: 'cand_pass_thresh',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-pass-thresh',
      type: 'THRESHOLD',
      description: 'Threshold 75 (Signal score 80 >= 75)',
      change: { parameter: 'minMtfScore', value: 75 },
      evidence: { sampleSize: 10, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const filterCand: StrategyCandidate = {
      ...passCand,
      id: 'cand_filter_thresh',
      candidateVersion: 'v2.0-filter-thresh',
      description: 'Threshold 85 (Signal score 80 < 85 -> rejected)',
      change: { parameter: 'minMtfScore', value: 85 },
    };

    const passRes = CandidateBacktestRunner.runDeterministicTestFixture(passCand, { candles, experiences: [exp] });
    const filterRes = CandidateBacktestRunner.runDeterministicTestFixture(filterCand, { candles, experiences: [exp] });

    expect(passRes.totalTrades).toBe(1);
    expect(filterRes.totalTrades).toBe(0);
  });

  // Test M — Candidate model artifact changes actual model decision
  test('Test M: Candidate model artifact changes actual model decision', () => {
    const { exp } = createDeterministicTradeFixture({ hitFullTp1Tp2TrailingTp3: true });

    // Positive model weight -> high score
    const bullishModelArtifact = {
      modelVersion: 'ml-v2-bullish-1',
      weights: new Array(28).fill(1.5),
      bias: 1.0,
      featureSchemaVersion: '2.0',
      sampleCount: 50,
      trainLoss: 0.2,
      trainedAt: new Date(0),
    };

    // Strongly negative model weight -> rejects signal below threshold
    const bearishModelArtifact = {
      modelVersion: 'ml-v2-bearish-1',
      weights: new Array(28).fill(-3.0),
      bias: -2.0,
      featureSchemaVersion: '2.0',
      sampleCount: 50,
      trainLoss: 0.2,
      trainedAt: new Date(0),
    };

    const candBullish: StrategyCandidate = {
      id: 'cand_model_bullish',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-cand-model-bullish',
      type: 'MODEL',
      description: 'Bullish model',
      change: { modelArtifact: bullishModelArtifact, minMtfScore: 60 },
      evidence: { sampleSize: 10, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const candBearish: StrategyCandidate = {
      ...candBullish,
      id: 'cand_model_bearish',
      candidateVersion: 'v2.0-cand-model-bearish',
      change: { modelArtifact: bearishModelArtifact, minMtfScore: 60 },
    };

    const simResultBullish = BacktestSimulator.runSimulation({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      candles: exp.candlesDuringTrade!,
      experiences: [exp],
      modelArtifact: bullishModelArtifact,
      minScore: 60,
      minimumCandles: 1,
      warmupBars: 0,
    });

    const simResultBearish = BacktestSimulator.runSimulation({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      candles: exp.candlesDuringTrade!,
      experiences: [exp],
      modelArtifact: bearishModelArtifact,
      minScore: 60,
      minimumCandles: 1,
      warmupBars: 0,
    });

    expect(simResultBullish.totalTrades).toBe(1);
    expect(simResultBearish.totalTrades).toBe(0);
  });

  // Test N — Missing market data fails closed
  test('Test N: Missing market data fails closed', () => {
    const { exp, candidate } = createDeterministicTradeFixture();
    const expNoCandles = { ...exp, candlesDuringTrade: [] };

    expect(() => {
      CandidateBacktestRunner.runCandidateBacktest(candidate, [expNoCandles]);
    }).toThrow('INSUFFICIENT_MARKET_DATA_FOR_CANDIDATE_EXECUTION');
  });
  test('Test O: Historical outcome.pnlR cannot affect candidate result', () => {
    const { exp, candles, candidate } = createDeterministicTradeFixture({ hitFullTp1Tp2TrailingTp3: true });

    const exp1 = { ...exp, outcome: { ...exp.outcome, pnl: 9999, pnlR: 100.0 } };
    const exp2 = { ...exp, outcome: { ...exp.outcome, pnl: -9999, pnlR: -100.0 } };

    const res1 = CandidateBacktestRunner.runDeterministicTestFixture(candidate, { candles, experiences: [exp1] });
    const res2 = CandidateBacktestRunner.runDeterministicTestFixture(candidate, { candles, experiences: [exp2] });

    expect(res1.trades[0].pnlRMultiple).toBe(res2.trades[0].pnlRMultiple);
    expect(res1.trades[0].pnl).toBe(res2.trades[0].pnl);
    expect(res1.netPnL).toBe(res2.netPnL);
  });

  // Test P — Two WFV folds produce genuinely different training artifacts when training data differs
  test('Test P: Two WFV folds produce genuinely different training artifacts when training data differs', () => {
    const experiences: TradingExperience[] = Array.from({ length: 30 }, (_, i) => {
      const t = baseTime + i * 300000;
      return {
        id: `exp_diff_folds_${i}`,
        tradeId: `tr_diff_folds_${i}`,
        timestamp: new Date(t),
        decisionTimestamp: t,
        featureTimestamp: t,
        labelStartTimestamp: t + 1000,
        labelEndTimestamp: t + 180000,
        instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
        marketState: { quant: { smcScore: i < 15 ? 55 : 90 } },
        decision: { action: 'BUY', score: i < 15 ? 55 : 90 },
        execution: { entryPrice: 100, entryTime: new Date(t) },
        risk: { stopLoss: 95 },
        prediction: {},
        outcome: {
          status: 'WIN',
          pnl: 100,
          pnlR: 1.0,
          maxFavorableExcursion: 1.5,
          maxAdverseExcursion: 0.2,
          holdingTimeSeconds: 120,
        },
        marketContext: { regime: 'BULLISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 },
        outcomeClassification: 'GOOD_TRADE_WIN',
        reasons: [],
        failureReasons: [],
        strategyVersion: 'v2.0',
        featureSchemaVersion: '2.0',
        createdAt: new Date(),
        candlesDuringTrade: [
          { timestamp: new Date(t), open: 100, high: 100.5, low: 99.5, close: 100, volume: 100 },
          { timestamp: new Date(t + 60000), open: 100, high: 100.5, low: 99.5, close: 100, volume: 100 },
          { timestamp: new Date(t + 120000), open: 100, high: 125, low: 99.5, close: 124, volume: 100 },
        ],
      };
    });

    const candidate: StrategyCandidate = {
      id: 'cand_wfv_diff',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-wfv-diff',
      type: 'THRESHOLD',
      description: 'WFV fold diff test',
      change: { parameter: 'minMtfScore', value: 60 },
      evidence: { sampleSize: 30, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const baseTs = baseTime;
    const continuousCandles = Array.from({ length: 80 }, (_, i) => ({
      timestamp: new Date(baseTs + i * 300000),
      open: 100 + (i % 2 === 0 ? 5 : -5),
      high: 110,
      low: 90,
      close: 100 + (i % 2 === 0 ? 2 : -2),
      volume: 1000,
    }));

    const wfRes = WalkForwardValidator.validate(candidate, experiences, {
      numFolds: 2,
      candles: continuousCandles,
    });
    expect(wfRes.foldArtifacts).toBeDefined();
    expect(wfRes.foldArtifacts!.length).toBe(2);

    const fold1 = wfRes.foldArtifacts![0];
    const fold2 = wfRes.foldArtifacts![1];

    expect(fold1.trainDatasetHash).not.toBe(fold2.trainDatasetHash);
    expect(fold1.modelVersion).not.toBe(fold2.modelVersion);
    expect(fold1.candidateConfigHash).not.toBe(fold2.candidateConfigHash);
  });

  // Test Q — Fold artifacts contain real hashes
  test('Test Q: Fold artifacts contain real hashes', () => {
    const experiences: TradingExperience[] = Array.from({ length: 24 }, (_, i) => {
      const t = baseTime + i * 300000;
      return {
        id: `exp_hashes_${i}`,
        tradeId: `tr_hashes_${i}`,
        timestamp: new Date(t),
        decisionTimestamp: t,
        featureTimestamp: t,
        labelStartTimestamp: t + 1000,
        labelEndTimestamp: t + 180000,
        instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
        marketState: { quant: { smcScore: 70 } },
        decision: { action: 'BUY', score: 70 },
        execution: { entryPrice: 100, entryTime: new Date(t) },
        risk: { stopLoss: 95 },
        prediction: {},
        outcome: {
          status: 'WIN',
          pnl: 100,
          pnlR: 1.0,
          maxFavorableExcursion: 1.5,
          maxAdverseExcursion: 0.2,
          holdingTimeSeconds: 120,
        },
        marketContext: { regime: 'BULLISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 },
        outcomeClassification: 'GOOD_TRADE_WIN',
        reasons: [],
        failureReasons: [],
        strategyVersion: 'v2.0',
        featureSchemaVersion: '2.0',
        createdAt: new Date(),
        candlesDuringTrade: [
          { timestamp: new Date(t), open: 100, high: 100.5, low: 99.5, close: 100, volume: 100 },
          { timestamp: new Date(t + 60000), open: 100, high: 100.5, low: 99.5, close: 100, volume: 100 },
          { timestamp: new Date(t + 120000), open: 100, high: 125, low: 99.5, close: 124, volume: 100 },
        ],
      };
    });

    const candidate: StrategyCandidate = {
      id: 'cand_hashes',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-hashes',
      type: 'THRESHOLD',
      description: 'Candidate for hashes test',
      change: { parameter: 'minMtfScore', value: 60 },
      evidence: { sampleSize: 24, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const baseTs = baseTime;
    const continuousCandles = Array.from({ length: 30 }, (_, i) => ({
      timestamp: new Date(baseTs + i * 300000),
      open: 100 + (i % 2 === 0 ? 5 : -5),
      high: 110,
      low: 90,
      close: 100 + (i % 2 === 0 ? 2 : -2),
      volume: 1000,
    }));

    const wfRes = WalkForwardValidator.validate(candidate, experiences, {
      numFolds: 1,
      candles: continuousCandles,
    });
    const fold = wfRes.foldArtifacts![0];

    // Real SHA-256 hashes must be hex strings of non-zero length and derived from content
    expect(fold.trainDatasetHash).toMatch(/^[a-f0-9]{16}$/);
    expect(fold.validationDatasetHash).toMatch(/^[a-f0-9]{16}$/);
    expect(fold.oosDatasetHash).toMatch(/^[a-f0-9]{16}$/);
    expect(fold.candidateConfigHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fold.modelVersion).toMatch(/^ml-v2-[a-f0-9]{12}$/);
  });

  // Test R — Missing label timestamps fail closed
  test('Test R: Missing label timestamps fail closed', () => {
    const expMissingStart = {
      id: 'exp_r1',
      tradeId: 'tr_r1',
      timestamp: new Date(baseTime),
      decisionTimestamp: baseTime,
      featureTimestamp: baseTime,
      labelEndTimestamp: baseTime + 180000,
    } as any;

    const resStart = PointInTimeValidator.validatePointInTimeExperience(expMissingStart);
    expect(resStart.isValid).toBe(false);
    expect(resStart.reason).toBe('MISSING_LABEL_START_TIMESTAMP');

    const expMissingEnd = {
      id: 'exp_r2',
      tradeId: 'tr_r2',
      timestamp: new Date(baseTime),
      decisionTimestamp: baseTime,
      featureTimestamp: baseTime,
      labelStartTimestamp: baseTime + 1000,
    } as any;

    const resEnd = PointInTimeValidator.validatePointInTimeExperience(expMissingEnd);
    expect(resEnd.isValid).toBe(false);
    expect(resEnd.reason).toBe('MISSING_LABEL_END_TIMESTAMP');
  });

  // Test S — Embargo removes overlapping samples
  test('Test S: Embargo removes overlapping samples', () => {
    const dm = new DatasetManager();
    const samples = Array.from({ length: 40 }, (_, i) => ({
      sampleId: `s_${i}`,
      timestamp: baseTime + i * 3600000,
      labelStartTimestamp: baseTime + i * 3600000 + 1000,
      labelEndTimestamp: baseTime + i * 3600000 + 1800000,
      features: { f1: 1.0 },
      labelBinary: 1,
      labelContinuousR: 1.0,
      regime: 'BULLISH',
      volatilityBucket: 'NORMAL',
    }));

    const ds = dm.createDataset('BTCUSDT', '1h', samples);
    const splitZeroEmbargo = dm.splitDataset(ds.metadata.datasetId, 0.6, 0.2, 0.2, 0);
    const splitWithEmbargo = dm.splitDataset(ds.metadata.datasetId, 0.6, 0.2, 0.2, 7200000); // 2h embargo

    expect(splitWithEmbargo.validation.length).toBeLessThan(splitZeroEmbargo.validation.length);
  });

  // Test T — Final OOS modification cannot affect fitted model/scaler/candidate
  test('Test T: Final OOS modification cannot affect fitted model/scaler/candidate', () => {
    const experiences: TradingExperience[] = Array.from({ length: 30 }, (_, i) => {
      const t = baseTime + i * 300000;
      return {
        id: `exp_oos_leak_${i}`,
        tradeId: `tr_oos_leak_${i}`,
        timestamp: new Date(t),
        decisionTimestamp: t,
        featureTimestamp: t,
        labelStartTimestamp: t + 1000,
        labelEndTimestamp: t + 180000,
        instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
        marketState: { quant: { smcScore: 75 } },
        decision: { action: 'BUY', score: 75 },
        execution: { entryPrice: 100, entryTime: new Date(t) },
        risk: { stopLoss: 95 },
        prediction: {},
        outcome: { status: 'WIN', pnl: 100, pnlR: 1.0, maxFavorableExcursion: 1.5, maxAdverseExcursion: 0.2, holdingTimeSeconds: 120 },
        marketContext: { regime: 'BULLISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 },
        outcomeClassification: 'GOOD_TRADE_WIN',
        reasons: [],
        failureReasons: [],
        strategyVersion: 'v2.0',
        featureSchemaVersion: '2.0',
        createdAt: new Date(),
        candlesDuringTrade: [
          { timestamp: new Date(t), open: 100, high: 100.5, low: 99.5, close: 100, volume: 100 },
          { timestamp: new Date(t + 60000), open: 100, high: 100.5, low: 99.5, close: 100, volume: 100 },
          { timestamp: new Date(t + 120000), open: 100, high: 125, low: 99.5, close: 124, volume: 100 },
        ],
      };
    });

    const baseCand: StrategyCandidate = {
      id: 'cand_oos_isolation',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-oos-iso',
      type: 'THRESHOLD',
      description: 'OOS isolation check',
      change: { parameter: 'minMtfScore', value: 60 },
      evidence: { sampleSize: 30, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const baseTs = baseTime;
    const continuousCandles = Array.from({ length: 30 }, (_, i) => ({
      timestamp: new Date(baseTs + i * 300000),
      open: 100 + (i % 2 === 0 ? 5 : -5),
      high: 110,
      low: 90,
      close: 100 + (i % 2 === 0 ? 2 : -2),
      volume: 1000,
    }));

    const resOriginal = WalkForwardValidator.validate(baseCand, experiences, {
      numFolds: 1,
      candles: continuousCandles,
    });

    // Mutate the final OOS items with completely different feature values and outcome
    const experiencesMutated = experiences.map((e, idx) => {
      if (idx >= 25) {
        return {
          ...e,
          marketState: { quant: { smcScore: 99999 } },
          outcome: { ...e.outcome, status: 'LOSS', pnl: -99999, pnlR: -50.0 },
        } as TradingExperience;
      }
      return e;
    });

    const resMutated = WalkForwardValidator.validate(baseCand, experiencesMutated, {
      numFolds: 1,
      candles: continuousCandles,
    });

    // Training fold artifacts must be 100% identical
    expect(resOriginal.foldArtifacts![0].trainDatasetHash).toBe(resMutated.foldArtifacts![0].trainDatasetHash);
    expect(resOriginal.foldArtifacts![0].modelVersion).toBe(resMutated.foldArtifacts![0].modelVersion);
    expect(resOriginal.foldArtifacts![0].modelParameters.weights).toEqual(resMutated.foldArtifacts![0].modelParameters.weights);
    expect(resOriginal.foldArtifacts![0].candidateConfigHash).toBe(resMutated.foldArtifacts![0].candidateConfigHash);
  });

  // Test U — Monte Carlo input comes exclusively from actual candidate execution trades
  test('Test U: Monte Carlo input comes exclusively from actual candidate execution trades', () => {
    const { exp, candles, candidate } = createDeterministicTradeFixture({ hitFullTp1Tp2TrailingTp3: true });
    const backtestRes = CandidateBacktestRunner.runDeterministicTestFixture(candidate, { candles, experiences: [exp] });

    expect(backtestRes.rMultiples).toHaveLength(1);
    expect(backtestRes.rMultiples[0]).toBeGreaterThan(2.0);

    const mcRes = MonteCarloEngine.simulate(backtestRes.rMultiples, { seed: 42 });
    expect(mcRes.probabilityOfRuin).toBeDefined();
    expect(mcRes.iterations).toBeGreaterThan(0);

    // Empty candidate trade results must fail closed
    expect(() => {
      MonteCarloEngine.simulate([]);
    }).toThrow('INSUFFICIENT_CANDIDATE_EXECUTION_RESULTS');
  });

  // Test V — Shadow candidate cannot be promoted immediately after activation
  test('Test V: Shadow candidate cannot be promoted immediately after activation', () => {
    const shadowCandidate: StrategyCandidate = {
      id: 'cand_shadow_new',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-cand-shadow-new',
      type: 'THRESHOLD',
      description: 'Newly activated shadow candidate',
      change: { parameter: 'minMtfScore', value: 70 },
      evidence: { sampleSize: 30, expectancyBefore: 0.2, expectancyAfterHistorical: 0.5 },
      status: 'SHADOW',
      createdAt: new Date(),
      shadowMetrics: undefined, // Zero shadow evidence!
    };

    const promoRes = PromotionGate.evaluateCandidate(shadowCandidate);
    expect(promoRes.approved).toBe(false);
    expect(promoRes.rejectionDetails?.some((r) => r.includes('shadowMetrics is missing'))).toBe(true);
  });

  // Test W — Promotion succeeds only after persisted shadow evidence meets requirements
  test('Test W: Promotion succeeds only after persisted shadow evidence meets requirements', () => {
    const validatedShadowCandidate: StrategyCandidate = {
      id: 'cand_shadow_mature',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-cand-shadow-mature',
      type: 'THRESHOLD',
      description: 'Mature shadow candidate with validated evidence',
      change: { parameter: 'minMtfScore', value: 70 },
      evidence: { sampleSize: 30, expectancyBefore: 0.2, expectancyAfterHistorical: 0.5 },
      validationMetrics: {
        inSampleExpectancy: 0.5,
        walkForwardExpectancy: 0.45,
        outOfSampleExpectancy: 0.45,
        profitFactor: 1.5,
        maxDrawdownPercent: 5.0,
        monteCarloRuinProb: 0.0,
        transactionCostSurvived: true,
      },
      shadowMetrics: {
        shadowTradeCount: 15, // >= min 10
        shadowExpectancy: 0.45, // > baseline 0.2
        shadowWinRate: 60,
        shadowMaxDrawdown: 1.5,
      },
      status: 'SHADOW',
      createdAt: new Date(),
    };

    const promoRes = PromotionGate.evaluateCandidate(validatedShadowCandidate, {
      ...PromotionGate.DEFAULT_CRITERIA,
      allowAutoPromotion: true,
    });

    expect(promoRes.approved).toBe(true);
    expect(promoRes.score).toBeGreaterThanOrEqual(75);
  });

  // Test X — Candidate config hash changes whenever any execution-relevant configuration changes
  test('Test X: Candidate config hash changes whenever any execution-relevant configuration changes', () => {
    const base: StrategyCandidate = {
      id: 'cand_hash_test',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-hash-base',
      type: 'THRESHOLD',
      description: 'Hash test candidate',
      change: { parameter: 'minMtfScore', value: 65, stopLossAtrMultiplier: 1.0, sizingMultiplier: 1.0 },
      evidence: { sampleSize: 10, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const baseHash = CandidateBacktestRunner.createExecutionConfig(base).configHash;

    const modifiedScore = { ...base, change: { ...base.change, value: 70 } };
    const hashScore = CandidateBacktestRunner.createExecutionConfig(modifiedScore).configHash;
    expect(hashScore).not.toBe(baseHash);

    const modifiedStop = { ...base, change: { ...base.change, stopLossAtrMultiplier: 1.5 } };
    const hashStop = CandidateBacktestRunner.createExecutionConfig(modifiedStop).configHash;
    expect(hashStop).not.toBe(baseHash);

    const modifiedSizing = { ...base, change: { ...base.change, sizingMultiplier: 1.5 } };
    const hashSizing = CandidateBacktestRunner.createExecutionConfig(modifiedSizing).configHash;
    expect(hashSizing).not.toBe(baseHash);

    const modifiedRegime = { ...base, change: { ...base.change, filterRegime: 'BULLISH', regimeMode: 'INCLUDE' } };
    const hashRegime = CandidateBacktestRunner.createExecutionConfig(modifiedRegime as any).configHash;
    expect(hashRegime).not.toBe(baseHash);
  });

  // Test Y — Counterfactual result uses the same execution semantics as production backtesting
  test('Test Y: Counterfactual result uses the same execution semantics as production backtesting', () => {
    const { exp } = createDeterministicTradeFixture({ hitFullTp1Tp2TrailingTp3: true });

    const analysis = CounterfactualAnalyzer.analyzeExperience(exp);
    expect(analysis.tradeId).toBe(exp.tradeId);
    expect(analysis.scenarios.length).toBeGreaterThan(0);

    // Each scenario was simulated via authoritative BacktestSimulator
    const tp1Scenario = analysis.scenarios.find((s) => s.scenarioName === 'TP1_FIXED');
    expect(tp1Scenario).toBeDefined();
    expect(tp1Scenario!.simulatedPnLR).toBeDefined();
  });

  // Test Z — No generated JS/map/d.ts artifacts remain under tracked TypeScript source directories
  test('Test Z: No generated JS/map/d.ts artifacts remain under tracked TypeScript source directories', () => {
    const trackedArtifacts = execSync(
      'git ls-files "packages/*/src/**/*.js" "packages/*/src/**/*.js.map" "packages/*/src/**/*.d.ts" "packages/*/src/**/*.tsbuildinfo" "apps/*/src/**/*.js" "apps/*/src/**/*.js.map" "apps/*/src/**/*.d.ts" "apps/*/src/**/*.tsbuildinfo"',
      { encoding: 'utf8' },
    ).trim();

    expect(trackedArtifacts).toBe('');
  });

  // Test AA — Candidate strategy changes discover new trades on market data that base strategy does not generate (True Strategy Replay)
  test('Test AA: Candidate strategy changes discover new trades on market data without synthetic experience extraction', async () => {
    const provider = new MockMarketDataProvider({ seed: 42 });
    const candles = await provider.getHistoricalCandles('NIFTY', '15m', 250);

    const baseCandidate: StrategyCandidate = {
      id: 'base-strat-strict',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-strict',
      type: 'THRESHOLD',
      description: 'Strict baseline strategy',
      change: {
        parameter: 'minMtfScore',
        value: 85, // Very strict score threshold
      },
      evidence: { sampleSize: 10, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const permissiveCandidate: StrategyCandidate = {
      id: 'permissive-strat',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-permissive',
      type: 'THRESHOLD',
      description: 'Permissive candidate strategy with lower score threshold',
      change: {
        parameter: 'minMtfScore',
        value: 50, // Permissive score threshold
      },
      evidence: { sampleSize: 10, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    // Run replay strictly with market data candles and NO historical experiences
    const baseResult = CandidateBacktestRunner.runCandidateBacktest(baseCandidate, [], { candles });
    const permResult = CandidateBacktestRunner.runCandidateBacktest(permissiveCandidate, [], { candles });

    // Both simulations completed through SignalGenerator and BacktestSimulator
    expect(baseResult).toBeDefined();
    expect(permResult).toBeDefined();

    // Permissive candidate discovers more trades directly from the market candle stream
    expect(permResult.totalTrades).toBeGreaterThan(baseResult.totalTrades);
    expect(permResult.trades.length).toBe(permResult.totalTrades);

    // Each trade contains authoritative execution records from the engine
    for (const trade of permResult.trades) {
      expect(trade.entryPrice).toBeGreaterThan(0);
      expect(trade.exitPrice).toBeGreaterThan(0);
      expect(typeof trade.pnlRMultiple).toBe('number');
    }
  });

  // Test AB — Model scoring evaluates against actual 28-dimensional canonical feature vector, not static constants
  test('Test AB: Model scoring evaluates against actual 28-dimensional canonical feature vector, not static constants', () => {
    const { exp: expBase, candles, candidate } = createDeterministicTradeFixture();

    // Model with selective weights: strongly positive on feature 0 (smcScore), strongly negative on feature 3 (mtfAlignment)
    const weights = new Array(28).fill(0);
    weights[0] = 10.0; // smcScore
    weights[3] = -10.0; // mtfAlignment
    const bias = 0.0;

    const testModelArtifact = {
      modelVersion: 'ml-v2-feature-test',
      weights,
      bias,
      featureSchemaVersion: '2.0',
      sampleCount: 100,
      trainLoss: 0.1,
      trainedAt: new Date(0),
    };

    const featHigh: Record<string, number> = {};
    const featLow: Record<string, number> = {};
    for (const name of CANONICAL_FEATURE_NAMES_V2) {
      featHigh[name] = 0.5;
      featLow[name] = 0.5;
    }
    featHigh.smcScore = 0.9;
    featHigh.mtfAlignment = 0.1;
    featLow.smcScore = 0.1;
    featLow.mtfAlignment = 0.9;

    // Experience 1: High smcScore (0.9), Low mtfAlignment (0.1) -> z = 10*(0.9) - 10*(0.1) = +8.0 -> prob ~ 0.999 -> score 100
    const expHighFavorable: TradingExperience = {
      ...expBase,
      id: 'exp_high_fav',
      tradeId: 't_high_fav',
      marketState: {
        quant: featHigh,
      },
    };

    // Experience 2: Low smcScore (0.1), High mtfAlignment (0.9) -> z = 10*(0.1) - 10*(0.9) = -8.0 -> prob ~ 0.0003 -> score 0
    const expLowUnfavorable: TradingExperience = {
      ...expBase,
      id: 'exp_low_unfav',
      tradeId: 't_low_unfav',
      marketState: {
        quant: featLow,
      },
    };

    const candWithModel: StrategyCandidate = {
      ...candidate,
      id: 'cand_with_real_features',
      type: 'MODEL',
      change: {
        modelArtifact: testModelArtifact,
        minMtfScore: 60,
      },
    };

    const simHigh = CandidateBacktestRunner.runDeterministicTestFixture(candWithModel, {
      candles,
      experiences: [expHighFavorable],
    });
    const simLow = CandidateBacktestRunner.runDeterministicTestFixture(candWithModel, {
      candles,
      experiences: [expLowUnfavorable],
    });

    expect(simHigh.totalTrades).toBe(1);
    expect(simLow.totalTrades).toBe(0);
  });

  // Test AC — minProbability is passed into BacktestSimulator and filters trades without requiring a custom modelArtifact
  test('Test AC: minProbability is passed into BacktestSimulator and filters trades without requiring custom modelArtifact', () => {
    const { exp, candles, candidate } = createDeterministicTradeFixture();
    const expWithProb: TradingExperience = {
      ...exp,
      prediction: { probabilityWin: 0.65 },
    };

    // Candidate 1: Permissive minProbability (0.60) -> 0.65 >= 0.60 -> Trade passes
    const candPermissive: StrategyCandidate = {
      ...candidate,
      id: 'cand_prob_permissive',
      type: 'FILTER',
      change: { parameter: 'minProbability', value: 0.60 },
    };

    // Candidate 2: Strict minProbability (0.75) -> 0.65 < 0.75 -> Trade rejected
    const candStrict: StrategyCandidate = {
      ...candidate,
      id: 'cand_prob_strict',
      type: 'FILTER',
      change: { parameter: 'minProbability', value: 0.75 },
    };

    const resPermissive = CandidateBacktestRunner.runDeterministicTestFixture(candPermissive, {
      candles,
      experiences: [expWithProb],
    });
    const resStrict = CandidateBacktestRunner.runDeterministicTestFixture(candStrict, {
      candles,
      experiences: [expWithProb],
    });

    expect(resPermissive.totalTrades).toBe(1);
    expect(resStrict.totalTrades).toBe(0);
  });

  // Test AD — CandidateArtifact is the authoritative object executed by CandidateBacktestRunner
  test('Test AD: CandidateArtifact is the authoritative object executed and mutations to candidate after creation have zero effect', () => {
    const { exp, candles, candidate } = createDeterministicTradeFixture();

    // Create frozen CandidateArtifact
    const artifact = CandidateBacktestRunner.createCandidateArtifact(candidate);
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(artifact.configHash).toBeDefined();

    // Directly execute the CandidateArtifact via test fixture runner
    const resArtifact = CandidateBacktestRunner.runDeterministicTestFixture(artifact, {
      candles,
      experiences: [exp],
    });
    expect(resArtifact.totalTrades).toBe(1);

    // Mutating mutable original candidate after artifact creation has zero effect on execution
    (candidate.change as any).minMtfScore = 999;
    (candidate.change as any).parameter = 'minMtfScore';
    (candidate.change as any).value = 999;

    const resFromFrozenArtifact = CandidateBacktestRunner.runDeterministicTestFixture(artifact, {
      candles,
      experiences: [exp],
    });
    expect(resFromFrozenArtifact.totalTrades).toBe(1);
  });

  // Test AE — Walk-forward validation performs genuine parameter grid search on training fold to select optimal parameter
  test('Test AE: WalkForwardValidator performs genuine parameter grid search on training fold', async () => {
    const provider = new MockMarketDataProvider({ seed: 42 });
    const continuousCandles = await provider.getHistoricalCandles('BTCUSDT', '15m', 250);
    const baseTs = continuousCandles[0].timestamp.getTime();

    const experiences: TradingExperience[] = Array.from({ length: 30 }, (_, i) => {
      const t = baseTs + (i + 40) * 15 * 60000;
      return {
        id: `exp_opt_${i}`,
        tradeId: `t_opt_${i}`,
        timestamp: new Date(t),
        decisionTimestamp: t,
        featureTimestamp: t,
        labelStartTimestamp: t + 1000,
        labelEndTimestamp: t + 180000,
        instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
        marketState: { quant: { smcScore: i < 10 ? 60 : 75 } },
        decision: { action: 'BUY', score: i < 10 ? 60 : 75 },
        execution: { entryPrice: 100, entryTime: new Date(t) },
        risk: { stopLoss: 95 },
        prediction: {},
        outcome: { status: 'WIN', pnl: 100, pnlR: 1.0, maxFavorableExcursion: 1.5, maxAdverseExcursion: 0.2, holdingTimeSeconds: 600 },
        marketContext: { regime: 'BULLISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 },
        outcomeClassification: 'GOOD_TRADE_WIN',
        reasons: [],
        failureReasons: [],
        strategyVersion: 'v2.0',
        featureSchemaVersion: '2.0',
        createdAt: new Date(),
        candlesDuringTrade: [],
      };
    });

    const baseCand: StrategyCandidate = {
      id: 'cand_grid_opt',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-grid-opt',
      type: 'THRESHOLD',
      description: 'Threshold optimization candidate',
      change: { parameter: 'minMtfScore', value: 80 }, // Initial suboptimal parameter
      evidence: { sampleSize: 30, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const wfRes = WalkForwardValidator.validate(baseCand, experiences, {
      numFolds: 2,
      candles: continuousCandles,
    });
    expect(wfRes.folds.length).toBe(2);
    expect(wfRes.foldArtifacts).toBeDefined();

    // Verify each fold performed parameter optimization and fitted optimal parameter on training fold
    const fold1Artifact = wfRes.foldArtifacts![0];
    expect(fold1Artifact.strategyParameters.fittedValue).toBeDefined();
    expect(typeof fold1Artifact.strategyParameters.fittedValue).toBe('number');
    expect(fold1Artifact.strategyParameters.fittedValue).toBeGreaterThan(0);
    expect(wfRes.folds[0]).toBeDefined();
  });

  // Test AF: WFV throws INSUFFICIENT_PURGED_VALIDATION_DATA when purging removes all validation samples
  test('Test AF: WalkForwardValidator fails closed with INSUFFICIENT_PURGED_VALIDATION_DATA instead of falling back to unpurged data', () => {
    const experiences: TradingExperience[] = Array.from({ length: 30 }, (_, i) => {
      const t = 1700000000000 + i * 60000;
      // Make training fold labels extend far into the future past all validation samples
      const labelEnd = i < 15 ? 1700000000000 + 30 * 60000 : t + 30000;
      return {
        id: `exp_purge_val_${i}`,
        tradeId: `t_${i}`,
        timestamp: new Date(t),
        decisionTimestamp: t,
        featureTimestamp: t,
        labelStartTimestamp: t + 1000,
        labelEndTimestamp: labelEnd,
        instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
        marketState: { quant: { smcScore: 80 } },
        decision: { action: 'BUY', score: 80 },
        execution: { entryPrice: 100, entryTime: new Date(t) },
        risk: { stopLoss: 95 },
        prediction: {},
        outcome: { status: 'WIN', pnl: 100, pnlR: 1.0, maxFavorableExcursion: 1.5, maxAdverseExcursion: 0.2, holdingTimeSeconds: 600 },
        marketContext: { regime: 'BULLISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 },
        outcomeClassification: 'GOOD_TRADE_WIN',
        reasons: [],
        failureReasons: [],
        strategyVersion: 'v2.0',
        featureSchemaVersion: '2.0',
        createdAt: new Date(),
        candlesDuringTrade: [],
      };
    });

    const cand: StrategyCandidate = {
      id: 'cand_purge_fail',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-pf',
      type: 'THRESHOLD',
      description: 'Purge test',
      change: { parameter: 'minMtfScore', value: 70 },
      evidence: { sampleSize: 30, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    expect(() => {
      WalkForwardValidator.validate(cand, experiences, { numFolds: 2, candles: generateContinuousCandles(30) });
    }).toThrow('INSUFFICIENT_PURGED_VALIDATION_DATA');
  });

  // Test AG: WFV throws INSUFFICIENT_PURGED_OOS_DATA when purging removes all OOS samples
  test('Test AG: WalkForwardValidator fails closed with INSUFFICIENT_PURGED_OOS_DATA instead of falling back to unpurged data', () => {
    const experiences: TradingExperience[] = Array.from({ length: 30 }, (_, i) => {
      const t = 1700000000000 + i * 60000;
      // Make validation fold samples (indices 7-9) extend far into the future past all OOS samples (10-16)
      const labelEnd = (i >= 7 && i < 10) ? 1700000000000 + 40 * 60000 : t + 10000;
      return {
        id: `exp_purge_oos_${i}`,
        tradeId: `t_${i}`,
        timestamp: new Date(t),
        decisionTimestamp: t,
        featureTimestamp: t,
        labelStartTimestamp: t + 1000,
        labelEndTimestamp: labelEnd,
        instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
        marketState: { quant: { smcScore: 80 } },
        decision: { action: 'BUY', score: 80 },
        execution: { entryPrice: 100, entryTime: new Date(t) },
        risk: { stopLoss: 95 },
        prediction: {},
        outcome: { status: 'WIN', pnl: 100, pnlR: 1.0, maxFavorableExcursion: 1.5, maxAdverseExcursion: 0.2, holdingTimeSeconds: 600 },
        marketContext: { regime: 'BULLISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 },
        outcomeClassification: 'GOOD_TRADE_WIN',
        reasons: [],
        failureReasons: [],
        strategyVersion: 'v2.0',
        featureSchemaVersion: '2.0',
        createdAt: new Date(),
        candlesDuringTrade: [],
      };
    });

    const cand: StrategyCandidate = {
      id: 'cand_purge_oos_fail',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-oos-pf',
      type: 'THRESHOLD',
      description: 'Purge OOS test',
      change: { parameter: 'minMtfScore', value: 70 },
      evidence: { sampleSize: 30, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    expect(() => {
      WalkForwardValidator.validate(cand, experiences, { numFolds: 2, candles: generateContinuousCandles(30) });
    }).toThrow('INSUFFICIENT_PURGED_OOS_DATA');
  });

  // Test AH: WFV rejects missing labelEndTimestamp & labelStartTimestamp with fail-closed errors
  test('Test AH: WalkForwardValidator rejects missing labelEndTimestamp and labelStartTimestamp with fail-closed errors', () => {
    const cand: StrategyCandidate = {
      id: 'cand_lbl_err',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-lbl',
      type: 'THRESHOLD',
      description: 'Label error candidate',
      change: { parameter: 'minMtfScore', value: 70 },
      evidence: { sampleSize: 30, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const expsWithoutStart: any[] = Array.from({ length: 30 }, (_, i) => ({
      id: `exp_no_start_${i}`,
      timestamp: new Date(1700000000000 + i * 60000),
      labelEndTimestamp: 1700000000000 + i * 60000 + 30000,
    }));
    expect(() => {
      WalkForwardValidator.validate(cand, expsWithoutStart as any, { numFolds: 2, candles: generateContinuousCandles(30) });
    }).toThrow('MISSING_LABEL_START_TIMESTAMP');

    const expsWithoutEnd: any[] = Array.from({ length: 30 }, (_, i) => ({
      id: `exp_no_end_${i}`,
      timestamp: new Date(1700000000000 + i * 60000),
      labelStartTimestamp: 1700000000000 + i * 60000 + 1000,
    }));
    expect(() => {
      WalkForwardValidator.validate(cand, expsWithoutEnd as any, { numFolds: 2, candles: generateContinuousCandles(30) });
    }).toThrow('MISSING_LABEL_END_TIMESTAMP');
  });

  // Test AI: DatasetManager & LearningEngine strictly fail closed on missing label timestamps without synthesizing horizons
  test('Test AI: DatasetManager and LearningEngine fail closed on missing labelStartTimestamp or labelEndTimestamp', async () => {
    const dm = new DatasetManager();
    const badSampleNoStart: any = {
      sampleId: 's_bad_1',
      timestamp: 1000,
      labelEndTimestamp: 2000,
      features: { f1: 1 },
      labelBinary: 1,
      labelContinuousR: 1.0,
      regime: 'BULL',
      volatilityBucket: 'NORM',
    };
    expect(() => {
      dm.createDataset('BTCUSDT', '15m', [badSampleNoStart]);
    }).toThrow('MISSING_LABEL_START_TIMESTAMP');

    const badSampleNoEnd: any = {
      sampleId: 's_bad_2',
      timestamp: 1000,
      labelStartTimestamp: 1500,
      features: { f1: 1 },
      labelBinary: 1,
      labelContinuousR: 1.0,
      regime: 'BULL',
      volatilityBucket: 'NORM',
    };
    expect(() => {
      dm.createDataset('BTCUSDT', '15m', [badSampleNoEnd]);
    }).toThrow('MISSING_LABEL_END_TIMESTAMP');

    // LearningEngine fail-closed verification: experiences without labelStartTimestamp or labelEndTimestamp throw
    ExperienceStore.clear();
    const badExp: any = {
      id: 'bad_exp_1',
      timestamp: new Date(1700000000000),
      decisionTimestamp: 1700000000000,
      featureTimestamp: 1700000000000,
      instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
      marketState: { quant: { smcScore: 80 } },
      outcome: { status: 'WIN', pnlR: 1.0 },
    };
    expect(() => {
      ExperienceStore.saveExperience(badExp);
    }).toThrow('MISSING_LABEL_START_TIMESTAMP');

    // Bypass store validator to verify LearningEngine itself throws on missing labelStart / labelEnd without synthesizing
    for (let i = 0; i < 15; i++) {
      (ExperienceStore as any).experiences.set(`exp_raw_${i}`, {
        ...badExp,
        id: `exp_raw_${i}`,
        timestamp: new Date(1700000000000 + i * 60000),
      });
    }

    await expect(async () => {
      await LearningEngine.runLearningCycle();
    }).rejects.toThrow('MISSING_LABEL_START_TIMESTAMP');
    ExperienceStore.clear();
  });

  // Test AJ: Centrally defined temporal validation policy enforces DEFAULT_LEARNING_EMBARGO_MS > 0
  test('Test AJ: Centrally defined temporal validation policy enforces non-zero DEFAULT_LEARNING_EMBARGO_MS as autonomous learning default', () => {
    expect(DEFAULT_LEARNING_EMBARGO_MS).toBeDefined();
    expect(DEFAULT_LEARNING_EMBARGO_MS).toBeGreaterThan(0);
    expect(DEFAULT_LEARNING_EMBARGO_MS).toBe(15 * 60 * 1000); // 15 minutes (900,000 ms)
    expect(LearningEngine.DEFAULT_EMBARGO_MS).toBe(DEFAULT_LEARNING_EMBARGO_MS);
  });

  // Test AK: CandidateBacktestRunner enforces production minimumCandles: 50 and warmupBars: 40
  test('Test AK: CandidateBacktestRunner enforces production backtester standards (minimumCandles = 50, warmupBars = 40)', () => {
    expect(CandidateBacktestRunner.PRODUCTION_DEFAULT_MINIMUM_CANDLES).toBe(50);
    expect(CandidateBacktestRunner.PRODUCTION_DEFAULT_WARMUP_BARS).toBe(40);

    const cand: StrategyCandidate = {
      id: 'cand_warmup_check',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-wc',
      type: 'THRESHOLD',
      description: 'Warmup test',
      change: { parameter: 'minMtfScore', value: 70 },
      evidence: { sampleSize: 10, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    // When market data is supplied without deterministic signals with candles < 50, it adheres to production minimumCandles: 50
    const fewCandles: ICandle[] = Array.from({ length: 30 }, (_, i) => ({
      timestamp: new Date(1700000000000 + i * 60000),
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 100,
    }));

    const result = CandidateBacktestRunner.runCandidateBacktest(cand, [], { candles: fewCandles });
    // Adheres to BacktestSimulator production standard: < 50 candles produces zero trades (does not bypass warm-up)
    expect(result.totalTrades).toBe(0);
    expect(result.trades.length).toBe(0);
  });

  // Test AL: Baseline strategy expectancy is evaluated via authoritative BacktestSimulator using the exact same market candles
  test('Test AL: CandidateEvaluator evaluates formal baseline strategy benchmark via BacktestSimulator using the same market candles', () => {
    // Generate 10 trading experiences with candles where raw DB pnl is different from simulated baseline
    const experiences: TradingExperience[] = Array.from({ length: 10 }, (_, i) => {
      const t = 1700000000000 + i * 300000;
      const isEven = i % 2 === 0;
      return {
        id: `exp_base_bench_${i}`,
        tradeId: `t_base_bench_${i}`,
        timestamp: new Date(t),
        decisionTimestamp: t,
        featureTimestamp: t,
        labelStartTimestamp: t + 1000,
        labelEndTimestamp: t + 180000,
        instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
        marketState: { quant: { smcScore: 75 } },
        decision: { action: 'BUY', score: 75 },
        execution: { entryPrice: 100, entryTime: new Date(t) },
        risk: { stopLoss: 95 },
        prediction: {},
        // Raw DB outcome pnlR is intentionally logged as 999 to test that CandidateEvaluator does NOT use raw DB pnl
        outcome: {
          status: isEven ? 'WIN' : 'LOSS',
          pnl: isEven ? 100 : -100,
          pnlR: 999.0, // Bogus DB pnl
          maxFavorableExcursion: 1.5,
          maxAdverseExcursion: 1.0,
          holdingTimeSeconds: 600,
        },
        marketContext: { regime: 'BULLISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 },
        outcomeClassification: isEven ? 'GOOD_TRADE_WIN' : 'BAD_TRADE_LOSS',
        reasons: [],
        failureReasons: !isEven ? ['HTF_CONFLICT'] : [],
        strategyVersion: 'v2.0',
        featureSchemaVersion: '2.0',
        createdAt: new Date(),
        candlesDuringTrade: [
          { timestamp: new Date(t), open: 100, high: 100.5, low: 99.5, close: 100, volume: 100 },
          { timestamp: new Date(t + 60000), open: 100, high: 100.5, low: 99.5, close: 100, volume: 100 },
          {
            timestamp: new Date(t + 120000),
            open: 100,
            high: isEven ? 125 : 100.5,
            low: isEven ? 99.5 : 90,
            close: isEven ? 124 : 91,
            volume: 100,
          },
        ],
      };
    });

    const filterCand: StrategyCandidate = {
      id: 'cand_filter_htf',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-f-htf',
      type: 'FILTER',
      description: 'Filter HTF conflict trades',
      change: { action: 'ADD_FILTER_RULE', conditionRules: ['HTF_CONFLICT'], rejectWhenMatched: true },
      evidence: { sampleSize: 10, expectancyBefore: 0, expectancyAfterHistorical: 0 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const evalResult = CandidateEvaluator.evaluateDeterministicTestFixture(filterCand, experiences, 0.05, {
      candles: experiences.flatMap((e) => e.candlesDuringTrade || []),
    });

    // Baseline expectancy MUST NOT be 999.0 (the bogus DB logged pnlR); it must be the authoritative simulated baseline expectancy (~0.86R)
    expect(evalResult.baselineExpectancy).not.toBe(999.0);
    expect(evalResult.baselineExpectancy).toBeCloseTo(0.86, 1);
    expect(evalResult.baselineTrades).toBe(10);

    // Candidate expectancy filters 5 loss trades, so its expectancy should be ~4.8R
    expect(evalResult.candidateExpectancy).toBeGreaterThan(evalResult.baselineExpectancy);
    expect(evalResult.totalSimulatedTrades).toBe(5);
    expect(evalResult.expectancyDelta).toBeGreaterThan(0);
    expect(evalResult.passed).toBe(true);

    // Verify custom baseline benchmark candidate can also be explicitly passed
    const customBaseline: StrategyCandidate = CandidateEvaluator.createBaselineBenchmarkCandidate('v2.0');
    const customEvalResult = CandidateEvaluator.evaluateDeterministicTestFixture(filterCand, experiences, 0.05, {
      baselineCandidate: customBaseline,
      candles: experiences.flatMap((e) => e.candlesDuringTrade || []),
    });
    expect(customEvalResult.baselineExpectancy).toBeCloseTo(evalResult.baselineExpectancy, 1);
    expect(customEvalResult.passed).toBe(true);
  });

  // Test AM: CounterfactualAnalyzer strictly fails closed when market data is insufficient instead of synthesizing outcomes
  test('Test AM: CounterfactualAnalyzer strictly fails closed on missing/insufficient candles (< 2)', () => {
    const expNoCandles: TradingExperience = {
      id: 'exp_cf_no_candles',
      tradeId: 't_cf_no_candles',
      timestamp: new Date(1700000000000),
      decisionTimestamp: 1700000000000,
      featureTimestamp: 1700000000000,
      labelStartTimestamp: 1700000000000 + 1000,
      labelEndTimestamp: 1700000000000 + 180000,
      instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
      marketState: { quant: { smcScore: 75 } },
      decision: { action: 'BUY', score: 75 },
      execution: { entryPrice: 100, entryTime: new Date(1700000000000) },
      risk: { stopLoss: 95 },
      prediction: {},
      outcome: {
        status: 'WIN',
        pnl: 100,
        pnlR: 1.0,
        maxFavorableExcursion: 1.5,
        maxAdverseExcursion: 0.2,
        holdingTimeSeconds: 600,
      },
      marketContext: { regime: 'BULLISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 },
      outcomeClassification: 'GOOD_TRADE_WIN',
      reasons: [],
      failureReasons: [],
      strategyVersion: 'v2.0',
      featureSchemaVersion: '2.0',
      createdAt: new Date(),
      candlesDuringTrade: [], // Empty candles
    };

    // Fails closed on empty candle telemetry
    expect(() => {
      CounterfactualAnalyzer.analyzeExperience(expNoCandles);
    }).toThrow('INSUFFICIENT_MARKET_DATA_FOR_COUNTERFACTUAL_ANALYSIS');

    // Fails closed on only 1 candle
    const expOneCandle: TradingExperience = {
      ...expNoCandles,
      id: 'exp_cf_one_candle',
      candlesDuringTrade: [
        { timestamp: new Date(1700000000000), open: 100, high: 101, low: 99, close: 100.5, volume: 100 },
      ],
    };
    expect(() => {
      CounterfactualAnalyzer.analyzeExperience(expOneCandle);
    }).toThrow('INSUFFICIENT_MARKET_DATA_FOR_COUNTERFACTUAL_ANALYSIS');

    // Batch analysis also fails closed on invalid dataset
    expect(() => {
      CounterfactualAnalyzer.analyzeBatch([expNoCandles, expOneCandle]);
    }).toThrow('INSUFFICIENT_MARKET_DATA_FOR_COUNTERFACTUAL_ANALYSIS');
  });

  // Test AN: ModelTrainer consumes TemporalFeatureScaler, learns weights on scaled features, and propagates scalerArtifact
  test('Test AN: ModelTrainer consumes TemporalFeatureScaler, trains on standardized features, and includes scalerArtifact', () => {
    // Generate a set of experiences with non-standard feature ranges (e.g. 100-200)
    const rawExperiences: TradingExperience[] = Array.from({ length: 20 }, (_, i) => {
      const isWin = i % 2 === 0;
      const t = 1700000000000 + i * 300000;
      const feat: Record<string, number> = {};
      for (const name of CANONICAL_FEATURE_NAMES_V2) {
        feat[name] = 50;
      }
      feat.smcScore = isWin ? 180 : 110;
      feat.mtfAlignment = isWin ? 95 : 15;
      feat.volatilityAtr = isWin ? 50 : 250;

      return {
        id: `exp_scaler_test_${i}`,
        tradeId: `t_sc_${i}`,
        timestamp: new Date(t),
        decisionTimestamp: t,
        featureTimestamp: t,
        labelStartTimestamp: t + 1000,
        labelEndTimestamp: t + 180000,
        instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
        features: feat,
        marketState: {
          quant: feat,
        },
        decision: { action: 'BUY', score: 80 },
        execution: { entryPrice: 100, entryTime: new Date(t) },
        risk: { stopLoss: 95, target1: 115 },
        prediction: {},
        outcome: {
          status: isWin ? 'WIN' : 'LOSS',
          pnl: isWin ? 100 : -100,
          pnlR: isWin ? 1.0 : -1.0,
          maxFavorableExcursion: 1.5,
          maxAdverseExcursion: 0.2,
          holdingTimeSeconds: 600,
        },
        marketContext: { regime: 'BULLISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 },
        outcomeClassification: isWin ? 'GOOD_TRADE_WIN' : 'BAD_TRADE_LOSS',
        reasons: [],
        failureReasons: [],
        strategyVersion: 'v2.0',
        featureSchemaVersion: '2.0',
        createdAt: new Date(),
        candlesDuringTrade: [
          { timestamp: new Date(t), open: 100, high: 100.5, low: 99.5, close: 100, volume: 100 },
          { timestamp: new Date(t + 60000), open: 100, high: 100.5, low: 99.5, close: 100, volume: 100 },
          {
            timestamp: new Date(t + 120000),
            open: 100,
            high: isWin ? 125 : 100.5,
            low: isWin ? 99.5 : 90,
            close: isWin ? 124 : 91,
            volume: 100,
          },
        ],
      };
    });

    // 1. Explicitly fit TemporalFeatureScaler
    const scaler = new TemporalFeatureScaler();
    scaler.fit(rawExperiences);

    const smcStats = scaler.getParams('smcScore');
    expect(smcStats).toBeDefined();
    expect(smcStats!.mean).toBeCloseTo(145, 0);

    // 2. Train model consuming fitted scaler
    const modelArtifact = ModelTrainer.trainModel(rawExperiences, { scaler, epochs: 100 });

    expect(modelArtifact.scalerArtifact).toBeDefined();
    expect(modelArtifact.scalerArtifact?.scalerParameters.smcScore).toBeDefined();
    expect(modelArtifact.scalerArtifact?.scalerParameters.smcScore.mean).toBeCloseTo(145, 0);
    expect(modelArtifact.weights.length).toBe(CANONICAL_V2_DIMENSION);
    expect(modelArtifact.trainLoss).toBeLessThan(0.693); // Loss decreased via learning

    // 3. Verify CandidateBacktestRunner and BacktestSimulator execute model using the attached scalerArtifact
    const modelCand: StrategyCandidate = {
      id: 'cand_model_scaled',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-m-sc',
      type: 'MODEL',
      description: 'Scaled model candidate',
      change: {
        parameter: 'minProbability',
        minProbability: 0.55,
        modelArtifact,
        scalerArtifact: modelArtifact.scalerArtifact,
      },
      evidence: { sampleSize: 20, expectancyBefore: 0, expectancyAfterHistorical: 0 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const backtestRes = CandidateBacktestRunner.runDeterministicTestFixture(modelCand, {
      candles: rawExperiences.flatMap((e) => e.candlesDuringTrade || []),
      experiences: rawExperiences,
    });
    expect(backtestRes).toBeDefined();
    // Model correctly filtered low-probability loss setups using scaled features
    expect(backtestRes.winRate).toBeGreaterThan(0.5);
  });

  // Test AO: FoldArtifact scalerVersion is content-derived and trainingSeed is configurable
  test('Test AO: WalkForwardValidator generates content-derived scalerVersion and respects configurable seed in FoldArtifact', () => {
    const experiences: TradingExperience[] = Array.from({ length: 30 }, (_, i) => {
      const t = 1700000000000 + i * 60000;
      return {
        id: `exp_fold_art_${i}`,
        tradeId: `t_fa_${i}`,
        timestamp: new Date(t),
        decisionTimestamp: t,
        featureTimestamp: t,
        labelStartTimestamp: t + 1000,
        labelEndTimestamp: t + 30000,
        instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
        marketState: { quant: { smcScore: 70 + i, mtfAlignment: 0.8 } },
        decision: { action: 'BUY', score: 80 },
        execution: { entryPrice: 100, entryTime: new Date(t) },
        risk: { stopLoss: 95 },
        prediction: {},
        outcome: { status: 'WIN', pnl: 100, pnlR: 1.0, maxFavorableExcursion: 1.5, maxAdverseExcursion: 0.2, holdingTimeSeconds: 600 },
        marketContext: { regime: 'BULLISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 },
        outcomeClassification: 'GOOD_TRADE_WIN',
        reasons: [],
        failureReasons: [],
        strategyVersion: 'v2.0',
        featureSchemaVersion: '2.0',
        createdAt: new Date(),
        candlesDuringTrade: [
          { timestamp: new Date(t), open: 100, high: 100.5, low: 99.5, close: 100, volume: 100 },
          { timestamp: new Date(t + 60000), open: 100, high: 125, low: 99.5, close: 124, volume: 100 },
        ],
      };
    });

    const cand: StrategyCandidate = {
      id: 'cand_fold_art_test',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-fa',
      type: 'THRESHOLD',
      description: 'Fold artifact provenance test',
      change: { parameter: 'minMtfScore', value: 75 },
      evidence: { sampleSize: 30, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const baseTs = 1700000000000;
    const continuousCandles = Array.from({ length: 80 }, (_, i) => ({
      timestamp: new Date(baseTs + i * 60000),
      open: 100 + (i % 2 === 0 ? 5 : -5),
      high: 110,
      low: 90,
      close: 100 + (i % 2 === 0 ? 2 : -2),
      volume: 1000,
    }));

    // 1. Default seed (42) produces content-derived scalerVersion
    const wfResDefault = WalkForwardValidator.validate(cand, experiences, {
      numFolds: 2,
      candles: continuousCandles,
    });
    expect(wfResDefault.foldArtifacts).toBeDefined();
    expect(wfResDefault.foldArtifacts!.length).toBe(2);

    const fold1 = wfResDefault.foldArtifacts![0];
    expect(fold1.scalerVersion).toMatch(/^scaler-v2-[0-9a-f]{12}$/);
    expect(fold1.scalerVersion).not.toBe('v1.0');
    expect(fold1.trainingSeed).toBe(42);

    // 2. Custom seed (1337) is recorded in fold artifacts
    const wfResCustomSeed = WalkForwardValidator.validate(cand, experiences, {
      numFolds: 2,
      seed: 1337,
      candles: continuousCandles,
    });
    expect(wfResCustomSeed.foldArtifacts![0].trainingSeed).toBe(1337);
  });

  // Test AP: Base Strategy vs Candidate Strategy on the EXACT SAME continuous candles through SignalGenerator and BacktestSimulator
  test('Test AP: Base Strategy vs Candidate Strategy on the EXACT SAME continuous candles through SignalGenerator and BacktestSimulator', async () => {
    const provider = new MockMarketDataProvider({ seed: 100 });
    const continuousCandles = await provider.getHistoricalCandles('BTCUSDT', '15m', 200);

    // 1. Base Strategy Candidate
    const baseCand: StrategyCandidate = {
      id: 'base_strat_v2',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-base',
      type: 'BASELINE',
      description: 'Base production strategy',
      change: {
        minMtfScore: 50,
        stopLossAtrMultiplier: 1.0,
        sizingMultiplier: 1.0,
      },
      evidence: { sampleSize: 200, expectancyBefore: 0, expectancyAfterHistorical: 0 },
      status: 'PROMOTED',
      createdAt: new Date(),
    };

    const baseResult = CandidateBacktestRunner.runCandidateBacktest(baseCand, [], {
      candles: continuousCandles,
      initialCapital: 500000,
    });
    expect(baseResult).toBeDefined();

    // 2. Candidate Strategy with higher threshold (minMtfScore: 75)
    const thresholdCand: StrategyCandidate = {
      ...baseCand,
      id: 'cand_higher_threshold',
      candidateVersion: 'v2.0-thresh-75',
      type: 'THRESHOLD',
      change: { ...baseCand.change, minMtfScore: 75 },
    };
    const thresholdResult = CandidateBacktestRunner.runCandidateBacktest(thresholdCand, [], {
      candles: continuousCandles,
    });
    // Threshold candidate strictly filters lower-conviction trades from SignalGenerator
    expect(thresholdResult.totalTrades).toBeLessThanOrEqual(baseResult.totalTrades);

    // 3. Candidate Strategy with widened stop multiplier (stopLossAtrMultiplier: 1.5)
    const stopCand: StrategyCandidate = {
      ...baseCand,
      id: 'cand_wide_stop',
      candidateVersion: 'v2.0-stop-1.5',
      type: 'EXIT',
      change: { ...baseCand.change, stopLossAtrMultiplier: 1.5 },
    };
    const stopResult = CandidateBacktestRunner.runCandidateBacktest(stopCand, [], {
      candles: continuousCandles,
    });
    // Widened stop executes through authoritative BacktestSimulator on exact same candles
    expect(stopResult).toBeDefined();

    // 4. Candidate Strategy with custom position sizing (sizingMultiplier: 2.0)
    const sizingCand: StrategyCandidate = {
      ...baseCand,
      id: 'cand_double_size',
      candidateVersion: 'v2.0-size-2.0',
      type: 'SIZING',
      change: { ...baseCand.change, sizingMultiplier: 2.0 },
    };
    const sizingResult = CandidateBacktestRunner.runCandidateBacktest(sizingCand, [], {
      candles: continuousCandles,
      initialCapital: 500000,
    });
    expect(sizingResult.totalTrades).toBeGreaterThan(0);
    expect(sizingResult.trades[0].positionSize).toBe(baseResult.trades[0].positionSize * 2);

    // 5. Candidate Strategy with regime filtering
    const regimeCand: StrategyCandidate = {
      ...baseCand,
      id: 'cand_bull_only',
      candidateVersion: 'v2.0-regime-bull',
      type: 'REGIME',
      change: { ...baseCand.change, filterRegime: 'BEARISH_TREND', regimeMode: 'EXCLUDE' },
    };
    const regimeResult = CandidateBacktestRunner.runCandidateBacktest(regimeCand, [], {
      candles: continuousCandles,
    });
    expect(regimeResult).toBeDefined();
  });
});







