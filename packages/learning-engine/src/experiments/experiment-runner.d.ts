import { IDatasetSplits } from '../dataset-manager';
import { IExperimentRecord } from './experiment-result';
export declare class ExperimentRunner {
    /**
     * Executes a reproducible quantitative experiment with train, validation, and OOS evaluation,
     * transaction cost stress testing (1x, 1.5x, 2x, 3x), and Monte Carlo simulation.
     */
    static runExperiment(name: string, splits: IDatasetSplits, parameters?: Record<string, any>, randomSeed?: number): IExperimentRecord;
    private static evaluatePartition;
    private static simulateMonteCarlo;
}
