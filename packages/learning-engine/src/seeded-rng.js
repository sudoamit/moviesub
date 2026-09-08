"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SeededRNG = void 0;
/**
 * Mulberry32 deterministic pseudo-random number generator.
 * Produces reproducible floating point values in [0, 1) for a given integer seed.
 */
class SeededRNG {
    state;
    constructor(seed) {
        this.state = seed >>> 0;
    }
    /**
     * Returns pseudo-random float in range [0, 1)
     */
    next() {
        let t = (this.state += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    /**
     * Returns pseudo-random integer in range [min, max]
     */
    nextInt(min, max) {
        return Math.floor(this.next() * (max - min + 1)) + min;
    }
    /**
     * Generates Gaussian (normal) random number using Box-Muller transform
     */
    nextGaussian(mean = 0, stdDev = 1) {
        const u1 = Math.max(1e-15, this.next());
        const u2 = this.next();
        const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
        return mean + z0 * stdDev;
    }
}
exports.SeededRNG = SeededRNG;
//# sourceMappingURL=seeded-rng.js.map