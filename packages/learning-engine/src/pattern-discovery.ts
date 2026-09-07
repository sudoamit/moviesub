import { DiscoveredPattern, TradingExperience } from './types';

export interface IPatternDiscoveryOptions {
  minSampleSize?: number; // default 20 for backtest / testing, 50+ for production
  minEffectSizeR?: number; // default 0.25R
  confidenceLevel?: number; // default 0.95
}

export class PatternDiscoveryEngine {
  /**
   * Mines multi-factor condition combinations to extract high-confidence positive patterns and negative filter candidates.
   */
  public static discover(
    experiences: TradingExperience[],
    options: IPatternDiscoveryOptions = {},
  ): DiscoveredPattern[] {
    const minSample = options.minSampleSize || 10;
    const minEffect = options.minEffectSizeR || 0.25;

    if (experiences.length < minSample) {
      return [];
    }

    const patterns: DiscoveredPattern[] = [];

    // Define predicates to evaluate on each experience
    const predicateDefs = [
      {
        name: 'HTF_ALIGNED',
        test: (e: TradingExperience) =>
          !e.failureReasons.includes('HTF_CONFLICT') &&
          e.marketState?.multiHorizon?.alignment === 'ALIGNED',
      },
      {
        name: 'LIQUIDITY_SWEPT',
        test: (e: TradingExperience) =>
          e.marketState?.smc?.liquiditySweeps?.length > 0 ||
          (e.marketState?.quant?.smcQuant?.liquiditySweepDepth || 0) > 0,
      },
      {
        name: 'TRENDING_REGIME',
        test: (e: TradingExperience) =>
          e.marketContext.regime === 'BULLISH_TREND' || e.marketContext.regime === 'BEARISH_TREND',
      },
      {
        name: 'HIGH_VOLATILITY',
        test: (e: TradingExperience) =>
          e.marketContext.regime === 'HIGH_VOLATILITY' ||
          e.marketContext.volatilityRegime === 'HIGH',
      },
      {
        name: 'HIGH_RVOL',
        test: (e: TradingExperience) =>
          (e.marketState?.quant?.momentum?.relativeVolume || 1.0) >= 1.3,
      },
      {
        name: 'DISPLACEMENT_CONFIRMED',
        test: (e: TradingExperience) =>
          (e.marketState?.quant?.smcQuant?.bosStrength || 0) >= 70 ||
          (e.marketState?.quant?.smcQuant?.chochStrength || 0) >= 70,
      },
      {
        name: 'OPTIMAL_DEALING_RANGE',
        test: (e: TradingExperience) => !e.failureReasons.includes('BAD_PREMIUM_DISCOUNT'),
      },
    ];

    // Evaluate individual and pairwise conjunctions
    const candidateConditions: { name: string; test: (e: TradingExperience) => boolean }[] = [];

    // Single conditions
    for (const p of predicateDefs) {
      candidateConditions.push(p);
    }

    // Pairwise conjunctions
    for (let i = 0; i < predicateDefs.length; i++) {
      for (let j = i + 1; j < predicateDefs.length; j++) {
        const p1 = predicateDefs[i];
        const p2 = predicateDefs[j];
        candidateConditions.push({
          name: `${p1.name} + ${p2.name}`,
          test: (e: TradingExperience) => p1.test(e) && p2.test(e),
        });
      }
    }

    // Triplet conjunctions for deep SMC confluence
    candidateConditions.push({
      name: 'HTF_ALIGNED + LIQUIDITY_SWEPT + HIGH_RVOL',
      test: (e: TradingExperience) =>
        predicateDefs[0].test(e) && predicateDefs[1].test(e) && predicateDefs[4].test(e),
    });
    candidateConditions.push({
      name: 'HTF_ALIGNED + TRENDING_REGIME + DISPLACEMENT_CONFIRMED',
      test: (e: TradingExperience) =>
        predicateDefs[0].test(e) && predicateDefs[2].test(e) && predicateDefs[5].test(e),
    });

    let patternIdCounter = 1;

    for (const cand of candidateConditions) {
      const matched = experiences.filter(cand.test);
      const sampleSize = matched.length;

      if (sampleSize < minSample) continue;

      const rMultiples = matched.map((m) => m.outcome.pnlR);
      const sumR = rMultiples.reduce((a, b) => a + b, 0);
      const meanR = sumR / sampleSize;

      // Sample variance & standard error
      const variance =
        sampleSize > 1
          ? rMultiples.reduce((sum, r) => sum + Math.pow(r - meanR, 2), 0) / (sampleSize - 1)
          : 1.0;
      const stdDev = Math.sqrt(variance);
      const standardError = stdDev / Math.sqrt(sampleSize);

      // 95% Confidence Interval for mean R: mean +/- 1.96 * SE
      const ciLower = Number((meanR - 1.96 * standardError).toFixed(3));
      const ciUpper = Number((meanR + 1.96 * standardError).toFixed(3));

      const wins = matched.filter((m) => m.outcome.status === 'WIN').length;
      const winRate = Number(((wins / sampleSize) * 100).toFixed(1));

      const grossProfit = matched
        .filter((m) => m.outcome.pnl > 0)
        .reduce((sum, m) => sum + m.outcome.pnl, 0);
      const grossLoss = matched
        .filter((m) => m.outcome.pnl < 0)
        .reduce((sum, m) => sum + Math.abs(m.outcome.pnl), 0);
      const profitFactor =
        grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 5.0 : 0.0;

      // Calculate max drawdown in R within matched sequence
      let peakR = 0;
      let runningR = 0;
      let maxDDR = 0;
      for (const r of rMultiples) {
        runningR += r;
        if (runningR > peakR) peakR = runningR;
        const dd = peakR - runningR;
        if (dd > maxDDR) maxDDR = dd;
      }
      const maxDrawdownPct = Number(maxDDR.toFixed(2));

      // Two-tailed t-statistic p-value approximation
      const tStat = standardError > 0 ? Math.abs(meanR) / standardError : 0;
      const pVal = Number(Math.exp(-0.717 * tStat - 0.416 * Math.pow(tStat, 2)).toFixed(4));

      // Robustness score combining sample size, expectancy, and t-statistic
      const robustnessScore = Math.min(
        100,
        Math.round(Math.min(1.0, sampleSize / 100) * 40 + Math.min(1.0, tStat / 3.0) * 60),
      );

      if (meanR >= minEffect && ciLower > 0) {
        // High-confidence POSITIVE pattern
        patterns.push({
          id: `pat-pos-${patternIdCounter++}`,
          type: 'POSITIVE_CONFLUENCE',
          conditions: cand.name.split(' + '),
          sampleSize,
          winRate,
          expectancy: Number(meanR.toFixed(2)),
          averageR: Number(meanR.toFixed(2)),
          profitFactor,
          maxDrawdownPct,
          confidenceInterval: [ciLower, ciUpper],
          pVal,
          robustnessScore,
        });
      } else if (meanR <= -minEffect && ciUpper < 0) {
        // High-confidence NEGATIVE filter pattern
        patterns.push({
          id: `pat-neg-${patternIdCounter++}`,
          type: 'NEGATIVE_FILTER',
          conditions: cand.name.split(' + '),
          sampleSize,
          winRate,
          expectancy: Number(meanR.toFixed(2)),
          averageR: Number(meanR.toFixed(2)),
          profitFactor,
          maxDrawdownPct,
          confidenceInterval: [ciLower, ciUpper],
          pVal,
          robustnessScore,
        });
      }
    }

    // Sort by statistical significance (pVal ascending)
    patterns.sort((a, b) => a.pVal - b.pVal);

    return patterns;
  }
}
