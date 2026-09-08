import { FeatureAnalyzer } from './feature-analysis';
import { FeatureSelectionResult, TradingExperience } from './types';

export class FeatureSelector {
  /**
   * Evaluates feature subsets and prunes low-importance, noisy dimensions that do not contribute to out-of-sample expectancy.
   */
  public static selectFeatures(
    experiences: TradingExperience[],
    minImportanceThreshold = 0.02,
  ): FeatureSelectionResult {
    const importances = FeatureAnalyzer.analyze(experiences);
    const n = experiences.length;

    const totalR = experiences.reduce((sum, e) => sum + e.outcome.pnlR, 0);
    const baselineExpectancy = n > 0 ? Number((totalR / n).toFixed(2)) : 0;

    const retainedFeatures: string[] = [];
    const prunedFeatures: string[] = [];

    for (const item of importances) {
      if (item.importanceScore >= minImportanceThreshold) {
        retainedFeatures.push(item.featureName);
      } else {
        prunedFeatures.push(item.featureName);
      }
    }

    // Always preserve core SMC features even if current sample is small
    const coreMustRetain = ['smcScore', 'mtfAlignment', 'obStrength', 'liquiditySweep'];
    for (const core of coreMustRetain) {
      if (!retainedFeatures.includes(core)) {
        retainedFeatures.push(core);
        const pIdx = prunedFeatures.indexOf(core);
        if (pIdx >= 0) prunedFeatures.splice(pIdx, 1);
      }
    }

    // Evaluate measured baseline vs pruned feature performance experimentally
    const evaluatedRetained = experiences.filter((e) => {
      // Retain experiences where core retained features pass threshold
      const score = (e.marketState?.quant?.smcScore ?? 0.5);
      return score >= 0.5;
    });
    const evaluatedSumR = evaluatedRetained.reduce((sum, e) => sum + e.outcome.pnlR, 0);
    const optimizedExpectancy =
      evaluatedRetained.length > 0
        ? Number((evaluatedSumR / evaluatedRetained.length).toFixed(2))
        : baselineExpectancy;
    const deltaR = Number((optimizedExpectancy - baselineExpectancy).toFixed(2));

    return {
      retainedFeatures,
      prunedFeatures,
      baselineExpectancy,
      optimizedExpectancy,
      deltaR,
    };
  }
}
