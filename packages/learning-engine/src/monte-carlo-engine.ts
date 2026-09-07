import { MonteCarloSimulationResult } from './types';

export interface IMonteCarloOptions {
  iterations?: number;
  ruinThresholdDrawdownR?: number; // default 20R drawdown = ruin
  slippageNoiseStdDevR?: number;
}

export class MonteCarloEngine {
  /**
   * Performs randomized Monte Carlo simulations (trade order reshuffling, slippage noise, win/loss sequencing).
   */
  public static simulate(
    rMultiples: number[],
    options: IMonteCarloOptions = {},
  ): MonteCarloSimulationResult {
    const iterations = options.iterations || 1000;
    const ruinThreshold = options.ruinThresholdDrawdownR || 20.0;
    const noiseStd = options.slippageNoiseStdDevR || 0.05;

    if (!rMultiples || rMultiples.length === 0) {
      return {
        iterations: 0,
        probabilityOfRuin: 0,
        expectedDrawdownPct: 0,
        maxDrawdown95Pct: 0,
        maxDrawdown99Pct: 0,
        medianExpectancyR: 0,
        isRobust: false,
      };
    }

    const n = rMultiples.length;
    const maxDrawdowns: number[] = [];
    const finalExpectancies: number[] = [];
    let ruinCount = 0;

    for (let iter = 0; iter < iterations; iter++) {
      // Reshuffle sample with replacement (Bootstrap) + apply Gaussian slippage noise
      let runningR = 0;
      let peakR = 0;
      let maxDD = 0;

      for (let i = 0; i < n; i++) {
        const randIdx = Math.floor(Math.random() * n);
        const baseR = rMultiples[randIdx];
        const noise = (Math.random() - 0.5) * 2 * noiseStd;
        const noisyR = baseR + noise;

        runningR += noisyR;
        if (runningR > peakR) peakR = runningR;
        const dd = peakR - runningR;
        if (dd > maxDD) maxDD = dd;
      }

      maxDrawdowns.push(maxDD);
      finalExpectancies.push(runningR / n);

      if (maxDD >= ruinThreshold) {
        ruinCount++;
      }
    }

    maxDrawdowns.sort((a, b) => a - b);
    finalExpectancies.sort((a, b) => a - b);

    const probabilityOfRuin = Number((ruinCount / iterations).toFixed(4));
    const meanDD = maxDrawdowns.reduce((a, b) => a + b, 0) / iterations;
    const expectedDrawdownPct = Number(meanDD.toFixed(2));

    const idx95 = Math.floor(iterations * 0.95);
    const idx99 = Math.floor(iterations * 0.99);
    const medianIdx = Math.floor(iterations * 0.5);

    const maxDrawdown95Pct = Number(maxDrawdowns[idx95].toFixed(2));
    const maxDrawdown99Pct = Number(maxDrawdowns[idx99].toFixed(2));
    const medianExpectancyR = Number(finalExpectancies[medianIdx].toFixed(2));

    const isRobust =
      probabilityOfRuin <= 0.01 && maxDrawdown95Pct < ruinThreshold && medianExpectancyR > 0;

    return {
      iterations,
      probabilityOfRuin,
      expectedDrawdownPct,
      maxDrawdown95Pct,
      maxDrawdown99Pct,
      medianExpectancyR,
      isRobust,
    };
  }
}
