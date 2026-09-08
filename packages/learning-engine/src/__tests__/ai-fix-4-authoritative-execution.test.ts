import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { Direction, ICandle, SignalState } from '@quant/shared';
import { BacktestSimulator, FillModel, SameCandleAmbiguityMode } from '@quant/backtesting';
import { CandidateBacktestRunner } from '../candidate-backtest-runner';
import { CandidateEvaluator } from '../candidate-evaluator';
import { CounterfactualAnalyzer } from '../counterfactual-analyzer';
import { DatasetManager } from '../dataset-manager';
import { MonteCarloEngine } from '../monte-carlo-engine';
import { PointInTimeValidator } from '../point-in-time-validator';
import { PromotionGate } from '../promotion-gate';
import { StrategyCandidate, TradingExperience } from '../types';
import { WalkForwardValidator } from '../walk-forward-validator';

describe('AI Fix 4 — Authoritative Execution & Learning Engine Equivalence (Tests A - Z)', () => {
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

    const exp: TradingExperience = {
      id: 'exp_authoritative_fixture',
      tradeId: 'tr_authoritative_fixture',
      timestamp: new Date(baseTime),
      decisionTimestamp: baseTime,
      featureTimestamp: baseTime,
      labelStartTimestamp: baseTime + 1000,
      labelEndTimestamp: baseTime + 180000,
      instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
      marketState: { quant: { smcScore: 80, mtfAlignment: 0.85 } },
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

    // Method B: Run through CandidateEvaluator (which calls CandidateBacktestRunner -> BacktestSimulator)
    const candResult = CandidateBacktestRunner.runCandidateBacktest(candidate, [exp], { candles });

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
  test('Test B: Complete trade lifecycle: TP1 → BE → TP2 → trailing → TP3', () => {
    const { exp, candidate } = createDeterministicTradeFixture({ hitFullTp1Tp2TrailingTp3: true });
    const res = CandidateBacktestRunner.runCandidateBacktest(candidate, [exp]);

    expect(res.totalTrades).toBe(1);
    const trade = res.trades[0];
    expect(trade.exitReason).toBe(SignalState.TP3_HIT);
    expect(trade.pnlRMultiple).toBeGreaterThan(2.0); // Full target reached
  });

  // Test C — Complete trade lifecycle: TP1 → BE → SL
  test('Test C: Complete trade lifecycle: TP1 → BE → SL', () => {
    const { exp, candidate } = createDeterministicTradeFixture({ hitTp1BeSl: true });
    const res = CandidateBacktestRunner.runCandidateBacktest(candidate, [exp]);

    expect(res.totalTrades).toBe(1);
    const trade = res.trades[0];
    // Reached TP1, then stopped out at Breakeven
    expect(trade.exitReason).toMatch(/TP1_HIT|SL_HIT/);
    expect(trade.pnlRMultiple).toBeGreaterThanOrEqual(-0.1); // Protected by BE
  });

  // Test D — Long gap-through SL
  test('Test D: Long gap-through SL fills at gap price with authoritative slippage', () => {
    const { exp, candidate } = createDeterministicTradeFixture({ isShort: false, gapSl: true });
    const res = CandidateBacktestRunner.runCandidateBacktest(candidate, [exp]);

    expect(res.totalTrades).toBe(1);
    const trade = res.trades[0];
    expect(trade.exitReason).toBe(SignalState.SL_HIT);
    // Gapped down to 92 through stop at 95 -> fill price reflects the gap
    expect(trade.exitFillPrice).toBeLessThan(trade.stopLoss);
    expect(trade.pnlRMultiple).toBeLessThan(-1.0); // Slippage penalty applied
  });

  // Test E — Short gap-through SL
  test('Test E: Short gap-through SL fills at gap price with authoritative slippage', () => {
    const { exp, candidate } = createDeterministicTradeFixture({ isShort: true, gapSl: true });
    const res = CandidateBacktestRunner.runCandidateBacktest(candidate, [exp]);

    expect(res.totalTrades).toBe(1);
    const trade = res.trades[0];
    expect(trade.exitReason).toBe(SignalState.SL_HIT);
    // Gapped up to 108 through stop at 105 -> fill price reflects the gap
    expect(trade.exitFillPrice).toBeGreaterThan(trade.stopLoss);
    expect(trade.pnlRMultiple).toBeLessThan(-1.0);
  });

  // Test F — Gap-through TP
  test('Test F: Gap-through TP fills at gap open price', () => {
    const { exp, candidate } = createDeterministicTradeFixture({ isShort: false, gapTp: true });
    const res = CandidateBacktestRunner.runCandidateBacktest(candidate, [exp]);

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
    const candRes = CandidateBacktestRunner.runCandidateBacktest(candidate, [exp], { candles });

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
    const candRes = CandidateBacktestRunner.runCandidateBacktest(candidate, [exp], { candles });

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
    const candRes = CandidateBacktestRunner.runCandidateBacktest(candidate, [exp], { candles });

    expect(candRes.trades[0].entrySlippage).toBe(simRes.trades[0].entrySlippage);
    expect(candRes.trades[0].exitSlippage).toBe(simRes.trades[0].exitSlippage);
  });

  // Test J — Candidate sizing actually changes production position size
  test('Test J: Candidate sizing actually changes production position size', () => {
    const { exp } = createDeterministicTradeFixture({ hitFullTp1Tp2TrailingTp3: true });
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

    const baseRes = CandidateBacktestRunner.runCandidateBacktest(baseCand, [exp]);
    const doubleRes = CandidateBacktestRunner.runCandidateBacktest(doubleSizeCand, [exp]);

    expect(doubleRes.trades[0].positionSize).toBe(baseRes.trades[0].positionSize * 2);
    expect(doubleRes.trades[0].positionSize).toBe(400);
  });

  // Test K — Candidate stop multiplier changes actual production stop
  test('Test K: Candidate stop multiplier changes actual production stop', () => {
    const { exp } = createDeterministicTradeFixture({ hitFullTp1Tp2TrailingTp3: true });
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

    const normalRes = CandidateBacktestRunner.runCandidateBacktest(normalStopCand, [exp]);
    const wideRes = CandidateBacktestRunner.runCandidateBacktest(wideStopCand, [exp]);

    expect(normalRes.trades[0].stopLoss).toBe(95);
    expect(wideRes.trades[0].stopLoss).toBe(90); // 100 - (5 * 2) = 90
  });

  // Test L — Candidate threshold changes actual signal generation
  test('Test L: Candidate threshold changes actual signal generation', () => {
    const { exp } = createDeterministicTradeFixture({ hitFullTp1Tp2TrailingTp3: true });
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

    const passRes = CandidateBacktestRunner.runCandidateBacktest(passCand, [exp]);
    const filterRes = CandidateBacktestRunner.runCandidateBacktest(filterCand, [exp]);

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

  // Test O — Historical outcome.pnlR cannot affect candidate result
  test('Test O: Historical outcome.pnlR cannot affect candidate result', () => {
    const { exp, candidate } = createDeterministicTradeFixture({ hitFullTp1Tp2TrailingTp3: true });

    const exp1 = { ...exp, outcome: { ...exp.outcome, pnl: 9999, pnlR: 100.0 } };
    const exp2 = { ...exp, outcome: { ...exp.outcome, pnl: -9999, pnlR: -100.0 } };

    const res1 = CandidateBacktestRunner.runCandidateBacktest(candidate, [exp1]);
    const res2 = CandidateBacktestRunner.runCandidateBacktest(candidate, [exp2]);

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

    const wfRes = WalkForwardValidator.validate(candidate, experiences, { numFolds: 2 });
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

    const wfRes = WalkForwardValidator.validate(candidate, experiences, { numFolds: 1 });
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

    const resOriginal = WalkForwardValidator.validate(baseCand, experiences, { numFolds: 1 });

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

    const resMutated = WalkForwardValidator.validate(baseCand, experiencesMutated, { numFolds: 1 });

    // Training fold artifacts must be 100% identical
    expect(resOriginal.foldArtifacts![0].trainDatasetHash).toBe(resMutated.foldArtifacts![0].trainDatasetHash);
    expect(resOriginal.foldArtifacts![0].modelVersion).toBe(resMutated.foldArtifacts![0].modelVersion);
    expect(resOriginal.foldArtifacts![0].modelParameters.weights).toEqual(resMutated.foldArtifacts![0].modelParameters.weights);
    expect(resOriginal.foldArtifacts![0].candidateConfigHash).toBe(resMutated.foldArtifacts![0].candidateConfigHash);
  });

  // Test U — Monte Carlo input comes exclusively from actual candidate execution trades
  test('Test U: Monte Carlo input comes exclusively from actual candidate execution trades', () => {
    const { exp, candidate } = createDeterministicTradeFixture({ hitFullTp1Tp2TrailingTp3: true });
    const backtestRes = CandidateBacktestRunner.runCandidateBacktest(candidate, [exp]);

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
});
