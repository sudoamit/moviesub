import { CANONICAL_FEATURE_NAMES_V2 } from '@quant/trading-engine';
import { FeatureImportanceItem, TradingExperience, TrainingExample } from './types';
import { ModelTrainer } from './model-trainer';

export class FeatureAnalyzer {
  /**
   * Computes empirical feature correlation / importance against realized trade outcome R.
   */
  public static analyze(
    experiences: (TradingExperience | TrainingExample)[],
    historicalImportances?: Map<string, number>,
  ): FeatureImportanceItem[] {
    if (experiences.length < 10) {
      return CANONICAL_FEATURE_NAMES_V2.map((featureName, idx) => ({
        featureName,
        importanceScore: 1.0 / (idx + 1),
        rank: idx + 1,
        stabilityScore: 80,
        driftDetected: false,
      }));
    }

    const n = experiences.length;
    const rMultiples = experiences.map((e: any) => e.outcome?.pnlR ?? e.outcomeR ?? e.labelContinuousR ?? 0);
    const meanR = rMultiples.reduce((a, b) => a + b, 0) / n;

    const featureScores: { name: string; score: number }[] = [];

    for (const featName of CANONICAL_FEATURE_NAMES_V2) {
      const featValues: number[] = [];
      let hasMissing = false;
      for (const e of experiences as any[]) {
        let featVal: number | undefined;
        if (Array.isArray(e.features)) {
          let names: readonly string[] | undefined = e.featureNames;
          if (!names || names.length !== e.features.length) {
            if (e.featureSchemaHash && e.features.length === CANONICAL_FEATURE_NAMES_V2.length) {
              const computed = ModelTrainer.computeFeatureSchemaHash(CANONICAL_FEATURE_NAMES_V2, '2.0');
              if (e.featureSchemaHash === computed) {
                names = CANONICAL_FEATURE_NAMES_V2;
              } else {
                throw new Error(`FEATURE_SCHEMA_MISMATCH: Experience '${e.id || e.exampleId}' schema hash ${e.featureSchemaHash} does not match canonical 2.0 schema hash ${computed}`);
              }
            } else {
              throw new Error(`MISSING_FEATURE_NAMES_PROVENANCE: Experience '${e.id || e.exampleId}' has array features without matching featureNames or valid canonical schema hash binding`);
            }
          }
          const idx = names.indexOf(featName);
          if (idx >= 0 && idx < e.features.length) {
            featVal = e.features[idx];
          }
        } else if (e.features && typeof e.features === 'object') {
          featVal = e.features[featName];
        } else if (e.marketState?.quant && typeof e.marketState.quant === 'object') {
          featVal = e.marketState.quant[featName];
        }

        if (featVal === undefined || featVal === null || typeof featVal !== 'number' || !Number.isFinite(featVal)) {
          if (e.features !== undefined || e.featureSchemaHash !== undefined || e.exampleId !== undefined) {
            throw new Error(`MISSING_FEATURE_VALUE: Experience '${e.id || e.exampleId}' lacks valid finite value for feature '${featName}'`);
          }
          hasMissing = true;
          break;
        }
        featValues.push(featVal);
      }
      if (hasMissing || featValues.length < n) {
        continue;
      }

      const meanF = featValues.reduce((a, b) => a + b, 0) / n;

      let cov = 0;
      let varF = 0;
      let varR = 0;

      for (let i = 0; i < n; i++) {
        const df = featValues[i] - meanF;
        const dr = rMultiples[i] - meanR;
        cov += df * dr;
        varF += df * df;
        varR += dr * dr;
      }

      const correlation = varF > 0 && varR > 0 ? cov / Math.sqrt(varF * varR) : 0;
      const importanceScore = Number(Math.abs(correlation).toFixed(4));
      featureScores.push({ name: featName, score: importanceScore });
    }

    // Rank descending
    featureScores.sort((a, b) => b.score - a.score);

    return featureScores.map((item, idx) => {
      const oldScore = historicalImportances?.get(item.name);
      let driftDetected = false;
      let stabilityScore = 85;

      if (oldScore !== undefined) {
        const diff = Math.abs(item.score - oldScore);
        if (diff > 0.3) {
          driftDetected = true;
          stabilityScore = 40;
        } else {
          stabilityScore = Math.round(100 - diff * 150);
        }
      }

      return {
        featureName: item.name,
        importanceScore: item.score,
        rank: idx + 1,
        stabilityScore,
        driftDetected,
      };
    });
  }
}
