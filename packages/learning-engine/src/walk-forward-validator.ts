import {
  StrategyCandidate,
  TradingExperience,
  WalkForwardFold,
  WalkForwardValidationResult,
} from './types';
import { CandidateEvaluator } from './candidate-evaluator';

export interface IWalkForwardOptions {
  numFolds?: number;
  embargoDays?: number;
}

export class WalkForwardValidator {
  /**
   * Performs chronological purged and embargoed walk-forward validation on strategy candidates.
   */
  public static validate(
    candidate: StrategyCandidate,
    experiences: TradingExperience[],
    options: IWalkForwardOptions = {},
  ): WalkForwardValidationResult {
    const numFolds = options.numFolds || 3;
    const n = experiences.length;

    if (n < numFolds * 6) {
      return {
        folds: [],
        meanInSampleExpectancy: 0,
        meanOutOfSampleExpectancy: 0,
        oosDegradationPct: 0,
        isRobust: false,
      };
    }

    // Sort chronologically
    const sorted = [...experiences].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    const foldSize = Math.floor(n / (numFolds + 1));
    const folds: WalkForwardFold[] = [];

    let totalIS = 0;
    let totalOOS = 0;

    for (let f = 0; f < numFolds; f++) {
      const trainStart = 0;
      const trainEnd = (f + 1) * foldSize;
      const testStart = trainEnd + 1; // 1-bar embargo
      const testEnd = Math.min(n - 1, testStart + foldSize);

      const trainSlice = sorted.slice(trainStart, trainEnd);
      const testSlice = sorted.slice(testStart, testEnd + 1);

      const isEval = CandidateEvaluator.evaluate(candidate, trainSlice);
      const oosEval = CandidateEvaluator.evaluate(candidate, testSlice);

      const isExp = isEval.candidateExpectancy;
      const oosExp = oosEval.candidateExpectancy;
      const wins = testSlice.filter((e) => e.outcome.status === 'WIN').length;
      const winRate =
        testSlice.length > 0 ? Number(((wins / testSlice.length) * 100).toFixed(1)) : 50;

      const passed = oosExp > 0 && oosExp >= isExp * 0.5; // OOS must retain at least 50% of IS expectancy

      folds.push({
        foldIndex: f + 1,
        trainRange: [
          new Date(trainSlice[0].timestamp),
          new Date(trainSlice[trainSlice.length - 1].timestamp),
        ],
        validateRange: [
          new Date(testSlice[0].timestamp),
          new Date(testSlice[testSlice.length - 1].timestamp),
        ],
        testRange: [
          new Date(testSlice[0].timestamp),
          new Date(testSlice[testSlice.length - 1].timestamp),
        ],
        inSampleExpectancy: isExp,
        outOfSampleExpectancy: oosExp,
        winRate,
        passed,
      });

      totalIS += isExp;
      totalOOS += oosExp;
    }

    const meanIS = Number((totalIS / numFolds).toFixed(2));
    const meanOOS = Number((totalOOS / numFolds).toFixed(2));
    const degradation = meanIS > 0 ? Number((((meanIS - meanOOS) / meanIS) * 100).toFixed(1)) : 0;
    const isRobust =
      meanOOS > 0.05 && folds.filter((f) => f.passed).length >= Math.ceil(numFolds * 0.65);

    return {
      folds,
      meanInSampleExpectancy: meanIS,
      meanOutOfSampleExpectancy: meanOOS,
      oosDegradationPct: Math.max(0, degradation),
      isRobust,
    };
  }
}
