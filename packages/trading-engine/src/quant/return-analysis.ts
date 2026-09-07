import { ReturnMetrics } from './quant-types';

export class ReturnAnalysisEngine {
  /**
   * Computes multi-bar returns, rolling moments, skewness, and kurtosis.
   * Pure point-in-time calculation using closes <= evaluation index.
   */
  public static calculate(closes: number[]): ReturnMetrics {
    if (!closes || closes.length < 2) {
      return {
        return1Bar: 0,
        return3Bar: 0,
        return5Bar: 0,
        return10Bar: 0,
        return20Bar: 0,
        return50Bar: 0,
        rollingMeanReturn: 0,
        rollingVariance: 0,
        returnSkewness: 0,
        returnKurtosis: 0,
      };
    }

    const n = closes.length;
    const currentClose = closes[n - 1];

    const getReturn = (barsBack: number): number => {
      if (n - 1 - barsBack < 0) return 0;
      const prev = closes[n - 1 - barsBack];
      if (prev <= 0) return 0;
      return (currentClose - prev) / prev;
    };

    const return1Bar = getReturn(1);
    const return3Bar = getReturn(3);
    const return5Bar = getReturn(5);
    const return10Bar = getReturn(10);
    const return20Bar = getReturn(20);
    const return50Bar = getReturn(50);

    // Compute rolling 1-bar returns for statistical moments over up to 50 bars
    const windowSize = Math.min(50, n - 1);
    const returns: number[] = [];
    for (let i = n - windowSize; i < n; i++) {
      const pPrev = closes[i - 1];
      const pCurr = closes[i];
      if (pPrev > 0) {
        returns.push((pCurr - pPrev) / pPrev);
      }
    }

    if (returns.length === 0) {
      return {
        return1Bar,
        return3Bar,
        return5Bar,
        return10Bar,
        return20Bar,
        return50Bar,
        rollingMeanReturn: 0,
        rollingVariance: 0,
        returnSkewness: 0,
        returnKurtosis: 0,
      };
    }

    // Mean return
    const sum = returns.reduce((acc, val) => acc + val, 0);
    const mean = sum / returns.length;

    // Variance
    let sumSqDiff = 0;
    let sumCubeDiff = 0;
    let sumQuadDiff = 0;

    for (const r of returns) {
      const diff = r - mean;
      sumSqDiff += diff * diff;
      sumCubeDiff += diff * diff * diff;
      sumQuadDiff += diff * diff * diff * diff;
    }

    const m2 = sumSqDiff / returns.length;
    const variance = m2;
    const std = Math.sqrt(m2);

    // Skewness
    let skewness = 0;
    if (std > 1e-8) {
      skewness = sumCubeDiff / returns.length / Math.pow(std, 3);
    }

    // Excess Kurtosis (Normal distribution = 0)
    let kurtosis = 0;
    if (std > 1e-8) {
      kurtosis = sumQuadDiff / returns.length / Math.pow(std, 4) - 3.0;
    }

    return {
      return1Bar: Number(return1Bar.toFixed(6)),
      return3Bar: Number(return3Bar.toFixed(6)),
      return5Bar: Number(return5Bar.toFixed(6)),
      return10Bar: Number(return10Bar.toFixed(6)),
      return20Bar: Number(return20Bar.toFixed(6)),
      return50Bar: Number(return50Bar.toFixed(6)),
      rollingMeanReturn: Number(mean.toFixed(6)),
      rollingVariance: Number(variance.toFixed(8)),
      returnSkewness: Number(skewness.toFixed(4)),
      returnKurtosis: Number(kurtosis.toFixed(4)),
    };
  }
}
