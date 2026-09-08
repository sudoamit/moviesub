import { MonteCarloSimulationResult } from './types';
export interface IMonteCarloOptions {
    iterations?: number;
    ruinThresholdDrawdownR?: number;
    slippageNoiseStdDevR?: number;
    seed?: number;
}
export declare class MonteCarloEngine {
    /**
     * Performs candidate-specific Monte Carlo simulations (trade order reshuffling, slippage noise, win/loss sequencing)
     * using a deterministic seeded PRNG.
     */
    static simulate(rMultiples: number[], options?: IMonteCarloOptions): MonteCarloSimulationResult;
}
