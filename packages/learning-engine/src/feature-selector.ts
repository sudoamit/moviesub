import { CANONICAL_FEATURE_NAMES_V2 } from '@quant/trading-engine';
import { FeatureAnalyzer } from './feature-analysis';
import { FeatureSelectionResult, TradingExperience, TrainingExample } from './types';

export class FeatureSelector {
  /**
   * Evaluates feature subsets and prunes low-importance, noisy dimensions that do not contribute to out-of-sample expectancy.
   */
  public static selectFeatures(
    experiences: (TradingExperience | TrainingExample)[],
    minImportanceThreshold = 0.02,
  ): FeatureSelectionResult {
    const importances = FeatureAnalyzer.analyze(experiences);
    const n = experiences.length;

    const totalR = (experiences as any[]).reduce(
      (sum, e) => sum + (e.outcome?.pnlR ?? e.outcomeR ?? e.labelContinuousR ?? 0),
      0,
    );
    const baselineExpectancy = n > 0 ? Number((totalR / n).toFixed(2)) : 0;

    const retainedFeatures: string[] = [];
    const prunedFeatures: string[] = [];

    // Determine available features in experiences
    const availableFeatures = new Set<string>();
    for (const e of experiences as any[]) {
      const q = e.features ?? e.marketState?.quant;
      if (Array.isArray(q)) {
        for (const name of CANONICAL_FEATURE_NAMES_V2) availableFeatures.add(name);
        break;
      } else if (q && typeof q === 'object') {
        for (const k of Object.keys(q)) {
          if (typeof q[k] === 'number' && Number.isFinite(q[k])) {
            availableFeatures.add(k);
          }
        }
      }
    }

    for (const item of importances) {
      if (availableFeatures.size > 0 && !availableFeatures.has(item.featureName)) {
        continue;
      }
      if (item.importanceScore >= minImportanceThreshold) {
        retainedFeatures.push(item.featureName);
      } else {
        prunedFeatures.push(item.featureName);
      }
    }

    // Preserve core SMC features if present in dataset
    const coreMustRetain = ['smcScore', 'mtfAlignment', 'obStrength', 'liquiditySweep'];
    for (const core of coreMustRetain) {
      if (availableFeatures.size === 0 || availableFeatures.has(core)) {
        if (!retainedFeatures.includes(core)) {
          retainedFeatures.push(core);
          const pIdx = prunedFeatures.indexOf(core);
          if (pIdx >= 0) prunedFeatures.splice(pIdx, 1);
        }
      }
    }

    if (retainedFeatures.length === 0 && availableFeatures.size > 0) {
      retainedFeatures.push(...Array.from(availableFeatures));
    }

    // Evaluate feature subset performance experimentally on retained dimensions
    const evaluatedRetained = (experiences as any[]).filter((e) => {
      // Check if all core retained features meet signal quality criteria
      const quant = e.features ?? e.marketState?.quant ?? {};
      return retainedFeatures.every((fName) => {
        const val = quant[fName as keyof typeof quant];
        return val === undefined || typeof val !== 'number' || val >= 0.35;
      });
    });

    const evaluatedSumR = evaluatedRetained.reduce(
      (sum, e) => sum + (e.outcome?.pnlR ?? e.outcomeR ?? e.labelContinuousR ?? 0),
      0,
    );
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
