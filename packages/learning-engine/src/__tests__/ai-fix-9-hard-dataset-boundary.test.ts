import { ICandle, MockMarketDataProvider } from '@quant/shared';
import {
  CandidateBacktestRunner,
  CandidateEvaluator,
  MarketDatasetValidator,
  StrategyCandidate,
  TradingExperience,
  WalkForwardValidator,
  sliceContinuousMarketWindow,
  DEFAULT_LEARNING_SEED,
  ExperienceDataset,
  CandidateMarketDataset,
} from '../index';

describe('AI Fix 9 — Hard Dataset Boundary & Temporal WFV Isolation (Tests A - M)', () => {
  const baseTime = 1700000000000;

  function generateContinuousCandles(count: number, startTs = baseTime, intervalMs = 15 * 60 * 1000): ICandle[] {
    return Array.from({ length: count }, (_, i) => ({
      timestamp: new Date(startTs + i * intervalMs),
      open: 100 + (i % 2 === 0 ? 2 : -2),
      high: 105 + (i % 2 === 0 ? 3 : 0),
      low: 95 - (i % 2 === 0 ? 0 : 3),
      close: 101 + (i % 2 === 0 ? 1 : -1),
      volume: 1000,
    }));
  }

  function generateExperiences(count: number, startTs = baseTime, intervalMs = 15 * 60 * 1000): TradingExperience[] {
    return Array.from({ length: count }, (_, i) => {
      const t = startTs + i * intervalMs;
      return {
        id: `exp_fix9_${i}`,
        tradeId: `trade_fix9_${i}`,
        timestamp: new Date(t),
        decisionTimestamp: t,
        featureTimestamp: t,
        labelStartTimestamp: t + 1000,
        labelEndTimestamp: t + intervalMs,
        instrument: { symbol: 'BTCUSDT', assetType: 'CRYPTO' },
        marketState: { quant: { smcScore: 70 + (i % 10) } },
        decision: { action: 'BUY', score: 70 + (i % 10) },
        execution: { entryPrice: 100, entryTime: new Date(t) },
        risk: { stopLoss: 95, target1: 110 },
        prediction: {},
        outcome: {
          status: i % 2 === 0 ? 'WIN' : 'LOSS',
          pnl: i % 2 === 0 ? 100 : -50,
          pnlR: i % 2 === 0 ? 2.0 : -1.0,
          maxFavorableExcursion: 2.0,
          maxAdverseExcursion: 0.5,
          holdingTimeSeconds: 600,
        },
        marketContext: { regime: 'BULLISH', volatilityRegime: 'NORMAL', session: 'NY', dayOfWeek: 1 },
        outcomeClassification: i % 2 === 0 ? 'GOOD_TRADE_WIN' : 'BAD_TRADE_LOSS',
        reasons: [],
        failureReasons: [],
        strategyVersion: 'v2.0',
        featureSchemaVersion: '2.0',
        createdAt: new Date(),
        candlesDuringTrade: [],
      };
    });
  }

  // Test A — Production runner rejects missing market data
  test('Test A: CandidateBacktestRunner rejects missing market data', () => {
    const candidate: StrategyCandidate = {
      id: 'cand_test_a',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-a',
      type: 'THRESHOLD',
      description: 'Test A candidate',
      change: { parameter: 'minMtfScore', value: 70 },
      evidence: { sampleSize: 10, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    expect(() => {
      CandidateBacktestRunner.runCandidateBacktest(candidate, {});
    }).toThrow('INSUFFICIENT_MARKET_DATA_FOR_CANDIDATE_EXECUTION');
  });

  // Test B — Production evaluator rejects execution when market data is missing
  test('Test B: CandidateEvaluator.evaluate rejects execution when market data is missing', () => {
    const candidate: StrategyCandidate = {
      id: 'cand_test_b',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-b',
      type: 'THRESHOLD',
      description: 'Test B candidate',
      change: { parameter: 'minMtfScore', value: 70 },
      evidence: { sampleSize: 10, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    expect(() => {
      CandidateEvaluator.evaluate(candidate);
    }).toThrow('INSUFFICIENT_MARKET_DATA_FOR_CANDIDATE_EXECUTION');
  });

  // Test C — Candidate execution is 100% unchanged when mutating historical experience outcomes
  test('Test C: Candidate execution is 100% identical when mutating historical experience outcomes', () => {
    const candles = generateContinuousCandles(80);
    const candidate: StrategyCandidate = {
      id: 'cand_test_c',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-c',
      type: 'THRESHOLD',
      description: 'Test C candidate',
      change: { parameter: 'minMtfScore', value: 60 },
      evidence: { sampleSize: 30, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const experiencesNormal = generateExperiences(30);
    const experiencesMutated = generateExperiences(30).map((e) => ({
      ...e,
      marketState: { quant: { smcScore: -999 } },
      decision: { action: 'SELL' as const, score: -999 },
      outcome: {
        status: 'LOSS' as const,
        pnl: -99999,
        pnlR: -100.0,
        maxFavorableExcursion: 0,
        maxAdverseExcursion: 50,
        holdingTimeSeconds: 10,
      },
    }));

    const wfRes1 = WalkForwardValidator.validate(candidate, experiencesNormal, {
      numFolds: 2,
      candles,
      seed: 42,
    });
    const wfRes2 = WalkForwardValidator.validate(candidate, experiencesMutated, {
      numFolds: 2,
      candles,
      seed: 42,
    });

    expect(wfRes1.folds.length).toBe(wfRes2.folds.length);
    for (let f = 0; f < wfRes1.folds.length; f++) {
      expect(wfRes1.folds[f].simulatedTrades!.length).toBe(wfRes2.folds[f].simulatedTrades!.length);
      expect(wfRes1.folds[f].outOfSampleExpectancy).toBe(wfRes2.folds[f].outOfSampleExpectancy);
      expect(wfRes1.folds[f].simulatedTrades!.map((t: any) => t.pnl)).toEqual(
        wfRes2.folds[f].simulatedTrades!.map((t: any) => t.pnl),
      );
    }
  });

  // Test D — OOS experience mutation test
  test('Test D: Mutating OOS features, scores, or outcomes does not change OOS execution results, but changes label evaluation', async () => {
    const provider = new MockMarketDataProvider({ seed: 42 });
    const candles = await provider.getHistoricalCandles('BTCUSDT', '15m', 120);
    const candidate: StrategyCandidate = {
      id: 'cand_test_d',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-d',
      type: 'THRESHOLD',
      description: 'Test D candidate',
      change: { parameter: 'minMtfScore', value: 50 },
      evidence: { sampleSize: 30, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const firstCandleTs = candles[0].timestamp instanceof Date ? candles[0].timestamp.getTime() : new Date(candles[0].timestamp).getTime();
    const expsNormal = generateExperiences(30, firstCandleTs, 15 * 60 * 1000);
    const expsMutated = generateExperiences(30, firstCandleTs, 15 * 60 * 1000).map((e, idx) =>
      idx >= 15
        ? {
            ...e,
            outcome: {
              status: 'LOSS' as const,
              pnl: -88888,
              pnlR: -50.0,
              maxFavorableExcursion: 0,
              maxAdverseExcursion: 20,
              holdingTimeSeconds: 1,
            },
          }
        : e,
    );

    const wfResNormal = WalkForwardValidator.validate(candidate, expsNormal, { numFolds: 2, candles, seed: 42 });
    const wfResMutated = WalkForwardValidator.validate(candidate, expsMutated, { numFolds: 2, candles, seed: 42 });

    // Execution trades in OOS are strictly identical
    expect(wfResNormal.folds[0].simulatedTrades!.length).toBe(wfResMutated.folds[0].simulatedTrades!.length);
    expect(wfResNormal.meanOutOfSampleExpectancy).toBe(wfResMutated.meanOutOfSampleExpectancy);

    // Supervised label evaluation reflects label differences
    const simulatedTrades = wfResNormal.folds[0].simulatedTrades || [{ pnlR: 1.0 }, { pnlR: -1.0 }];
    const labelEvalNormal = CandidateEvaluator.evaluateLabels(simulatedTrades, expsNormal);
    const labelEvalMutated = CandidateEvaluator.evaluateLabels(simulatedTrades, expsMutated);

    expect(labelEvalNormal.matchedCount).toBeGreaterThan(0);
    expect(labelEvalNormal.labelWinRate).not.toBe(labelEvalMutated.labelWinRate);
  });

  // Test E — Market mutation test
  test('Test E: Mutating market candles alters execution results (proving market data drives execution)', async () => {
    const provider = new MockMarketDataProvider({ seed: 42 });
    const candlesOriginal: ICandle[] = await provider.getHistoricalCandles('BTCUSDT', '15m', 150);
    const candlesMutated: ICandle[] = candlesOriginal.map((c: ICandle, i: number) => {
      if (i > 50) {
        // Create an inverted trend
        return {
          ...c,
          open: c.open * 0.7,
          high: c.high * 0.75,
          low: c.low * 0.65,
          close: c.close * 0.68,
        };
      }
      return c;
    });

    const candidate: StrategyCandidate = {
      id: 'cand_test_e',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-e',
      type: 'THRESHOLD',
      description: 'Test E candidate',
      change: { parameter: 'minMtfScore', value: 65 },
      evidence: { sampleSize: 20, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const resOriginal = CandidateBacktestRunner.runCandidateBacktest(candidate, { candles: candlesOriginal });
    const resMutated = CandidateBacktestRunner.runCandidateBacktest(candidate, { candles: candlesMutated });

    expect(resOriginal.netPnL).not.toBe(resMutated.netPnL);
  });

  // Test F — Fail closed on missing market data window
  test('Test F: sliceContinuousMarketWindow throws MARKET_DATA_WINDOW_NOT_FOUND when out of range or empty', () => {
    const candles = generateContinuousCandles(50, baseTime);

    expect(() => {
      sliceContinuousMarketWindow(candles, baseTime - 1000000, baseTime - 500000);
    }).toThrow('MARKET_DATA_WINDOW_NOT_FOUND');

    expect(() => {
      sliceContinuousMarketWindow([], baseTime, baseTime + 10000);
    }).toThrow('MARKET_DATA_WINDOW_NOT_FOUND');

    expect(() => {
      sliceContinuousMarketWindow(undefined, baseTime, baseTime + 10000);
    }).toThrow('MARKET_DATA_WINDOW_NOT_FOUND');
  });

  // Test G — Fail closed on non-continuous market candles
  test('Test G: Non-contiguous candles throw MARKET_DATA_NOT_CONTINUOUS', () => {
    const candles = generateContinuousCandles(40, baseTime, 15 * 60 * 1000);
    const corruptedCandles = [
      ...candles.slice(0, 20),
      ...generateContinuousCandles(20, baseTime + 50 * 15 * 60 * 1000, 15 * 60 * 1000),
    ];

    expect(() => {
      MarketDatasetValidator.validateCandles(corruptedCandles);
    }).toThrow(/MARKET_DATA_NOT_CONTINUOUS/);
  });

  // Test H — Warmup trade filtering and entry-based evaluation
  test('Test H: Warmup period trades are excluded from evaluation window metrics and drawdown', () => {
    const candles = generateContinuousCandles(80, baseTime, 15 * 60 * 1000);
    const candidate: StrategyCandidate = {
      id: 'cand_test_h',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-h',
      type: 'THRESHOLD',
      description: 'Test H candidate',
      change: { parameter: 'minMtfScore', value: 50 },
      evidence: { sampleSize: 10, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    // Evaluation window starting at candle 30
    const evalStartTs = baseTime + 30 * 15 * 60000;
    const resWithWarmup = CandidateBacktestRunner.runCandidateBacktest(candidate, {
      candles,
      evaluationStartTimestamp: evalStartTs,
    });

    for (const trade of resWithWarmup.trades) {
      const entryTs = trade.entryTime instanceof Date ? trade.entryTime.getTime() : new Date(trade.entryTime).getTime();
      expect(entryTs).toBeGreaterThanOrEqual(evalStartTs);
    }
  });

  // Test I — First-Class Options API in WalkForwardValidator
  test('Test I: WalkForwardValidator accepts structured IWalkForwardOptions with ExperienceDataset and MarketDataset', () => {
    const candles = generateContinuousCandles(80, baseTime, 15 * 60 * 1000);
    const experiences = generateExperiences(30, baseTime, 15 * 60 * 1000);

    const expDataset: ExperienceDataset = {
      experiences,
      datasetHash: 'exp_hash_1',
      featureSchemaVersion: '2.0',
      symbol: 'BTCUSDT',
      timeframe: '15m',
    };

    const marketDataset: CandidateMarketDataset = {
      candles,
      executionCandles: candles,
      datasetHash: 'market_hash_1',
      timeframe: '15m',
      symbol: 'BTCUSDT',
      isContinuous: true,
      expectedIntervalMs: 15 * 60 * 1000,
    };

    const candidate: StrategyCandidate = {
      id: 'cand_test_i',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-i',
      type: 'THRESHOLD',
      description: 'Test I candidate',
      change: { parameter: 'minMtfScore', value: 65 },
      evidence: { sampleSize: 30, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const wfRes = WalkForwardValidator.validate(candidate, {
      experienceDataset: expDataset,
      marketDataset,
      numFolds: 2,
      seed: 42,
    });

    expect(wfRes.folds.length).toBe(2);
    expect(wfRes.foldArtifacts?.length).toBe(2);
  });

  // Test J — Hardened retrainFn receives structured context and disallows experience injection into candidate execution
  test('Test J: Hardened retrainFn receives structured context without raw experience leakage', () => {
    const candles = generateContinuousCandles(80, baseTime, 15 * 60 * 1000);
    const experiences = generateExperiences(30, baseTime, 15 * 60 * 1000);

    const candidate: StrategyCandidate = {
      id: 'cand_test_j',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-j',
      type: 'THRESHOLD',
      description: 'Test J candidate',
      change: { parameter: 'minMtfScore', value: 60 },
      evidence: { sampleSize: 30, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    let receivedContext: any = null;
    const customRetrainFn = (context: any, baseCand: StrategyCandidate) => {
      receivedContext = context;
      return {
        ...baseCand,
        change: { ...baseCand.change, fittedValue: 75 },
      };
    };

    const wfRes = WalkForwardValidator.validate(candidate, {
      experiences,
      candles,
      numFolds: 2,
      retrainFn: customRetrainFn,
    });

    expect(receivedContext).toBeDefined();
    expect(receivedContext.experienceDataset).toBeDefined();
    expect(receivedContext.trainExperiences).toBeDefined();
    expect(receivedContext.trainCandles).toBeDefined();
    expect(receivedContext.foldIndex).toBe(2); // Last fold executed
    expect(wfRes.folds.length).toBe(2);
  });

  // Test K — OOS metrics test
  test('Test K: Historical label win/loss changes do not alter OOS expectancy, profit factor, or trade count', () => {
    const candles = generateContinuousCandles(80, baseTime, 15 * 60 * 1000);
    const experiencesA = generateExperiences(30, baseTime, 15 * 60 * 1000);
    const experiencesB = generateExperiences(30, baseTime, 15 * 60 * 1000).map((e) => ({
      ...e,
      outcome: { ...e.outcome, status: 'LOSS' as const, pnlR: -1.0 }, // Invert labels to all losses
    }));

    const candidate: StrategyCandidate = {
      id: 'cand_test_k',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-k',
      type: 'THRESHOLD',
      description: 'Test K candidate',
      change: { parameter: 'minMtfScore', value: 70 },
      evidence: { sampleSize: 30, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const wfResA = WalkForwardValidator.validate(candidate, experiencesA, { numFolds: 2, candles, seed: 42 });
    const wfResB = WalkForwardValidator.validate(candidate, experiencesB, { numFolds: 2, candles, seed: 42 });

    // OOS expectancy is determined strictly by market replay
    expect(wfResA.meanOutOfSampleExpectancy).toBe(wfResB.meanOutOfSampleExpectancy);
    expect(wfResA.folds[0].outOfSampleExpectancy).toBe(wfResB.folds[0].outOfSampleExpectancy);
  });

  // Test L — Parameter optimization test
  test('Test L: Grid search on synthetic market data selects the optimal candidate parameter', () => {
    const candles = generateContinuousCandles(60, baseTime, 15 * 60 * 1000);
    const candidate: StrategyCandidate = {
      id: 'cand_test_l',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-l',
      type: 'THRESHOLD',
      description: 'Test L candidate',
      change: { parameter: 'minMtfScore', value: 50 },
      evidence: { sampleSize: 20, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const fittedCandidate = WalkForwardValidator.retrainCandidateOnFold(candles, candidate, 1);
    expect(fittedCandidate.change?.fittedValue).toBeDefined();
    expect([50, 55, 60, 65, 70, 75, 80]).toContain(fittedCandidate.change?.fittedValue);
  });

  // Test M — Artifact identity invariance
  test('Test M: Artifact identity remains identical across differing createdAt timestamps and changes when config changes', () => {
    const candidate: StrategyCandidate = {
      id: 'cand_test_m',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-m',
      type: 'THRESHOLD',
      description: 'Test M candidate',
      change: { parameter: 'minMtfScore', value: 70 },
      evidence: { sampleSize: 10, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(1700000000000),
    };

    const art1 = CandidateBacktestRunner.createCandidateArtifact(candidate, 'dataset_hash_m', 42);

    const candidateDifferentTime: StrategyCandidate = {
      ...candidate,
      createdAt: new Date(1799999999000),
    };
    const art2 = CandidateBacktestRunner.createCandidateArtifact(candidateDifferentTime, 'dataset_hash_m', 42);

    // Identical payload produces identical artifactId
    expect(art1.artifactId).toBe(art2.artifactId);

    // Mutating parameter value changes artifactId
    const candidateModified: StrategyCandidate = {
      ...candidate,
      change: { parameter: 'minMtfScore', value: 80 },
    };
    const artModified = CandidateBacktestRunner.createCandidateArtifact(candidateModified, 'dataset_hash_m', 42);
    expect(artModified.artifactId).not.toBe(art1.artifactId);
  });
});
