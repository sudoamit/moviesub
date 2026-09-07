import { ICandle, ISwingPoint, MarketRegimeType } from '@quant/shared';
import {
  calculateADX,
  calculateATR,
  calculateBollingerBands,
  calculateEMA,
  calculateRSI,
} from '@quant/indicators';
import { RegimeState } from './quant-types';
import { VolatilityEngine } from './volatility-engine';

export interface IClusteringFeatureVector {
  trendStrength: number; // Normalized ADX [0, 1]
  directionalBias: number; // (+DI - -DI) / (+DI + -DI) [-1, 1]
  volatilityPercent: number; // ATR % / 5.0 [0, 1]
  bollingerWidth: number; // Bandwidth [0, 1]
  rsiMomentum: number; // (RSI - 50) / 50 [-1, 1]
  relativeVolume: number; // RVOL / 3.0 [0, 1]
}

export class RegimeClusteringEngine {
  /**
   * K-Means clustering algorithm for unsupervised regime discovery.
   */
  public static runKMeans(
    data: number[][],
    k = 4,
    maxIterations = 25,
  ): { centroids: number[][]; assignments: number[] } {
    if (!data || data.length === 0) {
      return { centroids: [], assignments: [] };
    }

    const d = data[0].length;
    const n = data.length;
    const actualK = Math.min(k, n);

    // Deterministic k-means++ style initialization
    const centroids: number[][] = [data[0]];
    while (centroids.length < actualK) {
      let maxDistSq = -1;
      let nextCentroid = data[0];

      for (const pt of data) {
        let minDistSqToAny = Infinity;
        for (const c of centroids) {
          let distSq = 0;
          for (let j = 0; j < d; j++) distSq += Math.pow(pt[j] - c[j], 2);
          if (distSq < minDistSqToAny) minDistSqToAny = distSq;
        }
        if (minDistSqToAny > maxDistSq) {
          maxDistSq = minDistSqToAny;
          nextCentroid = pt;
        }
      }
      centroids.push([...nextCentroid]);
    }

    let assignments = new Array(n).fill(0);

    for (let iter = 0; iter < maxIterations; iter++) {
      let changed = false;

      // Assignment step
      for (let i = 0; i < n; i++) {
        let bestCluster = 0;
        let bestDistSq = Infinity;

        for (let c = 0; c < actualK; c++) {
          let distSq = 0;
          for (let j = 0; j < d; j++) distSq += Math.pow(data[i][j] - centroids[c][j], 2);
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            bestCluster = c;
          }
        }

        if (assignments[i] !== bestCluster) {
          assignments[i] = bestCluster;
          changed = true;
        }
      }

      if (!changed) break;

      // Update centroids
      const counts = new Array(actualK).fill(0);
      const sums = Array.from({ length: actualK }, () => new Array(d).fill(0));

      for (let i = 0; i < n; i++) {
        const cluster = assignments[i];
        counts[cluster]++;
        for (let j = 0; j < d; j++) {
          sums[cluster][j] += data[i][j];
        }
      }

      for (let c = 0; c < actualK; c++) {
        if (counts[c] > 0) {
          for (let j = 0; j < d; j++) {
            centroids[c][j] = sums[c][j] / counts[c];
          }
        }
      }
    }

