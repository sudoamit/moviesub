import * as crypto from 'crypto';
import { ICandle } from '@quant/shared';
import {
  OOSDataset,
  PointInTimeMarketSnapshot,
  TrainingDataset,
  TrainingExample,
  ValidationDataset,
} from './types';
import { PointInTimeValidator } from './point-in-time-validator';
import { MarketDatasetValidator } from './market-dataset-validator';
import { canonicalJsonStringify } from './canonical-serializer';

export interface PITDatasetBuildOptions {
  readonly symbol: string;
  readonly timeframe: string;
  readonly cutoffTimestamp?: number;
  readonly embargoMs?: number;
  readonly trainRatio?: number;
  readonly valRatio?: number;
  readonly oosRatio?: number;
  readonly baseStrategyVersion?: string;
}

export interface PITSplitsResult {
  readonly training: TrainingDataset;
  readonly validation: ValidationDataset;
  readonly oos: OOSDataset;
  readonly rawSampleCount: number;
  readonly purgedValidationCount: number;
  readonly purgedOOSCount: number;
  readonly combinedDatasetHash: string;
}

const FORBIDDEN_FUTURE_FEATURE_PATTERNS = [
  /future/i,
  /next_candle/i,
  /forward_return/i,
  /lead_close/i,
  /post_trade/i,
  /target_hit/i,
];

export class PITExperienceDatasetBuilder {
  /**
   * Validates individual feature keys to prevent lookahead/future leakage.
   */
  public static validateFeatureNames(featureNames: readonly string[]): void {
    for (const name of featureNames) {
      for (const pattern of FORBIDDEN_FUTURE_FEATURE_PATTERNS) {
        if (pattern.test(name)) {
          throw new Error(
            `FEATURE_LOOKAHEAD_LEAKAGE: Leaked future feature '${name}' detected in feature schema`,
          );
        }
      }
    }
  }

  /**
   * Builds an immutable, point-in-time validated TrainingExample.
   * Fails closed if timestamps, features, or causality invariants are violated.
   */
  public static createTrainingExample(raw: {
    readonly exampleId: string;
    readonly decisionTimestamp: number;
    readonly featureTimestamp?: number;
    readonly labelStartTimestamp: number;
    readonly labelEndTimestamp: number;
    readonly features: Record<string, number> | readonly number[];
    readonly featureNames?: readonly string[];
    readonly featureSchemaHash?: string;
    readonly marketDatasetHash?: string;
    readonly strategyVersion?: string;
    readonly candidateVersion?: string;
    readonly label: number;
    readonly outcomeR?: number;
    readonly exitType?: string;
    readonly regime?: string;
    readonly volatilityBucket?: string;
    readonly source?: 'HISTORICAL' | 'SHADOW';
  }): TrainingExample {
    if (!raw.exampleId || typeof raw.exampleId !== 'string') {
      throw new Error('MISSING_EXAMPLE_ID: Training example must have a valid non-empty string exampleId');
    }

    const decTs = raw.decisionTimestamp;
    if (typeof decTs !== 'number' || !Number.isFinite(decTs) || decTs <= 0) {
      throw new Error(`INVALID_DECISION_TIMESTAMP: Invalid decision timestamp for example '${raw.exampleId}'`);
    }

    const featTs = raw.featureTimestamp ?? decTs;
    if (typeof featTs !== 'number' || !Number.isFinite(featTs) || featTs <= 0) {
      throw new Error(`INVALID_FEATURE_TIMESTAMP: Invalid feature timestamp for example '${raw.exampleId}'`);
    }

    if (raw.labelStartTimestamp === undefined || raw.labelStartTimestamp === null) {
      throw new Error(`MISSING_LABEL_START_TIMESTAMP: Example '${raw.exampleId}' is missing labelStartTimestamp`);
    }
    const lStart = raw.labelStartTimestamp;
    if (typeof lStart !== 'number' || !Number.isFinite(lStart)) {
      throw new Error(`INVALID_LABEL_START_TIMESTAMP: Invalid labelStartTimestamp for example '${raw.exampleId}'`);
    }

    if (raw.labelEndTimestamp === undefined || raw.labelEndTimestamp === null) {
      throw new Error(`MISSING_LABEL_END_TIMESTAMP: Example '${raw.exampleId}' is missing labelEndTimestamp`);
    }
    const lEnd = raw.labelEndTimestamp;
    if (typeof lEnd !== 'number' || !Number.isFinite(lEnd)) {
      throw new Error(`INVALID_LABEL_END_TIMESTAMP: Invalid labelEndTimestamp for example '${raw.exampleId}'`);
    }

    // Invariant 1: featureTimestamp <= decisionTimestamp
    if (featTs > decTs) {
      throw new Error(
        `FEATURE_LOOKAHEAD_LEAKAGE: featureTimestamp (${featTs}) > decisionTimestamp (${decTs}) in example '${raw.exampleId}'`,
      );
    }

    // Invariant 2: decisionTimestamp < labelStartTimestamp (label strictly after decision)
    if (decTs >= lStart) {
      throw new Error(
        `INVALID_DECISION_TIMING: decisionTimestamp (${decTs}) >= labelStartTimestamp (${lStart}) in example '${raw.exampleId}'`,
      );
    }

    // Invariant 3: labelStartTimestamp <= labelEndTimestamp
    if (lStart > lEnd) {
      throw new Error(
        `INVALID_LABEL_RANGE: labelStartTimestamp (${lStart}) > labelEndTimestamp (${lEnd}) in example '${raw.exampleId}'`,
      );
    }

    // Extract ordered feature keys & values
    let featureNames: string[] = [];
    let featureValues: number[] = [];

    if (Array.isArray(raw.features)) {
      for (let i = 0; i < raw.features.length; i++) {
        const v = raw.features[i];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          throw new Error(`INVALID_FEATURE_VALUE: Feature value at index ${i} must be a finite number in example '${raw.exampleId}'`);
        }
      }
      featureValues = [...raw.features];
      featureNames = (raw.featureNames ? [...raw.featureNames] : featureValues.map((_, i) => `f_${i}`)).sort();
    } else if (raw.features && typeof raw.features === 'object') {
      featureNames = Object.keys(raw.features).sort();
      this.validateFeatureNames(featureNames);
      featureValues = featureNames.map((k) => {
        const val = (raw.features as Record<string, number>)[k];
        if (typeof val !== 'number' || !Number.isFinite(val)) {
          throw new Error(`INVALID_FEATURE_VALUE: Feature '${k}' must be a finite number in example '${raw.exampleId}'`);
        }
        return val;
      });
    } else {
      throw new Error(`MISSING_FEATURES: Example '${raw.exampleId}' is missing valid feature vector or record`);
    }

