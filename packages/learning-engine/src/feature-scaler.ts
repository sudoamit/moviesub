import * as crypto from 'crypto';
import { IDatasetSample } from './dataset-manager';
import { TradingExperience, TrainingExample } from './types';

export interface IScaleParameters {
  mean: number;
  std: number;
  min: number;
  max: number;
}

export class TemporalFeatureScaler {
  private featureStats: Map<string, IScaleParameters> = new Map();

  /**
   * Computes a canonical SHA-256 hash for scaler parameters.
   */
  public static computeScalerHash(
    scalerParameters: Record<string, { mean: number; std: number; min: number; max: number }>,
  ): string {
    const keys = Object.keys(scalerParameters).sort();
    if (keys.length === 0) return crypto.createHash('sha256').update('scaler-v2-empty').digest('hex');
    const payload = keys
      .map(
        (k) =>
          `${k}:${scalerParameters[k].mean.toFixed(4)}_${scalerParameters[k].std.toFixed(4)}_${scalerParameters[k].min.toFixed(4)}_${scalerParameters[k].max.toFixed(4)}`,
      )
      .join('|');
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Computes a canonical SHA-256 content-derived version identifier for scaler parameters.
   */
  public static computeVersion(
    scalerParameters: Record<string, { mean: number; std: number; min: number; max: number }>,
  ): string {
    const keys = Object.keys(scalerParameters).sort();
    if (keys.length === 0) return 'scaler-v2-empty';
    const hash = this.computeScalerHash(scalerParameters).substring(0, 12);
    return `scaler-v2-${hash}`;
  }

  /**
   * Fits normalization parameters (mean, std, min, max) EXCLUSIVELY on the training fold.
   * Ensures zero future-data leakage into scaling parameters.
   */
  public fit(trainingData: (IDatasetSample | TradingExperience | TrainingExample)[]): void {
    this.featureStats.clear();
    if (!trainingData || trainingData.length === 0) return;

    // Collect values per feature
    const featureValuesMap = new Map<string, number[]>();

    for (const item of trainingData) {
      const feats = 'features' in item ? item.features : item.marketState?.quant;
      if (!feats || typeof feats !== 'object') continue;

      if (Array.isArray(feats)) {
        const names = (item as any).featureNames || [];
        for (let idx = 0; idx < feats.length; idx++) {
          const val = feats[idx];
          const key = names[idx] || String(idx);
          if (typeof val === 'number' && Number.isFinite(val)) {
            if (!featureValuesMap.has(key)) {
              featureValuesMap.set(key, []);
            }
            featureValuesMap.get(key)!.push(val);
          }
        }
      } else {
        for (const [key, val] of Object.entries(feats)) {
          if (typeof val === 'number' && Number.isFinite(val)) {
            if (!featureValuesMap.has(key)) {
              featureValuesMap.set(key, []);
            }
            featureValuesMap.get(key)!.push(val);
          }
        }
      }
    }

    // Compute stats per feature
    for (const [featureName, values] of featureValuesMap.entries()) {
      if (values.length === 0) continue;

      const n = values.length;
      const sum = values.reduce((a, b) => a + b, 0);
      const mean = sum / n;
      const variance =
        n > 1 ? values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (n - 1) : 0;
      const std = Math.sqrt(variance) || 1e-6; // Avoid div zero

      let min = Infinity;
      let max = -Infinity;
      for (const v of values) {
        if (v < min) min = v;
        if (v > max) max = v;
      }

      this.featureStats.set(featureName, { mean, std, min, max });
    }
  }

  /**
   * Transforms feature values using pre-computed training parameters.
   * Standardizes values (z-score: (x - mean) / std).
   */
  public transformValue(featureName: string, rawValue: number): number {
    const stats = this.featureStats.get(featureName);
    if (!stats) return rawValue;
    if (stats.std < 1e-5) return 0;
    return (rawValue - stats.mean) / stats.std;
  }

  /**
   * Transforms a map of features using pre-computed training parameters.
   */
  public transform(features: Record<string, number>): Record<string, number> {
    const scaled: Record<string, number> = {};
    for (const [key, val] of Object.entries(features)) {
      if (typeof val === 'number') {
        scaled[key] = this.transformValue(key, val);
      }
    }
    return scaled;
  }

  public getParams(featureName: string): IScaleParameters | undefined {
    return this.featureStats.get(featureName);
  }

  public getParameters(): Record<string, IScaleParameters> {
    const params: Record<string, IScaleParameters> = {};
    for (const [k, v] of this.featureStats.entries()) {
      params[k] = v;
    }
    return params;
  }

  public getScalerHash(): string {
    return TemporalFeatureScaler.computeScalerHash(this.getParameters());
  }

  public getVersion(): string {
    return TemporalFeatureScaler.computeVersion(this.getParameters());
  }
}
