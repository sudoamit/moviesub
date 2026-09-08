import * as crypto from 'crypto';

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
  labelStartTimestamp?: number;
  labelEndTimestamp?: number;
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

    // Canonical serialization of all sample content for cryptographic provenance
    const canonicalSamplesString = sorted
      .map((s) => {
        const sortedFeatStr = sampleFeatures
          .map((k) => `${k}:${s.features[k] ?? 0}`)
          .join(',');
        const lEnd = s.labelEndTimestamp ?? s.timestamp;
        return `${s.sampleId}|${s.timestamp}|${lEnd}|${sortedFeatStr}|${s.labelBinary}|${s.labelContinuousR}|${s.regime}|${s.volatilityBucket}`;
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
   * with label end timestamp purging to prevent temporal overlap leakage.
   */
  splitDataset(
    datasetId: string,
    trainRatio = 0.6,
    valRatio = 0.2,
    oosRatio = 0.2,
  ): IDatasetSplits {
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
      const endTs = s.labelEndTimestamp ?? s.timestamp;
      if (endTs > trainMaxLabelEnd) trainMaxLabelEnd = endTs;
    }

    // Purge validation samples whose start timestamp is before/during active train label horizon
    const valPurged = valRaw.filter((s) => s.timestamp > trainMaxLabelEnd);

    // Calculate maximum label end timestamp in validation partition
    let valMaxLabelEnd = trainMaxLabelEnd;
    for (const s of valPurged) {
      const endTs = s.labelEndTimestamp ?? s.timestamp;
      if (endTs > valMaxLabelEnd) valMaxLabelEnd = endTs;
    }

    // Purge OOS samples whose start timestamp is before/during active validation label horizon
    const oosPurged = oosRaw.filter((s) => s.timestamp > valMaxLabelEnd);

    return {
      train: Object.freeze(trainRaw),
      validation: Object.freeze(valPurged.length > 0 ? valPurged : valRaw),
      outOfSample: Object.freeze(oosPurged.length > 0 ? oosPurged : oosRaw),
      metadata: record.metadata,
    };
  }

  getDataset(datasetId: string) {
    return this.datasets.get(datasetId);
  }
}

export const TemporalDatasetBuilder = DatasetManager;
export type TemporalDatasetBuilder = DatasetManager;
