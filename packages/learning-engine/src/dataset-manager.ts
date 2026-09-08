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

    // Deduplicate sample IDs
    const seenIds = new Set<string>();
    const deduplicated: IDatasetSample[] = [];

    for (const sample of samples) {
      if (seenIds.has(sample.sampleId)) {
        continue; // Drop duplicate sample ID
      }
      seenIds.add(sample.sampleId);
      deduplicated.push(sample);
    }

    // Sort strictly by timestamp (chronological time-series order)
    const sorted = [...deduplicated].sort((a, b) => a.timestamp - b.timestamp);
    const startDate = new Date(sorted[0].timestamp).toISOString();
    const endDate = new Date(sorted[sorted.length - 1].timestamp).toISOString();

    const sampleFeatures = Object.keys(sorted[0].features || {});
    const contentString = `${symbol}_${timeframe}_${startDate}_${endDate}_${sorted.length}_${sampleFeatures.join(',')}_seed${randomSeed}`;
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
   * Partitions a time-series dataset into strict sequential Train, Validation, and OOS splits.
   * NEVER randomly shuffles time-series data to avoid future lookahead leakage.
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
    const trainEnd = Math.floor(total * trainRatio);
    const valEnd = Math.floor(total * (trainRatio + valRatio));

    const train = Object.freeze(record.samples.slice(0, trainEnd));
    const validation = Object.freeze(record.samples.slice(trainEnd, valEnd));
    const outOfSample = Object.freeze(record.samples.slice(valEnd));

    return {
      train,
      validation,
      outOfSample,
      metadata: record.metadata,
    };
  }

  getDataset(datasetId: string) {
    return this.datasets.get(datasetId);
  }
}

export const TemporalDatasetBuilder = DatasetManager;
export type TemporalDatasetBuilder = DatasetManager;
