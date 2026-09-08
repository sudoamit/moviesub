import { IExperimentRecord } from './experiment-result';
export declare class QuantExperimentManager {
    private experiments;
    registerExperiment(record: IExperimentRecord): void;
    getExperiment(experimentId: string): IExperimentRecord | undefined;
    listExperiments(): IExperimentRecord[];
    getBestExperimentByOOSExpectancy(): IExperimentRecord | undefined;
}
