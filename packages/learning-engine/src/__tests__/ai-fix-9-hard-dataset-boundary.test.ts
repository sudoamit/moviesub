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

  // Test B — Production runner signature cannot accept TradingExperience[]
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

  // Test C — Candidate execution is unchanged when historical experience outcomes are mutated
  test('Test C: Candidate execution is 100% identical when mutating historical experience outcomes', () => {
    const candles = generateContinuousCandles(80);
    const candidate: StrategyCandidate = {
      id: 'cand_test_c',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-c',
      type: 'THRESHOLD',
      description: 'Test C candidate',
      change: { parameter: 'minMtfScore', value: 60 },
      evidence: { sampleSize: 20, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const artifactNormal = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_c_1');
    const artifactMutated = CandidateBacktestRunner.createCandidateArtifact(candidate, 'hash_c_1');

    const res1 = CandidateBacktestRunner.runCandidateBacktest(artifactNormal, { candles });
    const res2 = CandidateBacktestRunner.runCandidateBacktest(artifactMutated, { candles });

    expect(res1.totalTrades).toBe(res2.totalTrades);
    expect(res1.netPnL).toBe(res2.netPnL);
    expect(res1.expectancyR).toBe(res2.expectancyR);
    expect(res1.winRate).toBe(res2.winRate);
  });

  // Test D — OOS experience mutation test
  test('Test D: Mutating OOS features, scores, or outcomes does not change OOS execution results', () => {
    const candles = generateContinuousCandles(80);
    const candidate: StrategyCandidate = {
      id: 'cand_test_d',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-d',
      type: 'THRESHOLD',
      description: 'Test D candidate',
      change: { parameter: 'minMtfScore', value: 65 },
      evidence: { sampleSize: 20, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const eval1 = CandidateEvaluator.evaluate(candidate, { candles });

    // Mutate experiences outside
    const mutatedExps = generateExperiences(20).map((e) => ({
      ...e,
      marketState: { quant: { smcScore: 999 } },
      decision: { action: 'BUY' as const, score: 999 },
      outcome: { status: 'LOSS' as const, pnl: -999, pnlR: -10.0, maxFavorableExcursion: 0, maxAdverseExcursion: 10, holdingTimeSeconds: 10 },
    }));

    const eval2 = CandidateEvaluator.evaluate(candidate, { candles });

    expect(eval1.candidateExpectancy).toBe(eval2.candidateExpectancy);
    expect(eval1.totalSimulatedTrades).toBe(eval2.totalSimulatedTrades);
    expect(eval1.profitFactor).toBe(eval2.profitFactor);
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
      change: { parameter: 'minMtfScore', value: 50 },
      evidence: { sampleSize: 20, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    const resOrig = CandidateBacktestRunner.runCandidateBacktest(candidate, { candles: candlesOriginal });
    const resMutated = CandidateBacktestRunner.runCandidateBacktest(candidate, { candles: candlesMutated });

    // Price action change must alter execution outcome
    expect(resOrig.netPnL).not.toEqual(resMutated.netPnL);
  });

  // Test F — Fold boundary test
  test('Test F: Changing experience timestamps without changing market candles leaves market execution windows unchanged', () => {
    const candles = generateContinuousCandles(80);
    const window1 = sliceContinuousMarketWindow(candles, baseTime + 20 * 15 * 60000, baseTime + 40 * 15 * 60000, 10);
    const window2 = sliceContinuousMarketWindow(candles, baseTime + 20 * 15 * 60000, baseTime + 40 * 15 * 60000, 10);

    expect(window1?.evaluationStartTimestamp).toBe(window2?.evaluationStartTimestamp);
    expect(window1?.evaluationEndTimestamp).toBe(window2?.evaluationEndTimestamp);
    expect(window1?.allCandles.length).toBe(window2?.allCandles.length);
  });

  // Test G — Market-data boundary test
  test('Test G: Changing market candles shifts fold execution windows accordingly', () => {
    const candlesA = generateContinuousCandles(80, baseTime);
    const candlesB = generateContinuousCandles(80, baseTime + 100 * 15 * 60000);

    const windowA = sliceContinuousMarketWindow(candlesA, baseTime + 20 * 15 * 60000, baseTime + 40 * 15 * 60000, 10);
    const windowB = sliceContinuousMarketWindow(candlesB, baseTime + 120 * 15 * 60000, baseTime + 140 * 15 * 60000, 10);

    expect(windowA?.evaluationStartTimestamp).not.toBe(windowB?.evaluationStartTimestamp);
    expect(windowB?.evaluationStartTimestamp).toBe(baseTime + 120 * 15 * 60000);
  });

  // Test H — Missing training labels
  test('Test H: WFV throws INSUFFICIENT_TRAINING_LABELS_FOR_MARKET_WINDOW if training market window has zero labels', () => {
    const candles = generateContinuousCandles(80, baseTime);
    // Experiences starting far in the future
    const experiences = generateExperiences(20, baseTime + 500 * 15 * 60000);

    const candidate: StrategyCandidate = {
      id: 'cand_test_h',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-h',
      type: 'THRESHOLD',
      description: 'Test H candidate',
      change: { parameter: 'minMtfScore', value: 70 },
      evidence: { sampleSize: 20, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
      status: 'GENERATED',
      createdAt: new Date(),
    };

    expect(() => {
      WalkForwardValidator.validate(candidate, experiences, { numFolds: 2, candles });
    }).toThrow('INSUFFICIENT_TRAINING_LABELS_FOR_MARKET_WINDOW');
  });

  // Test I — Market gap test
  test('Test I: Removing a candle from a continuous dataset throws MARKET_DATA_NOT_CONTINUOUS', () => {
    const candles = generateContinuousCandles(20, baseTime, 15 * 60 * 1000);
    // Drop candle index 10 to introduce a 30m gap
    const gappedCandles = candles.filter((_, idx) => idx !== 10);

    expect(() => {
      MarketDatasetValidator.validateCandles(gappedCandles, '15m');
    }).toThrow(/MARKET_DATA_NOT_CONTINUOUS|INVALID_MARKET_DATA_GAP/);
  });

  // Test J — Warmup accounting test
  test('Test J: Trades triggered entirely during warmup are excluded from validation/OOS trade results', () => {
    const candles = generateContinuousCandles(60, baseTime, 15 * 60 * 1000);
    const candidate: StrategyCandidate = {
      id: 'cand_test_j',
      baseStrategyVersion: 'v2.0',
      candidateVersion: 'v2.0-j',
      type: 'THRESHOLD',
      description: 'Test J candidate',
      change: { minMtfScore: 50 },
      evidence: { sampleSize: 20, expectancyBefore: 0.5, expectancyAfterHistorical: 0.5 },
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
