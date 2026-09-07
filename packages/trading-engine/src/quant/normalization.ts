export interface FeatureNormalizationMetadata {
  method: 'zscore' | 'percentile' | 'minmax' | 'robust' | 'expanding';
  window?: number;
  fittedUntil: Date;
}

export class NormalizationEngine {
  /**
   * Rolling Z-Score Normalization.
   * Only uses history <= current index to prevent look-ahead bias.
   */
  public static rollingZScore(
    values: number[],
    window = 20,
    clampRange: [number, number] = [-3.0, 3.0],
  ): number {
    if (!values || values.length === 0) return 0;
    const n = values.length;
    const slice = values.slice(-window);
    const current = values[n - 1];

    if (slice.length < 2) return 0;

    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (slice.length - 1);
    const std = Math.sqrt(variance);

    if (std <= 1e-8) return 0;
    const rawZ = (current - mean) / std;
    return Math.max(clampRange[0], Math.min(clampRange[1], rawZ));
  }

  /**
   * Rolling Min-Max Normalization to [0.0, 1.0].
   */
  public static rollingMinMax(values: number[], window = 20): number {
    if (!values || values.length === 0) return 0.5;
    const slice = values.slice(-window);
    const current = values[values.length - 1];

    let min = Infinity;
    let max = -Infinity;

    for (const v of slice) {
      if (v < min) min = v;
      if (v > max) max = v;
    }

    if (max - min <= 1e-8) return 0.5;
    const scaled = (current - min) / (max - min);
    return Math.max(0.0, Math.min(1.0, scaled));
  }

  /**
   * Rolling Percentile Rank Normalization to [0.0, 1.0].
   */
  public static rollingPercentileRank(values: number[], window = 30): number {
    if (!values || values.length === 0) return 0.5;
    const slice = values.slice(-window);
    const current = values[values.length - 1];

    if (slice.length === 0) return 0.5;
    const countBelow = slice.filter((v) => v <= current).length;
    return Math.max(0.0, Math.min(1.0, countBelow / slice.length));
  }

  /**
   * Robust Scaling using Median and Interquartile Range (IQR).
   */
  public static rollingRobustScale(values: number[], window = 30): number {
    if (!values || values.length < 4) return 0;
    const slice = values.slice(-window).sort((a, b) => a - b);
    const current = values[values.length - 1];

    const q25 = slice[Math.floor(slice.length * 0.25)];
    const median = slice[Math.floor(slice.length * 0.5)];
    const q75 = slice[Math.floor(slice.length * 0.75)];
    const iqr = q75 - q25;

    if (iqr <= 1e-8) return 0;
    const robustZ = (current - median) / iqr;
    return Math.max(-3.0, Math.min(3.0, robustZ));
  }

  /**
   * Normalizes a continuous value to [0.0, 1.0] using standard sigmoid / logistic curve.
   */
  public static sigmoid(val: number, scale = 1.0): number {
    return 1.0 / (1.0 + Math.exp(-val * scale));
  }
}
