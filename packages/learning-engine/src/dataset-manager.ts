import * as crypto from 'crypto';
import { ICandle } from '@quant/shared';
import { MarketDatasetValidator } from './market-dataset-validator';

export interface IDatasetMetadata {
  datasetId: string;
  datasetVersion: string;
  dataHash: string;
  symbol: string;
  timeframe: string;
  startDate: string;
  endDate: string;
  featureVersion: string;
  labelVersion: string;
  strategyVersion: string;
  sampleCount: number;
  featuresList: string[];
}

export interface IDatasetSample {
  sampleId: string;
  timestamp: number; // UTC timestamp ms
  labelStartTimestamp: number;
  labelEndTimestamp: number;
  features: Record<string, number>;
  labelBinary: number; // 1 if +1R reached before -1R, 0 otherwise
  labelContinuousR: number; // Realized R-multiple
  regime: string;
  volatilityBucket: string;
}

export interface IDatasetSplits {
  train: ReadonlyArray<IDatasetSample>;
  validation: ReadonlyArray<IDatasetSample>;
  outOfSample: ReadonlyArray<IDatasetSample>;
  metadata: IDatasetMetadata;
}

export class DatasetManager {
  private datasets: Map<string, { metadata: IDatasetMetadata; samples: IDatasetSample[] }> =
    new Map();

  /**
   * Registers and hashes an immutable training dataset.
   * Rejects duplicate sample IDs and sorts strictly chronologically.
   */
  createDataset(
    symbol: string,
    timeframe: string,
    samples: IDatasetSample[],
    featureVersion = '2.0',
    strategyVersion = '2.0.0',
    randomSeed = 42,
  ): { metadata: IDatasetMetadata; samples: IDatasetSample[] } {
    if (!samples || samples.length === 0) {
      throw new Error('Cannot create dataset with empty samples');
    }

    // Deduplicate sample IDs - throw error on duplicate to prevent silent data corruption
    const seenIds = new Set<string>();
    const deduplicated: IDatasetSample[] = [];

    for (const sample of samples) {
      if (seenIds.has(sample.sampleId)) {
        throw new Error(`DUPLICATE_SAMPLE_ID:${sample.sampleId}`);
      }
      seenIds.add(sample.sampleId);
      deduplicated.push(sample);
    }

    // Sort strictly by timestamp (chronological time-series order)
    const sorted = [...deduplicated].sort((a, b) => a.timestamp - b.timestamp);
    const startDate = new Date(sorted[0].timestamp).toISOString();
    const endDate = new Date(sorted[sorted.length - 1].timestamp).toISOString();

    const sampleFeatures = Object.keys(sorted[0].features || {}).sort();

    // P1 #25: Feature Schema & Label Timestamp Validation across all samples
    for (let i = 0; i < sorted.length; i++) {
      const sample = sorted[i];
      if (sample.labelStartTimestamp === undefined || sample.labelStartTimestamp === null) {
        throw new Error(`MISSING_LABEL_START_TIMESTAMP: Sample at index ${i} (${sample.sampleId}) is missing labelStartTimestamp`);
      }
      if (sample.labelEndTimestamp === undefined || sample.labelEndTimestamp === null) {
        throw new Error(`MISSING_LABEL_END_TIMESTAMP: Sample at index ${i} (${sample.sampleId}) is missing labelEndTimestamp`);
      }
      const sampleKeys = Object.keys(sample.features || {}).sort();
      if (
        sampleKeys.length !== sampleFeatures.length ||
        sampleKeys.some((k, idx) => k !== sampleFeatures[idx])
      ) {
        throw new Error(`FEATURE_SCHEMA_MISMATCH: Sample at index ${i} has mismatching feature keys`);
      }
    }

    // P1 #24: Canonical serialization of all sample content for cryptographic provenance
    const canonicalSamplesString = sorted
      .map((s) => {
        const sortedFeatStr = sampleFeatures
          .map((k) => `${k}:${s.features[k] ?? 0}`)
          .join(',');
        const decTs = (s as any).decisionTimestamp ?? s.timestamp;
        const featTs = (s as any).featureTimestamp ?? s.timestamp;
        if (s.labelStartTimestamp === undefined || s.labelStartTimestamp === null) {
          throw new Error('MISSING_LABEL_START_TIMESTAMP');
        }
        if (s.labelEndTimestamp === undefined || s.labelEndTimestamp === null) {
          throw new Error('MISSING_LABEL_END_TIMESTAMP');
        }
        const lStart = s.labelStartTimestamp;
        const lEnd = s.labelEndTimestamp;
        return `${s.sampleId}|${decTs}|${featTs}|${lStart}|${lEnd}|${sortedFeatStr}|${s.labelBinary}|${s.labelContinuousR}|${s.regime}|${s.volatilityBucket}`;
      })
      .join('\n');

    const contentString = `${symbol}_${timeframe}_${startDate}_${endDate}_${sorted.length}_${sampleFeatures.join(',')}_seed${randomSeed}_version${strategyVersion}_features${featureVersion}\nCANONICAL_DATA:\n${canonicalSamplesString}`;
    const dataHash = crypto
      .createHash('sha256')
      .update(contentString)
      .digest('hex')
      .substring(0, 16);

    const datasetVersion = `v_${dataHash}`;
    const datasetId = `ds_${symbol}_${timeframe}_${dataHash}`;

    const metadata: IDatasetMetadata = {
      datasetId,
      datasetVersion,
      dataHash,
      symbol,
      timeframe,
      startDate,
      endDate,
      featureVersion,
      labelVersion: 'P(+1R)_and_RealizedR',
      strategyVersion,
      sampleCount: sorted.length,
      featuresList: sampleFeatures,
    };

    const record = { metadata, samples: Object.freeze(sorted) as IDatasetSample[] };
    this.datasets.set(datasetId, record);
    return record;
  }

