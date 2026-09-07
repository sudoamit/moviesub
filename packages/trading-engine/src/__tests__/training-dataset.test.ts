import {
  TradeLabelGenerator,
  AmbiguousLabelPolicy,
  TrainingDatasetBuilder,
  TrainingExample,
  FEATURE_SCHEMA_VERSION,
} from '../ai-trade-learning-engine';
import { ICandle, ISignalSetup, Direction, SignalState, SignalGrade } from '@quant/shared';

function createMockSignal(
  direction = Direction.BULLISH,
  entryTime = new Date('2026-08-20T04:00:00.000Z'),
): ISignalSetup {
  const isBull = direction === Direction.BULLISH;
  return {
    symbol: 'NIFTY',
    direction,
    state: SignalState.ACTIVE,
    grade: SignalGrade.A_PLUS,
    score: 85,
    timeframe: '15m' as any,
    entryZone: {
      min: isBull ? 24090 : 24110,
      max: isBull ? 24110 : 24090,
      optimal: 24100,
    },
    stopLoss: isBull ? 24050 : 24150, // 50 pts risk
    takeProfits: {
      tp1: isBull ? 24175 : 24025,
      tp2: isBull ? 24225 : 23975, // 125 pts reward (2.5R)
      tp3: isBull ? 24300 : 23900,
    },
    riskRewardRatios: {
      rr1: 1.5,
      rr2: 2.5,
      rr3: 4.0,
    },
    scoreBreakdown: {
      htfBias: 15,
      liquiditySweep: 15,
      bos: 15,
      fvg: 15,
      orderBlock: 20,
      displacement: 15,
      volumeConfirmation: 15,
      premiumDiscount: 15,
      riskReward: 15,
      indicatorAlignment: 15,
      totalScore: 85,
      grade: SignalGrade.A_PLUS,
    },
    reasoning: {
      htfStructure: 'Bullish',
      liquidityReason: 'Liquidity Swept',
      triggerReason: 'Order Block Mitigation',
      invalidationReason: 'Stop Loss Breached',
      confirmedChecklist: ['Order Block Confirmed'],
      summary: 'High probability SMC setup.',
    },
    timestamp: entryTime,
  };
}

