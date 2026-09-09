import { createHash } from 'crypto';
import { DriftEvent } from './shadow-types';

export interface FeatureDistributionReference {
  readonly featureName: string;
  readonly mean: number;
  readonly stdDev: number;
  readonly min: number;
  readonly max: number;
  readonly binEdges: readonly number[]; // e.g. 10 bin edges
  readonly binProbabilities: readonly number[]; // e.g. 0.1 for each of 10 bins
}

export interface FeatureDriftBaseline {
  readonly featureSchemaHash: string;
  readonly featureNames: readonly string[];
  readonly distributions: Record<string, FeatureDistributionReference>;
  readonly sampleCount: number;
}

export interface FeatureDriftThresholds {
  readonly minObservations: number; // e.g. 25
  readonly warningPsiThreshold: number; // e.g. 0.15
  readonly criticalPsiThreshold: number; // e.g. 0.25
}

export const DEFAULT_FEATURE_DRIFT_THRESHOLDS: FeatureDriftThresholds = {
  minObservations: 25,
  warningPsiThreshold: 0.15,
  criticalPsiThreshold: 0.25,
};

export class FeatureDriftDetector {
  /**
   * Computes Population Stability Index (PSI) between baseline reference distribution and observed shadow window distribution.
   */
  public static calculatePsi(
    observedValues: readonly number[],
    reference: FeatureDistributionReference,
  ): number {
    if (observedValues.length === 0 || !reference.binEdges || reference.binEdges.length === 0) {
      return 0;
    }

    // Fail closed on NaN or Infinity
    for (const val of observedValues) {
      if (typeof val !== 'number' || Number.isNaN(val) || !Number.isFinite(val)) {
        throw new Error('FEATURE_DATA_CORRUPT: Invalid non-finite feature value encountered during drift evaluation');
      }
    }

    const numBins = reference.binProbabilities.length;
    const binCounts = new Array(numBins).fill(0);
    const edges = reference.binEdges;

    for (const val of observedValues) {
      let placed = false;
      for (let i = 0; i < edges.length - 1; i++) {
        if (val >= edges[i] && (i === edges.length - 2 ? val <= edges[i + 1] : val < edges[i + 1])) {
          binCounts[i]++;
          placed = true;
          break;
        }
      }
      if (!placed) {
        if (val < edges[0]) {
          binCounts[0]++;
        } else {
          binCounts[numBins - 1]++;
        }
      }
    }

    const totalObserved = observedValues.length;
    let psi = 0;
    const eps = 0.0001; // Smoothing constant for zero-count bins

    for (let i = 0; i < numBins; i++) {
      const actualPct = Math.max(binCounts[i] / totalObserved, eps);
      const expectedPct = Math.max(reference.binProbabilities[i] || 1 / numBins, eps);
      psi += (actualPct - expectedPct) * Math.log(actualPct / expectedPct);
    }

    return Number(Math.max(0, psi).toFixed(4));
  }

  /**
   * Evaluates feature distribution drift across all candidate features in a shadow observation window.
   */
  public static evaluateFeatureDrift(
    candidateId: string,
    observedFeatureVectors: readonly (readonly number[])[],
    featureSchemaHash: string,
    baseline: FeatureDriftBaseline,
    thresholds: FeatureDriftThresholds = DEFAULT_FEATURE_DRIFT_THRESHOLDS,
    marketTimestamp = Date.now(),
    timestamp = Date.now(),
  ): DriftEvent[] {
    const events: DriftEvent[] = [];

    // 1. Schema Validation (Fail closed on schema mismatch)
    if (baseline.featureSchemaHash && featureSchemaHash !== baseline.featureSchemaHash) {
      throw new Error(
        `FEATURE_SCHEMA_MISMATCH: Shadow feature schema hash ${featureSchemaHash} does not match baseline ${baseline.featureSchemaHash}`,
      );
    }

    // 2. Minimum observation sample size
    if (observedFeatureVectors.length < thresholds.minObservations) {
      return events;
    }

    const featureNames = baseline.featureNames;
    const numFeatures = featureNames.length;

    // Transpose vectors into per-feature arrays
    const perFeatureValues: number[][] = Array.from({ length: numFeatures }, () => []);
    for (const vector of observedFeatureVectors) {
      if (vector.length !== numFeatures) {
        throw new Error(
          `FEATURE_DIMENSION_MISMATCH: Observed feature vector dimension ${vector.length} does not match expected ${numFeatures}`,
        );
      }
      for (let i = 0; i < numFeatures; i++) {
        perFeatureValues[i].push(vector[i]);
      }
    }

    // 3. Compute PSI for each feature
    for (let i = 0; i < numFeatures; i++) {
      const featName = featureNames[i];
      const distRef = baseline.distributions[featName];
      if (!distRef) continue;

      const psi = this.calculatePsi(perFeatureValues[i], distRef);

      if (psi >= thresholds.criticalPsiThreshold) {
        events.push(
          this.createEvent({
            candidateId,
            timestamp,
            marketTimestamp,
            type: 'FEATURE',
            severity: 'CRITICAL',
            metric: `psi_${featName}`,
            baselineValue: 0.05,
            observedValue: psi,
            threshold: thresholds.criticalPsiThreshold,
            windowStart: marketTimestamp - observedFeatureVectors.length * 900000,
            windowEnd: marketTimestamp,
            details: `Critical feature drift on '${featName}': PSI = ${psi.toFixed(3)} (threshold: ${thresholds.criticalPsiThreshold})`,
          }),
        );
      } else if (psi >= thresholds.warningPsiThreshold) {
        events.push(
          this.createEvent({
            candidateId,
            timestamp,
            marketTimestamp,
            type: 'FEATURE',
            severity: 'WARNING',
            metric: `psi_${featName}`,
            baselineValue: 0.05,
            observedValue: psi,
            threshold: thresholds.warningPsiThreshold,
            windowStart: marketTimestamp - observedFeatureVectors.length * 900000,
            windowEnd: marketTimestamp,
            details: `Warning feature drift on '${featName}': PSI = ${psi.toFixed(3)} (threshold: ${thresholds.warningPsiThreshold})`,
          }),
        );
      }
    }

    return events;
  }

