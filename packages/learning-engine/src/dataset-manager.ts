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
  train: IDatasetSample[];
  validation: IDatasetSample[];
  outOfSample: IDatasetSample[];
  metadata: IDatasetMetadata;
}

export class DatasetManager {
  private datasets: Map<string, { metadata: IDatasetMetadata; samples: IDatasetSample[] }> = new Map();

  /**
   * Registers and hashes an immutable training dataset
   */
  createDataset(
    symbol: string,
    timeframe: string,
    samples: IDatasetSample[],
    featureVersion = '2.0',
    strategyVersion = '2.0.0',
  ): { metadata: IDatasetMetadata; samples: IDatasetSample[] } {
    if (!samples || samples.length === 0) {
      throw new Error('Cannot create dataset with empty samples');
    }

    // Sort strictly by timestamp (chronological time-series order)
    const sorted = [...samples].sort((a, b) => a.timestamp - b.timestamp);
    const startDate = new Date(sorted[0].timestamp).toISOString();
    const endDate = new Date(sorted[sorted.length - 1].timestamp).toISOString();

    const sampleFeatures = Object.keys(sorted[0].features || {});
    const contentString = `${symbol}_${timeframe}_${startDate}_${endDate}_${sorted.length}_${sampleFeatures.join(',')}`;
    const dataHash = crypto.createHash('sha256').update(contentString).digest('hex').substring(0, 16);

    const datasetVersion = `v_${Date.now()}`;
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

    const record = { metadata, samples: sorted };
    this.datasets.set(datasetId, record);
    return record;
  }

  /**
   * Partitions a time-series dataset into strict sequential Train, Validation, and OOS splits.
   * NEVER randomly shuffles time-series data to avoid future lookahead leakage.
   */
  splitDataset(
    datasetId: string,
    trainRatio = 0.60,
    valRatio = 0.20,
    oosRatio = 0.20,
  ): IDatasetSplits {
    const record = this.datasets.get(datasetId);
    if (!record) {
      throw new Error(`Dataset '${datasetId}' not found`);
    }

    const total = record.samples.length;
    const trainEnd = Math.floor(total * trainRatio);
    const valEnd = Math.floor(total * (trainRatio + valRatio));

    const train = record.samples.slice(0, trainEnd);
    const validation = record.samples.slice(trainEnd, valEnd);
    const outOfSample = record.samples.slice(valEnd);

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
