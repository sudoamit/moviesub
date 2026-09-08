import { IExperimentRecord } from './experiment-result';
export interface IExperimentComparison {
    baseline: IExperimentRecord;
    candidate: IExperimentRecord;
    deltaOOSExpectancyR: number;
    deltaWinRate: number;
    deltaSharpe: number;
    deltaMaxDrawdown: number;
    isCandidateSuperior: boolean;
    verdict: string;
}
export declare class ExperimentComparator {
    /**
     * Statistically compares candidate experiment against production baseline
     */
    static compare(baseline: IExperimentRecord, candidate: IExperimentRecord): IExperimentComparison;
}