    this.validateFeatureNames(featureNames);

    if (!raw.featureSchemaHash || typeof raw.featureSchemaHash !== 'string' || raw.featureSchemaHash.trim() === '') {
      throw new Error(`MISSING_FEATURE_SCHEMA_HASH: Example '${raw.exampleId}' is missing authoritative featureSchemaHash`);
    }

    if (!raw.marketDatasetHash || typeof raw.marketDatasetHash !== 'string' || raw.marketDatasetHash.trim() === '') {
      throw new Error(`MISSING_MARKET_DATASET_HASH: Example '${raw.exampleId}' is missing authoritative marketDatasetHash`);
    }

    if (!raw.strategyVersion || typeof raw.strategyVersion !== 'string' || raw.strategyVersion.trim() === '') {
      throw new Error(`MISSING_STRATEGY_VERSION: Example '${raw.exampleId}' is missing authoritative strategyVersion`);
    }

    if (raw.label !== 0 && raw.label !== 1) {
      throw new Error(`INVALID_BINARY_LABEL: Example '${raw.exampleId}' must have binary label 0 or 1, got ${raw.label}`);
    }

    if (raw.outcomeR === undefined || typeof raw.outcomeR !== 'number' || !Number.isFinite(raw.outcomeR)) {
      throw new Error(`MISSING_OUTCOME_R: Example '${raw.exampleId}' is missing authoritative outcomeR (finite number required)`);
    }

    if (!raw.exitType || typeof raw.exitType !== 'string' || raw.exitType.trim() === '') {
      throw new Error(`MISSING_EXIT_TYPE: Example '${raw.exampleId}' is missing authoritative exitType`);
    }

    if (!raw.regime || typeof raw.regime !== 'string' || raw.regime.trim() === '') {
      throw new Error(`MISSING_REGIME: Example '${raw.exampleId}' is missing authoritative regime`);
    }