  /**
   * Partitions a time-series dataset into strict sequential Train, Validation, and OOS splits
   * with label end timestamp purging and time-based embargo to prevent temporal overlap leakage.
   */
  splitDataset(
    datasetId: string,
    trainRatio = 0.6,
    valRatio = 0.2,
    oosRatio = 0.2,
    embargoMs = 0,
  ): IDatasetSplits {
    if (embargoMs < 0) {
      throw new Error(`INVALID_EMBARGO_DURATION:${embargoMs}`);
    }

    const record = this.datasets.get(datasetId);
    if (!record) {
      throw new Error(`Dataset '${datasetId}' not found`);
    }

    const total = record.samples.length;
    const trainEndIdx = Math.floor(total * trainRatio);
    const valEndIdx = Math.floor(total * (trainRatio + valRatio));

    const trainRaw = record.samples.slice(0, trainEndIdx);
    const valRaw = record.samples.slice(trainEndIdx, valEndIdx);
    const oosRaw = record.samples.slice(valEndIdx);

    // Calculate maximum label end timestamp in training partition for embargo purging
    let trainMaxLabelEnd = 0;
    for (const s of trainRaw) {
      if (s.labelEndTimestamp === undefined || s.labelEndTimestamp === null) {
        throw new Error('MISSING_LABEL_END_TIMESTAMP');
      }
      const endTs = s.labelEndTimestamp;
      if (endTs > trainMaxLabelEnd) trainMaxLabelEnd = endTs;
    }

    // Purge validation samples starting before/during active train label horizon + embargoMs
    const valPurged = valRaw.filter((s) => s.timestamp > trainMaxLabelEnd + embargoMs);
    if (valRaw.length > 0 && valPurged.length === 0) {
      throw new Error('INSUFFICIENT_PURGED_VALIDATION_DATA');
    }

    // Calculate maximum label end timestamp in validation partition
    let valMaxLabelEnd = trainMaxLabelEnd;
    for (const s of valPurged) {
      if (s.labelEndTimestamp === undefined || s.labelEndTimestamp === null) {
        throw new Error('MISSING_LABEL_END_TIMESTAMP');
      }
      const endTs = s.labelEndTimestamp;
      if (endTs > valMaxLabelEnd) valMaxLabelEnd = endTs;
    }

    // Purge OOS samples starting before/during active validation label horizon + embargoMs
    const oosPurged = oosRaw.filter((s) => s.timestamp > valMaxLabelEnd + embargoMs);
    if (oosRaw.length > 0 && oosPurged.length === 0) {
      throw new Error('INSUFFICIENT_PURGED_OOS_DATA');
    }

    return {
      train: Object.freeze(trainRaw),
      validation: Object.freeze(valPurged),
      outOfSample: Object.freeze(oosPurged),
      metadata: record.metadata,
    };
  }

