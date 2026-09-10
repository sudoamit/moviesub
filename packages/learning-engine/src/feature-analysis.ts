import { CANONICAL_FEATURE_NAMES_V2 } from '@quant/trading-engine';
import { FeatureImportanceItem, TradingExperience, TrainingExample } from './types';

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
      for (const e of experiences as any[]) {
        const featVal =
          e.features?.[featName] ??
          e.marketState?.quant?.[featName] ??
          (e.marketState as any)?.[featName] ??
          0.5;
        featValues.push(typeof featVal === 'number' ? featVal : 0.5);
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