    return { centroids, assignments };
  }

  /**
   * Deterministically maps a centroid vector to a semantic MarketRegimeType.
   * Features: [trendStrength (0-1), directionalBias (-1 to 1), volatilityPercent (0-1), bollingerWidth (0-1), rsiMomentum (-1 to 1), relativeVolume (0-1)]
   */
  public static mapCentroidToRegime(centroid: number[]): MarketRegimeType {
    const trendStrength = centroid[0] ?? 0.3;
    const directionalBias = centroid[1] ?? 0;
    const volatilityPercent = centroid[2] ?? 0.3;
    const bollingerWidth = centroid[3] ?? 0.3;
    const rsiMomentum = centroid[4] ?? 0;

    // High Volatility shock
    if (volatilityPercent > 0.65 || bollingerWidth > 0.7) {
      return MarketRegimeType.HIGH_VOLATILITY;
    }

    // Strong Bullish Trend
    if (trendStrength > 0.35 && directionalBias > 0.15 && rsiMomentum > 0.1) {
      return MarketRegimeType.BULLISH_TREND;
    }

    // Strong Bearish Trend
    if (trendStrength > 0.35 && directionalBias < -0.15 && rsiMomentum < -0.1) {
      return MarketRegimeType.BEARISH_TREND;
    }

    // Low Volatility compression
    if (volatilityPercent < 0.2 && trendStrength < 0.25) {
      return MarketRegimeType.LOW_VOLATILITY;
    }

    // Default: Range
    return MarketRegimeType.RANGE;
  }

  /**
   * Classifies market regime by running K-Means clustering over rolling multi-feature observations.
   */
  public static classifyRegime(candles: ICandle[], swings: ISwingPoint[] = []): RegimeState {
    if (!candles || candles.length < 15) {
      return {
        regime: MarketRegimeType.RANGE,
        trendStrength: 20,
        volatilityPercentile: 50,
        confidence: 50,
        timestamp: new Date(),
      };
    }

    const n = candles.length;
    const lastCandle = candles[n - 1];
    const closes = candles.map((c) => c.close);

    const atrSeries = calculateATR(candles, 14);
    const adxResult = calculateADX(candles, 14);
    const bbSeries = calculateBollingerBands(closes, 20, 2);
    const rsiSeries = calculateRSI(closes, 14);

    // Build rolling feature matrix over last up to 60 candles
    const sampleWindow = Math.min(60, n - 20);
    const featureMatrix: number[][] = [];

    for (let i = n - sampleWindow; i < n; i++) {
      const c = candles[i];
      const atr = atrSeries[i] ?? c.high - c.low;
      const atrPct = c.close > 0 ? (atr / c.close) * 100 : 1.0;
      const adx = adxResult.adx[i] ?? 15;
      const plusDI = adxResult.plusDI[i] ?? 20;
      const minusDI = adxResult.minusDI[i] ?? 20;
      const diSum = Math.max(1, plusDI + minusDI);
      const directionalBias = (plusDI - minusDI) / diSum; // -1 to 1

      const bbUpper = bbSeries.upper[i];
      const bbLower = bbSeries.lower[i];
      const bbMiddle = bbSeries.middle[i];
      const bbWidth =
        bbUpper !== null && bbLower !== null && bbMiddle !== null && bbMiddle > 0
          ? Math.max(0, (bbUpper - bbLower) / bbMiddle)
          : 0.05;
      const rsi = rsiSeries[i] ?? 50;

      // RVOL
      let avgVol = c.volume;
      if (i >= 20) {
        let sumV = 0;
        for (let v = i - 20; v < i; v++) sumV += candles[v].volume;
        avgVol = sumV / 20;
      }
      const rvol = avgVol > 0 ? c.volume / avgVol : 1.0;

      featureMatrix.push([
        Math.min(1.0, adx / 50.0), // trendStrength
        Math.max(-1.0, Math.min(1.0, directionalBias)), // directionalBias
        Math.min(1.0, atrPct / 4.0), // volatilityPercent
        Math.min(1.0, bbWidth * 10.0), // bollingerWidth
        Math.max(-1.0, Math.min(1.0, (rsi - 50.0) / 50.0)), // rsiMomentum
        Math.min(1.0, rvol / 3.0), // relativeVolume
      ]);
    }

    if (featureMatrix.length < 5) {
      const fallbackAdx = adxResult.adx[n - 1] ?? 15;
      return {
        regime: MarketRegimeType.RANGE,
        trendStrength: Math.round(fallbackAdx),
        volatilityPercentile: 50,
        confidence: 60,
        timestamp: lastCandle.timestamp,
      };
    }

    // Run K-Means with 4 clusters
    const { centroids, assignments } = this.runKMeans(featureMatrix, 4, 20);
    const currentPoint = featureMatrix[featureMatrix.length - 1];

    // Find nearest centroid
    let nearestCluster = 0;
    let minDistSq = Infinity;

    for (let c = 0; c < centroids.length; c++) {
      let distSq = 0;
      for (let j = 0; j < currentPoint.length; j++) {
        distSq += Math.pow(currentPoint[j] - centroids[c][j], 2);
      }
      if (distSq < minDistSq) {
        minDistSq = distSq;
        nearestCluster = c;
      }
    }

    const mappedRegime = this.mapCentroidToRegime(centroids[nearestCluster]);
    const currentAdx = adxResult.adx[n - 1] ?? 20;

    // Volatility percentile
    const volState = VolatilityEngine.computeVolatilityState(candles);
    const confidence = Math.min(95, Math.max(50, Math.round(100 - minDistSq * 40)));

    return {
      regime: mappedRegime,
      clusterId: nearestCluster,
      probability: Number((confidence / 100).toFixed(2)),
      trendStrength: Math.min(100, Math.round(currentAdx * 1.5)),
      volatilityPercentile: volState.volatilityPercentile,
      confidence,
      timestamp: lastCandle.timestamp,
    };
  }
}
