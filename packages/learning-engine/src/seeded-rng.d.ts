/**
 * Mulberry32 deterministic pseudo-random number generator.
 * Produces reproducible floating point values in [0, 1) for a given integer seed.
 */
export declare class SeededRNG {
    private state;
    constructor(seed: number);
    /**
     * Returns pseudo-random float in range [0, 1)
     */
    next(): number;
    /**
     * Returns pseudo-random integer in range [min, max]
     */
    nextInt(min: number, max: number): number;
    /**
     * Generates Gaussian (normal) random number using Box-Muller transform
     */
    nextGaussian(mean?: number, stdDev?: number): number;
}
