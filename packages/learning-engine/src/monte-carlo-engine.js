"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MonteCarloEngine = void 0;
const seeded_rng_1 = require("./seeded-rng");
class MonteCarloEngine {
    /**
     * Performs candidate-specific Monte Carlo simulations (trade order reshuffling, slippage noise, win/loss sequencing)
     * using a deterministic seeded PRNG.
     */
    static simulate(rMultiples, options = {}) {
        const iterations = options.iterations || 1000;
        const ruinThreshold = options.ruinThresholdDrawdownR || 20.0;
        const noiseStd = options.slippageNoiseStdDevR || 0.05;
        const seed = options.seed !== undefined ? options.seed : 42;
        const rng = new seeded_rng_1.SeededRNG(seed);
        if (!rMultiples || rMultiples.length === 0) {
            throw new Error('INSUFFICIENT_CANDIDATE_EXECUTION_RESULTS');
        }
        const n = rMultiples.length;
        const maxDrawdowns = [];
        const finalExpectancies = [];
        let ruinCount = 0;
        for (let iter = 0; iter < iterations; iter++) {
            // Reshuffle sample with replacement (Bootstrap) + apply Gaussian slippage noise via SeededRNG
            let runningR = 0;
            let peakR = 0;
            let maxDD = 0;
            for (let i = 0; i < n; i++) {
                const randIdx = rng.nextInt(0, n - 1);
                const baseR = rMultiples[randIdx];
                const noise = rng.nextGaussian(0, noiseStd);
                const noisyR = baseR + noise;
                runningR += noisyR;
                if (runningR > peakR)
                    peakR = runningR;
                const dd = peakR - runningR;
                if (dd > maxDD)
                    maxDD = dd;
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
        const isRobust = probabilityOfRuin <= 0.01 && maxDrawdown95Pct < ruinThreshold && medianExpectancyR > 0;
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
exports.MonteCarloEngine = MonteCarloEngine;
//# sourceMappingURL=monte-carlo-engine.js.map