describe('PHASE 2: Training Dataset & Labels', () => {
  const entryTime = new Date('2026-08-20T04:00:00.000Z');

  describe('1. TradeLabelGenerator — Deterministic Outcomes', () => {
    it('generates label = 1 (+2.5R) when a LONG trade reaches Target before Stop Loss', () => {
      const subsequentCandles: ICandle[] = [
        {
          timestamp: new Date('2026-08-20T04:15:00.000Z'),
          open: 24105,
          high: 24150,
          low: 24085,
          close: 24140,
          volume: 1000,
          isClosed: true,
        },
        {
          timestamp: new Date('2026-08-20T04:30:00.000Z'),
          open: 24140,
          high: 24235, // Breaches TP2 (24225)
          low: 24120, // Low remains safely above SL (24050)
          close: 24230,
          volume: 1200,
          isClosed: true,
        },
      ];

      const outcome = TradeLabelGenerator.evaluateOutcome({
        direction: Direction.BULLISH,
        entryPrice: 24100,
        stopLoss: 24050,
        targetPrice: 24225,
        entryTimestamp: entryTime,
        subsequentCandles,
      });

      expect(outcome).not.toBeNull();
      expect(outcome!.label).toBe(1);
      expect(outcome!.isAmbiguous).toBe(false);
      expect(outcome!.resolvedVia).toBe('TP_FIRST');
      expect(outcome!.realizedRMultiple).toBe(2.5);
      expect(outcome!.exitPrice).toBe(24225);
      expect(outcome!.durationBars).toBe(2);
      expect(outcome!.exitTimestamp.toISOString()).toBe('2026-08-20T04:30:00.000Z');
    });

    it('generates label = 0 (-1.0R) when a LONG trade breaches Stop Loss before Target', () => {
      const subsequentCandles: ICandle[] = [
        {
          timestamp: new Date('2026-08-20T04:15:00.000Z'),
          open: 24095,
          high: 24110,
          low: 24040, // Breaches SL (24050)
          close: 24045,
          volume: 1500,
          isClosed: true,
        },
      ];

      const outcome = TradeLabelGenerator.evaluateOutcome({
        direction: Direction.BULLISH,
        entryPrice: 24100,
        stopLoss: 24050,
        targetPrice: 24225,
        entryTimestamp: entryTime,
        subsequentCandles,
      });

      expect(outcome).not.toBeNull();
      expect(outcome!.label).toBe(0);
      expect(outcome!.isAmbiguous).toBe(false);
      expect(outcome!.resolvedVia).toBe('SL_FIRST');
      expect(outcome!.realizedRMultiple).toBe(-1.0);
      expect(outcome!.exitPrice).toBe(24050);
      expect(outcome!.durationBars).toBe(1);
    });

    it('generates label = 1 for a SHORT trade reaching downside target before SL', () => {
      const subsequentCandles: ICandle[] = [
        {
          timestamp: new Date('2026-08-20T04:15:00.000Z'),
          open: 24095,
          high: 24120, // Below SL (24150)
          low: 23960, // Breaches Short TP2 (23975)
          close: 23970,
          volume: 1200,
          isClosed: true,
        },
      ];

      const outcome = TradeLabelGenerator.evaluateOutcome({
        direction: Direction.BEARISH,
        entryPrice: 24100,
        stopLoss: 24150,
        targetPrice: 23975,
        entryTimestamp: entryTime,
        subsequentCandles,
      });

      expect(outcome).not.toBeNull();
      expect(outcome!.label).toBe(1);
      expect(outcome!.resolvedVia).toBe('TP_FIRST');
      expect(outcome!.realizedRMultiple).toBe(2.5);
    });
  });

  describe('2. Ambiguous Same-Bar Breach Policy Handling', () => {
    // Single wide bar that touches both 24230 (TP) and 24040 (SL)
    const ambiguousCandle: ICandle = {
      timestamp: new Date('2026-08-20T04:15:00.000Z'),
      open: 24100,
      high: 24240, // TP (24225) reached
      low: 24035, // SL (24050) reached
      close: 24120,
      volume: 5000,
      isClosed: true,
    };

    it('returns label = null under default AMBIGUOUS policy (excluded from dataset)', () => {
      const outcome = TradeLabelGenerator.evaluateOutcome({
        direction: Direction.BULLISH,
        entryPrice: 24100,
        stopLoss: 24050,
        targetPrice: 24225,
        entryTimestamp: entryTime,
        subsequentCandles: [ambiguousCandle],
        ambiguousPolicy: AmbiguousLabelPolicy.AMBIGUOUS,
      });

      expect(outcome).not.toBeNull();
      expect(outcome!.isAmbiguous).toBe(true);
      expect(outcome!.label).toBeNull();
      expect(outcome!.resolvedVia).toBe('AMBIGUOUS_SAME_BAR');
    });

    it('returns label = 0 under CONSERVATIVE policy (treated as loss)', () => {
      const outcome = TradeLabelGenerator.evaluateOutcome({
        direction: Direction.BULLISH,
        entryPrice: 24100,
        stopLoss: 24050,
        targetPrice: 24225,
        entryTimestamp: entryTime,
        subsequentCandles: [ambiguousCandle],
        ambiguousPolicy: AmbiguousLabelPolicy.CONSERVATIVE,
      });

      expect(outcome).not.toBeNull();
      expect(outcome!.isAmbiguous).toBe(true);
      expect(outcome!.label).toBe(0);
      expect(outcome!.resolvedVia).toBe('CONSERVATIVE_LOSS');
      expect(outcome!.realizedRMultiple).toBe(-1.0);
    });
  });

  describe('3. TrainingDatasetBuilder & Causality Verification', () => {
    it('builds a verified training example with availableForTrainingAt strictly > predictionTimestamp', () => {
      const signal = createMockSignal(Direction.BULLISH, entryTime);
      const historicalCandles: ICandle[] = [
        {
          timestamp: new Date('2026-08-20T03:30:00.000Z'),
          open: 24050,
          high: 24080,
          low: 24040,
          close: 24070,
          volume: 800,
          isClosed: true,
        },
        {
          timestamp: new Date('2026-08-20T03:45:00.000Z'),
          open: 24070,
          high: 24105,
          low: 24065,
          close: 24100,
          volume: 1100,
          isClosed: true,
        },
      ];

      const subsequentCandles: ICandle[] = [
        {
          timestamp: new Date('2026-08-20T04:15:00.000Z'),
          open: 24100,
          high: 24160,
          low: 24090,
          close: 24150,
          volume: 1200,
          isClosed: true,
        },
        {
          timestamp: new Date('2026-08-20T04:30:00.000Z'),
          open: 24150,
          high: 24240, // Breaches TP
          low: 24130,
          close: 24230,
          volume: 1400,
          isClosed: true,
        },
      ];

      const example = TrainingDatasetBuilder.buildExample({
        id: 'example-1',
        signal,
        historicalCandlesUpToEntry: historicalCandles,
        subsequentCandlesAfterEntry: subsequentCandles,
      });

      expect(example).not.toBeNull();
      expect(example!.id).toBe('example-1');
      expect(example!.symbol).toBe('NIFTY');
      expect(example!.featureSchemaVersion).toBe(FEATURE_SCHEMA_VERSION);
      expect(example!.label).toBe(1);
      expect(example!.outcomeR).toBe(2.5);
      expect(example!.featureArray.length).toBe(17);

      // Strict Causality Check
      const predTime = new Date(example!.predictionTimestamp).getTime();
      const availTime = new Date(example!.availableForTrainingAt).getTime();
      expect(availTime).toBeGreaterThan(predTime);
      expect(example!.availableForTrainingAt.toISOString()).toBe('2026-08-20T04:30:00.000Z');
    });

    it('safely excludes ambiguous observations when building dataset examples', () => {
      const signal = createMockSignal(Direction.BULLISH, entryTime);
      const ambiguousCandle: ICandle = {
        timestamp: new Date('2026-08-20T04:15:00.000Z'),
        open: 24100,
        high: 24250,
        low: 24030,
        close: 24110,
        volume: 3000,
        isClosed: true,
      };

      const example = TrainingDatasetBuilder.buildExample({
        id: 'example-ambiguous',
        signal,
        historicalCandlesUpToEntry: [],
        subsequentCandlesAfterEntry: [ambiguousCandle],
        ambiguousPolicy: AmbiguousLabelPolicy.AMBIGUOUS,
      });

      // Must return null (excluded from training dataset)
      expect(example).toBeNull();
    });

    it('strictly preserves chronological time series ordering without shuffling', () => {
      const examples: TrainingExample[] = [
        {
          id: 'ex-3',
          symbol: 'NIFTY',
          featureSchemaVersion: FEATURE_SCHEMA_VERSION,
          features: {} as any,
          featureArray: new Array(17).fill(0.5),
          label: 1,
          outcomeR: 2.5,
          predictionTimestamp: new Date('2026-08-20T06:00:00.000Z'),
          availableForTrainingAt: new Date('2026-08-20T06:45:00.000Z'),
        },
        {
          id: 'ex-1',
          symbol: 'NIFTY',
          featureSchemaVersion: FEATURE_SCHEMA_VERSION,
          features: {} as any,
          featureArray: new Array(17).fill(0.5),
          label: 0,
          outcomeR: -1.0,
          predictionTimestamp: new Date('2026-08-20T04:00:00.000Z'),
          availableForTrainingAt: new Date('2026-08-20T04:30:00.000Z'),
        },
        {
          id: 'ex-2',
          symbol: 'NIFTY',
          featureSchemaVersion: FEATURE_SCHEMA_VERSION,
          features: {} as any,
          featureArray: new Array(17).fill(0.5),
          label: 1,
          outcomeR: 1.5,
          predictionTimestamp: new Date('2026-08-20T05:00:00.000Z'),
          availableForTrainingAt: new Date('2026-08-20T05:30:00.000Z'),
        },
      ];

      const sorted = TrainingDatasetBuilder.sortChronologically(examples);
      expect(sorted[0].id).toBe('ex-1');
      expect(sorted[1].id).toBe('ex-2');
      expect(sorted[2].id).toBe('ex-3');

      const validation = TrainingDatasetBuilder.validateDataset(sorted);
      expect(validation.isValid).toBe(true);
      expect(validation.errors).toEqual([]);
    });

    it('detects and flags temporal causality leaks in datasets', () => {
      const invalidDataset: TrainingExample[] = [
        {
          id: 'leak-1',
          symbol: 'NIFTY',
          featureSchemaVersion: FEATURE_SCHEMA_VERSION,
          features: {} as any,
          featureArray: new Array(17).fill(0.5),
          label: 1,
          outcomeR: 2.5,
          predictionTimestamp: new Date('2026-08-20T06:00:00.000Z'),
          availableForTrainingAt: new Date('2026-08-20T05:30:00.000Z'), // Leak! Before prediction!
        },
      ];

      const validation = TrainingDatasetBuilder.validateDataset(invalidDataset);
      expect(validation.isValid).toBe(false);
      expect(validation.errors.some((e) => e.includes('causality leak'))).toBe(true);
    });
  });
});
