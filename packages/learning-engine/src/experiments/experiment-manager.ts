import { IExperimentRecord } from './experiment-result';

export class QuantExperimentManager {
  private experiments: Map<string, IExperimentRecord> = new Map();

  registerExperiment(record: IExperimentRecord): void {
    this.experiments.set(record.experimentId, record);
  }

  getExperiment(experimentId: string): IExperimentRecord | undefined {
    return this.experiments.get(experimentId);
  }

  listExperiments(): IExperimentRecord[] {
    return Array.from(this.experiments.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  getBestExperimentByOOSExpectancy(): IExperimentRecord | undefined {
    const list = this.listExperiments().filter((e) => e.isRobust);
    if (list.length === 0) return undefined;
    return list.sort((a, b) => b.oosMetrics.expectancyR - a.oosMetrics.expectancyR)[0];
  }
}