  /**
   * Helper to construct a baseline reference distribution from a historical sample array.
   */
  public static buildFeatureBaseline(
    featureNames: readonly string[],
    featureSchemaHash: string,
    historicalSamples: readonly (readonly number[])[],
    numBins = 10,
  ): FeatureDriftBaseline {
    const distributions: Record<string, FeatureDistributionReference> = {};
    const sampleCount = historicalSamples.length;
    if (sampleCount === 0) {
      throw new Error('EMPTY_HISTORICAL_SAMPLES: Cannot build baseline from empty samples');
    }

    for (let featIdx = 0; featIdx < featureNames.length; featIdx++) {
      const featName = featureNames[featIdx];
      const values = historicalSamples.map((s) => s[featIdx]).filter((v) => typeof v === 'number' && Number.isFinite(v));
      if (values.length === 0) continue;

      const min = Math.min(...values);
      const max = Math.max(...values);
      const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
      const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
      const stdDev = Math.sqrt(variance);

      // Construct equal-width bin edges
      const step = (max - min) / numBins || 0.1;
      const binEdges: number[] = [];
      for (let b = 0; b <= numBins; b++) {
        binEdges.push(Number((min + b * step).toFixed(4)));
      }

      const binCounts = new Array(numBins).fill(0);
      for (const val of values) {
        let placed = false;
        for (let i = 0; i < numBins; i++) {
          if (val >= binEdges[i] && (i === numBins - 1 ? val <= binEdges[i + 1] : val < binEdges[i + 1])) {
            binCounts[i]++;
            placed = true;
            break;
          }
        }
        if (!placed) {
          if (val < binEdges[0]) binCounts[0]++;
          else binCounts[numBins - 1]++;
        }
      }
      const binProbabilities = binCounts.map((c) => Math.max(0.001, c / values.length));

      distributions[featName] = {
        featureName: featName,
        mean: Number(mean.toFixed(4)),
        stdDev: Number(stdDev.toFixed(4)),
        min: Number(min.toFixed(4)),
        max: Number(max.toFixed(4)),
        binEdges,
        binProbabilities,
      };
    }

    return {
      featureSchemaHash,
      featureNames,
      distributions,
      sampleCount,
    };
  }

  private static createEvent(params: {
    candidateId: string;
    timestamp: number;
    marketTimestamp: number;
    type: 'FEATURE';
    severity: 'INFO' | 'WARNING' | 'CRITICAL';
    metric: string;
    baselineValue: number;
    observedValue: number;
    threshold: number;
    windowStart: number;
    windowEnd: number;
    details?: string;
  }): DriftEvent {
    const rawPayload = `${params.candidateId}|${params.type}|${params.metric}|${params.severity}|${params.observedValue}|${params.marketTimestamp}`;
    const evidenceHash = createHash('sha256').update(rawPayload).digest('hex');
    const id = `drift-feat-${params.candidateId}-${params.metric}-${params.marketTimestamp}-${evidenceHash.slice(0, 8)}`;

    return {
      id,
      candidateId: params.candidateId,
      timestamp: params.timestamp,
      marketTimestamp: params.marketTimestamp,
      type: params.type,
      severity: params.severity,
      metric: params.metric,
      baselineValue: params.baselineValue,
      observedValue: params.observedValue,
      threshold: params.threshold,
      windowStart: params.windowStart,
      windowEnd: params.windowEnd,
      evidenceHash,
      details: params.details,
    };
  }
}
