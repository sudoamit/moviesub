import { LLMTradeAssessment, PointInTimeMarketSnapshot } from './quant-types';

export class LLMContextLayer {
  public static readonly PROMPT_VERSION = '2.0.0';
  public static readonly MODEL_VERSION = 'gemini-1.5-flash-quant';

  /**
   * Builds the structured JSON prompt for LLM qualitative context evaluation.
   */
  public static buildStructuredPrompt(snapshot: PointInTimeMarketSnapshot): string {
    const payload = {
      instrument: snapshot.instrument.symbol,
      assetType: snapshot.instrument.assetType,
      marketPrice: snapshot.marketPrice,
      timestamp: snapshot.timestamp.toISOString(),
      regime: snapshot.regime.regime,
      regimeConfidence: snapshot.regime.confidence,
      volatility: {
        currentAtr: snapshot.volatility.currentAtr,
        forecastVol: snapshot.volatility.forecastVolatility,
        percentile: snapshot.volatility.volatilityPercentile,
        bucket: snapshot.volatility.volatilityBucket,
        modelUsed: snapshot.volatility.modelUsed,
      },
      multiHorizon: {
        alignment: snapshot.multiHorizon.alignment,
        confluenceScore: snapshot.multiHorizon.confluenceScore,
        macroTrend: snapshot.multiHorizon.macro.trend,
        htfTrend: snapshot.multiHorizon.higherTimeframe.trend,
        execTrend: snapshot.multiHorizon.execution.trend,
      },
      quantScore: snapshot.score.totalScore,
      scoreGrade: snapshot.score.grade,
      scoreBreakdown: {
        structure: snapshot.score.structureScore,
        mtf: snapshot.score.mtfScore,
        liquidity: snapshot.score.liquidityScore,
        orderBlock: snapshot.score.obScore,
        fvg: snapshot.score.fvgScore,
        volume: snapshot.score.volumeScore,
        momentum: snapshot.score.momentumScore,
        regime: snapshot.score.regimeScore,
        volatility: snapshot.score.volatilityScore,
        riskReward: snapshot.score.riskRewardScore,
      },
      mlPrediction: snapshot.ml
        ? {
            probabilityWin: snapshot.ml.probabilityWin,
            expectedR: snapshot.ml.expectedR,
            confidence: snapshot.ml.confidence,
          }
        : null,
      topRankingFactors: snapshot.score.rankingRationale.slice(0, 5),
    };

    return JSON.stringify(payload, null, 2);
  }

  /**
   * Deterministic fallback assessment if LLM is offline or disabled.
   */
  public static getDeterministicFallback(snapshot: PointInTimeMarketSnapshot): LLMTradeAssessment {
    const isApproved =
      snapshot.score.totalScore >= 75 && snapshot.multiHorizon.alignment !== 'CONFLICTED';
    const isWait =
      snapshot.multiHorizon.alignment === 'CONFLICTED' ||
      snapshot.regime.regime === 'HIGH_VOLATILITY';

    return {
      decision: isApproved ? 'APPROVE' : isWait ? 'WAIT' : 'REJECT',
      confidence: snapshot.score.totalScore,
      concerns:
        snapshot.multiHorizon.alignment === 'CONFLICTED'
          ? ['Multi-timeframe order flow conflict detected across Macro and Execution timeframes']
          : snapshot.regime.regime === 'HIGH_VOLATILITY'
            ? ['Elevated market volatility shock - requires wider structural buffers']
            : [],
      supportingFactors: snapshot.score.rankingRationale.slice(0, 3),
      contradictoryFactors: [],
      marketContext: `Deterministic Evaluation: ${snapshot.instrument.symbol} in ${snapshot.regime.regime} regime (${snapshot.volatility.volatilityBucket} volatility).`,
      requiresHumanReview: false,
      modelVersion: this.MODEL_VERSION,
      promptVersion: this.PROMPT_VERSION,
    };
  }

  /**
   * Safely parses and validates an LLM assessment response.
   */
  public static parseAssessment(
    rawJson: string,
    snapshot: PointInTimeMarketSnapshot,
  ): LLMTradeAssessment {
    try {
      const parsed = JSON.parse(rawJson);
      if (
        parsed &&
        (parsed.decision === 'APPROVE' ||
          parsed.decision === 'REJECT' ||
          parsed.decision === 'WAIT')
      ) {
        return {
          decision: parsed.decision,
          confidence: Number(parsed.confidence) || 75,
          concerns: Array.isArray(parsed.concerns) ? parsed.concerns : [],
          supportingFactors: Array.isArray(parsed.supportingFactors)
            ? parsed.supportingFactors
            : [],
          contradictoryFactors: Array.isArray(parsed.contradictoryFactors)
            ? parsed.contradictoryFactors
            : [],
          marketContext: String(parsed.marketContext || 'LLM contextual analysis complete.'),
          requiresHumanReview: Boolean(parsed.requiresHumanReview),
          modelVersion: this.MODEL_VERSION,
          promptVersion: this.PROMPT_VERSION,
        };
      }
    } catch {}

    return this.getDeterministicFallback(snapshot);
  }
}