  getDataset(datasetId: string) {
    return this.datasets.get(datasetId);
  }

  public static computeCanonicalDatasetHash(samples: any[]): string {
    if (!samples || samples.length === 0) return 'canonical_empty_hash';
    const sorted = [...samples].sort((a, b) => {
      const ta = typeof a.timestamp === 'number' ? a.timestamp : new Date(a.timestamp || 0).getTime();
      const tb = typeof b.timestamp === 'number' ? b.timestamp : new Date(b.timestamp || 0).getTime();
      return ta - tb;
    });

    const canonicalSamplesString = sorted
      .map((s) => {
        const feats = s.features || s.marketState?.quant || {};
        const featKeys = Object.keys(feats).sort();
        const sortedFeatStr = featKeys.map((k) => `${k}:${feats[k] ?? 0}`).join(',');
        const sampleId = s.sampleId || s.id || 'sample_id';
        const decTs = s.decisionTimestamp ?? (typeof s.timestamp === 'number' ? s.timestamp : new Date(s.timestamp || 0).getTime());
        const featTs = s.featureTimestamp ?? decTs;
        if (s.labelStartTimestamp === undefined || s.labelStartTimestamp === null) {
          throw new Error('MISSING_LABEL_START_TIMESTAMP');
        }
        if (s.labelEndTimestamp === undefined || s.labelEndTimestamp === null) {
          throw new Error('MISSING_LABEL_END_TIMESTAMP');
        }
        const lStart = s.labelStartTimestamp;
        const lEnd = s.labelEndTimestamp;
        const labelBinary = s.labelBinary ?? (s.outcome?.status === 'WIN' ? 1 : 0);
        const labelR = s.labelContinuousR ?? (s.outcome?.pnlR ?? 0);
        const regime = s.regime || s.marketContext?.regime || 'NORMAL';
        const vol = s.volatilityBucket || s.marketContext?.volatilityRegime || 'NORMAL';
        return `${sampleId}|${decTs}|${featTs}|${lStart}|${lEnd}|${sortedFeatStr}|${labelBinary}|${labelR}|${regime}|${vol}`;
      })
      .join('\n');

    return crypto.createHash('sha256').update(canonicalSamplesString).digest('hex').substring(0, 16);
  }

  public static computeCanonicalMarketDatasetHash(candles: ICandle[], timeframe = '15m'): string {
    if (!candles || candles.length === 0) return 'canonical_empty_market_hash';
    const sorted = [...candles].sort((a, b) => {
      const ta = a.timestamp instanceof Date ? a.timestamp.getTime() : new Date(a.timestamp || 0).getTime();
      const tb = b.timestamp instanceof Date ? b.timestamp.getTime() : new Date(b.timestamp || 0).getTime();
      return ta - tb;
    });

    const canonicalCandlesString = sorted
      .map((c) => {
        const ts = c.timestamp instanceof Date ? c.timestamp.getTime() : new Date(c.timestamp).getTime();
        return `${ts}|${c.open}|${c.high}|${c.low}|${c.close}|${c.volume || 0}`;
      })
      .join('\n');

    return crypto
      .createHash('sha256')
      .update(`${timeframe}\n${canonicalCandlesString}`)
      .digest('hex')
      .substring(0, 16);
  }

  public static requireCanonicalMarketDatasetHash(candles: ICandle[], timeframe = '15m'): string {
    if (!candles || candles.length === 0) {
      throw new Error('EMPTY_MARKET_DATA: Cannot compute canonical market dataset hash for empty candle array');
    }
    // Hard production boundary: Validate monotonic timestamps, OHLC sanity, and continuity before hashing
    MarketDatasetValidator.validateCandles(candles, timeframe);
    return this.computeCanonicalMarketDatasetHash(candles, timeframe);
  }
}

export const TemporalDatasetBuilder = DatasetManager;
export type TemporalDatasetBuilder = DatasetManager;