    if (!raw.volatilityBucket || typeof raw.volatilityBucket !== 'string' || raw.volatilityBucket.trim() === '') {
      throw new Error(`MISSING_VOLATILITY_BUCKET: Example '${raw.exampleId}' is missing authoritative volatilityBucket`);
    }

    if (!raw.source || (raw.source !== 'HISTORICAL' && raw.source !== 'SHADOW')) {
      throw new Error(`MISSING_DATASET_SOURCE: Example '${raw.exampleId}' must have source 'HISTORICAL' or 'SHADOW'`);
    }

    return Object.freeze({
      exampleId: raw.exampleId,
      decisionTimestamp: decTs,
      featureTimestamp: featTs,
      labelStartTimestamp: lStart,
      labelEndTimestamp: lEnd,
      features: Object.freeze(featureValues),
      featureNames: Object.freeze(featureNames),
      featureSchemaHash: raw.featureSchemaHash,
      marketDatasetHash: raw.marketDatasetHash,
      strategyVersion: raw.strategyVersion,
      candidateVersion: raw.candidateVersion,
      label: raw.label,
      outcomeR: raw.outcomeR,
      exitType: raw.exitType,
      regime: raw.regime,
      volatilityBucket: raw.volatilityBucket,
      source: raw.source,
    });
  }

  /**
   * Computes canonical deterministic SHA-256 hash of training examples.
   */
  public static computeDatasetHash(examples: readonly TrainingExample[]): string {
    if (!examples || examples.length === 0) {
      return crypto.createHash('sha256').update('pit_empty_dataset').digest('hex').substring(0, 16);
    }

    const sorted = [...examples].sort((a, b) => {
      if (a.decisionTimestamp !== b.decisionTimestamp) {
        return a.decisionTimestamp - b.decisionTimestamp;
      }
      return a.exampleId.localeCompare(b.exampleId);
    });

    const canonicalString = sorted
      .map((e) => {
        const featStr = e.features.map((v) => v.toFixed(5)).join(',');
        return `${e.exampleId}|${e.decisionTimestamp}|${e.featureTimestamp}|${e.labelStartTimestamp}|${e.labelEndTimestamp}|${featStr}|${e.label}|${e.outcomeR ?? 0}|${e.regime}|${e.volatilityBucket}`;
      })
      .join('\n');

    return crypto.createHash('sha256').update(canonicalString).digest('hex').substring(0, 16);
  }

  /**
   * Builds point-in-time partitioned Train / Validation / OOS dataset splits
   * enforcing strict label horizon purge, embargo, and cutoff timestamps.
   */
  public static buildSplits(
    rawExamples: readonly TrainingExample[],
    options: PITDatasetBuildOptions,
  ): PITSplitsResult {
    if (!rawExamples || rawExamples.length === 0) {
      throw new Error('EMPTY_DATASET: Cannot build dataset splits from empty example list');
    }

    const cutoff = options.cutoffTimestamp;
    const embargoMs = options.embargoMs ?? 0;
    if (embargoMs < 0) {
      throw new Error(`INVALID_EMBARGO_DURATION: Embargo duration must be non-negative (${embargoMs})`);
    }

    const trainRatio = options.trainRatio ?? 0.6;
    const valRatio = options.valRatio ?? 0.2;
    const oosRatio = options.oosRatio ?? 0.2;

    if (Math.abs(trainRatio + valRatio + oosRatio - 1.0) > 1e-4) {
      throw new Error('INVALID_SPLIT_RATIOS: trainRatio + valRatio + oosRatio must equal 1.0');
    }

    // Filter by cutoff timestamp if specified (only data available at or before cutoff)
    const admitted = cutoff !== undefined ? rawExamples.filter((e) => e.decisionTimestamp <= cutoff) : [...rawExamples];

    if (admitted.length === 0) {
      throw new Error(`NO_DATA_BEFORE_CUTOFF: No training examples found on or before cutoff timestamp ${cutoff}`);
    }

    // Deduplicate and sort chronologically by decision timestamp
    const seenIds = new Set<string>();
    const deduplicated: TrainingExample[] = [];

    for (const ex of admitted) {
      if (seenIds.has(ex.exampleId)) {
        throw new Error(`DUPLICATE_EXAMPLE_ID: Duplicate training example '${ex.exampleId}'`);
      }
      seenIds.add(ex.exampleId);
      deduplicated.push(ex);
    }

    const sorted = [...deduplicated].sort((a, b) => {
      if (a.decisionTimestamp !== b.decisionTimestamp) {
        return a.decisionTimestamp - b.decisionTimestamp;
      }
      return a.exampleId.localeCompare(b.exampleId);
    });

    const total = sorted.length;
    const trainEndIdx = Math.floor(total * trainRatio);
    const valEndIdx = Math.floor(total * (trainRatio + valRatio));

    const trainRaw = sorted.slice(0, trainEndIdx);
    const valRaw = sorted.slice(trainEndIdx, valEndIdx);
    const oosRaw = sorted.slice(valEndIdx);

    // 1. Calculate maximum label end timestamp in train partition for label horizon purge
    let trainMaxLabelEnd = 0;
    for (const ex of trainRaw) {
      if (ex.labelEndTimestamp > trainMaxLabelEnd) {
        trainMaxLabelEnd = ex.labelEndTimestamp;
      }
    }

    // Purge validation samples starting before or during active train label horizon + embargo
    const valPurged = valRaw.filter((ex) => ex.decisionTimestamp > trainMaxLabelEnd + embargoMs);
    const purgedValCount = valRaw.length - valPurged.length;

    // 2. Calculate maximum label end timestamp in validation partition for OOS purge
    let valMaxLabelEnd = trainMaxLabelEnd;
    for (const ex of valPurged) {
      if (ex.labelEndTimestamp > valMaxLabelEnd) {
        valMaxLabelEnd = ex.labelEndTimestamp;
      }
    }

    // Purge OOS samples starting before or during active validation label horizon + embargo
    const oosPurged = oosRaw.filter((ex) => ex.decisionTimestamp > valMaxLabelEnd + embargoMs);
    const purgedOOSCount = oosRaw.length - oosPurged.length;

    const trainHash = this.computeDatasetHash(trainRaw);
    const valHash = this.computeDatasetHash(valPurged);
    const oosHash = this.computeDatasetHash(oosPurged);
    const combinedHash = crypto
      .createHash('sha256')
      .update(`${trainHash}|${valHash}|${oosHash}`)
      .digest('hex')
      .substring(0, 16);

    const featureNames = trainRaw.length > 0 ? trainRaw[0].featureNames : [];
    const featureSchemaHash = trainRaw.length > 0 ? trainRaw[0].featureSchemaHash : 'schema_empty';

    const trainingDataset: TrainingDataset = Object.freeze({
      datasetId: `ds_train_${options.symbol}_${trainHash}`,
      datasetHash: trainHash,
      examples: Object.freeze(trainRaw),
      startTimestamp: trainRaw.length > 0 ? trainRaw[0].decisionTimestamp : 0,
      endTimestamp: trainRaw.length > 0 ? trainRaw[trainRaw.length - 1].decisionTimestamp : 0,
      featureSchemaHash,
      featureNames,
      sampleCount: trainRaw.length,
      symbol: options.symbol,
      timeframe: options.timeframe,
    });

    const validationDataset: ValidationDataset = Object.freeze({
      datasetId: `ds_val_${options.symbol}_${valHash}`,
      datasetHash: valHash,
      examples: Object.freeze(valPurged),
      startTimestamp: valPurged.length > 0 ? valPurged[0].decisionTimestamp : 0,
      endTimestamp: valPurged.length > 0 ? valPurged[valPurged.length - 1].decisionTimestamp : 0,
      featureSchemaHash,
      sampleCount: valPurged.length,
      purgedOverlapCount: purgedValCount,
      embargoMs,
    });

    const oosDataset: OOSDataset = Object.freeze({
      datasetId: `ds_oos_${options.symbol}_${oosHash}`,
      datasetHash: oosHash,
      examples: Object.freeze(oosPurged),
      startTimestamp: oosPurged.length > 0 ? oosPurged[0].decisionTimestamp : 0,
      endTimestamp: oosPurged.length > 0 ? oosPurged[oosPurged.length - 1].decisionTimestamp : 0,
      featureSchemaHash,
      sampleCount: oosPurged.length,
      purgedOverlapCount: purgedOOSCount,
      embargoMs,
    });

    return {
      training: trainingDataset,
      validation: validationDataset,
      oos: oosDataset,
      rawSampleCount: total,
      purgedValidationCount: purgedValCount,
      purgedOOSCount: purgedOOSCount,
      combinedDatasetHash: combinedHash,
    };
  }
}
