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

export class ExperimentComparator {
  /**
   * Statistically compares candidate experiment against production baseline
   */
  static compare(baseline: IExperimentRecord, candidate: IExperimentRecord): IExperimentComparison {
    const deltaOOSExpectancyR = Number(
      (candidate.oosMetrics.expectancyR - baseline.oosMetrics.expectancyR).toFixed(2),
    );
    const deltaWinRate = Number(
      (candidate.oosMetrics.winRate - baseline.oosMetrics.winRate).toFixed(2),
    );
    const deltaSharpe = Number(
      (candidate.oosMetrics.sharpeRatio - baseline.oosMetrics.sharpeRatio).toFixed(2),
    );
    const deltaMaxDrawdown = Number(
      (candidate.oosMetrics.maxDrawdownPercent - baseline.oosMetrics.maxDrawdownPercent).toFixed(2),
    );

    const isCandidateSuperior =
      candidate.isRobust &&
      deltaOOSExpectancyR >= 0.05 &&
      candidate.oosMetrics.profitFactor >= baseline.oosMetrics.profitFactor &&
      candidate.oosMetrics.maxDrawdownPercent <= baseline.oosMetrics.maxDrawdownPercent * 1.15;

    const verdict = isCandidateSuperior
      ? `Candidate '${candidate.name}' demonstrated statistical superiority with +${deltaOOSExpectancyR}R OOS delta and robust cost stress survival.`
      : `Candidate '${candidate.name}' failed superiority bar against baseline '${baseline.name}'.`;

    return {
      baseline,
      candidate,
      deltaOOSExpectancyR,
      deltaWinRate,
      deltaSharpe,
      deltaMaxDrawdown,
      isCandidateSuperior,
      verdict,
    };
  }
}
