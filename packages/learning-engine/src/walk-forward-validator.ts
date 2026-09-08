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

    const foldSize = Math.floor(n / (numFolds + 2)); // Divide into train, val, oos chunks
    const folds: WalkForwardFold[] = [];

    let totalIS = 0;
    let totalOOS = 0;

    for (let f = 0; f < numFolds; f++) {
      const trainStart = 0;
      const trainEnd = (f + 1) * foldSize;
      const valStart = trainEnd + 1; // 1-bar embargo
      const valEnd = Math.min(n - 1, valStart + Math.max(1, Math.floor(foldSize / 2)));
      const testStart = valEnd + 1; // 1-bar embargo
      const testEnd = Math.min(n - 1, testStart + foldSize);

      const trainSlice = sorted.slice(trainStart, trainEnd);
      const valSlice = sorted.slice(valStart, valEnd + 1);
      const testSlice = sorted.slice(testStart, testEnd + 1);

      if (trainSlice.length === 0 || testSlice.length === 0) continue;

      // 1. Train fold: evaluate candidate on expanding training window
      const isEval = CandidateEvaluator.evaluate(candidate, trainSlice);
      // 2. Validation fold: validate tuning
      const valEval = CandidateEvaluator.evaluate(candidate, valSlice.length > 0 ? valSlice : trainSlice);
      // 3. OOS fold: evaluate frozen candidate out-of-sample
      const oosEval = CandidateEvaluator.evaluate(candidate, testSlice);

      const isExp = isEval.candidateExpectancy;
      const oosExp = oosEval.candidateExpectancy;
      const wins = testSlice.filter((e) => e.outcome.status === 'WIN').length;
      const winRate =
        testSlice.length > 0 ? Number(((wins / testSlice.length) * 100).toFixed(1)) : 50;

      const passed = oosExp > 0 && oosExp >= isExp * 0.5 && oosEval.totalSimulatedTrades > 0;

      folds.push({
        foldIndex: f + 1,
        trainRange: [
          new Date(trainSlice[0].timestamp),
          new Date(trainSlice[trainSlice.length - 1].timestamp),
        ],
        validateRange: [
          new Date(valSlice[0]?.timestamp || trainSlice[0].timestamp),
          new Date(valSlice[valSlice.length - 1]?.timestamp || trainSlice[trainSlice.length - 1].timestamp),
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

    const effectiveFolds = folds.length || 1;
    const meanIS = Number((totalIS / effectiveFolds).toFixed(2));
    const meanOOS = Number((totalOOS / effectiveFolds).toFixed(2));
    const degradation = meanIS > 0 ? Number((((meanIS - meanOOS) / meanIS) * 100).toFixed(1)) : 0;
    const isRobust =
      meanOOS > 0.05 && folds.filter((f) => f.passed).length >= Math.ceil(effectiveFolds * 0.65);

    return {
      folds,
      meanInSampleExpectancy: meanIS,
      meanOutOfSampleExpectancy: meanOOS,
      oosDegradationPct: Math.max(0, degradation),
      isRobust,
    };
  }
}
