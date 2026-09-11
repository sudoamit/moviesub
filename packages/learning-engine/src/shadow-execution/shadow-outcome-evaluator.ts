import { createHash, randomUUID } from 'crypto';
import { canonicalJsonStringify } from '../canonical-serializer';
import { deepFreeze } from '../champion-challenger/evaluation-identity';
import {
  ShadowOutcome,
  ShadowOutcomeStatus,
  ShadowFill,
  TradingDecision,
  ChampionChallengerDecisionPair
} from './types';

export interface OutcomeAttributionParams {
  readonly outcomeId?: string;
  readonly decision: TradingDecision;
  readonly pair?: ChampionChallengerDecisionPair;
  readonly outcomeStartTimestamp: number;
  readonly outcomeEndTimestamp: number;
  readonly entryFill?: ShadowFill;
  readonly exitFill?: ShadowFill;
  readonly grossPnL: number;
  readonly fees: number;
  readonly slippage: number;
  readonly netPnL: number;
  readonly maxFavorableExcursion: number;
  readonly maxAdverseExcursion: number;
  readonly holdingDurationMs: number;
  readonly exitReason: string;
  readonly outcomeStatus?: ShadowOutcomeStatus;
}

/**
 * Computes a cryptographic SHA-256 hash covering the outcome attribution results.
 */
export function computeOutcomeHash(params: {
  decisionId: string;
  pairId?: string;
  outcomeStartTimestamp: number;
  outcomeEndTimestamp: number;
  grossPnL: number;
  fees: number;
  slippage: number;
  netPnL: number;
  maxFavorableExcursion: number;
  maxAdverseExcursion: number;
  exitReason: string;
}): string {
  const payload = {
    decisionId: params.decisionId,
    pairId: params.pairId ?? 'standalone',
    outcomeStartTimestamp: params.outcomeStartTimestamp,
    outcomeEndTimestamp: params.outcomeEndTimestamp,
    grossPnL: params.grossPnL,
    fees: params.fees,
    slippage: params.slippage,
    netPnL: params.netPnL,
    maxFavorableExcursion: params.maxFavorableExcursion,
    maxAdverseExcursion: params.maxAdverseExcursion,
    exitReason: params.exitReason,
  };
  return createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex');
}

/**
 * ShadowOutcomeEvaluator
 *
 * Evaluates hypothetical outcome attribution for shadow positions as future market data unfolds.
 * CRITICAL INVARIANT: The future data is used ONLY to compute ShadowOutcome; it NEVER leaks back into
 * or mutates the original DecisionContext or DecisionPair.
 */
export class ShadowOutcomeEvaluator {
  /**
   * Constructs an immutable ShadowOutcome record.
   */
  public static attributeOutcome(params: OutcomeAttributionParams): ShadowOutcome {
    if (!params.decision || !params.decision.decisionId) {
      throw new Error('INVALID_OUTCOME_ATTRIBUTION: decision is required');
    }

    if (params.outcomeStartTimestamp > params.outcomeEndTimestamp) {
      throw new Error('INVALID_OUTCOME_ATTRIBUTION: outcomeStartTimestamp must be <= outcomeEndTimestamp');
    }

    const outcomeId = params.outcomeId || `out_${randomUUID()}`;
    const pairId = params.pair?.pairId || 'standalone';
    const outcomeHash = computeOutcomeHash({
      decisionId: params.decision.decisionId,
      pairId,
      outcomeStartTimestamp: params.outcomeStartTimestamp,
      outcomeEndTimestamp: params.outcomeEndTimestamp,
      grossPnL: params.grossPnL,
      fees: params.fees,
      slippage: params.slippage,
      netPnL: params.netPnL,
      maxFavorableExcursion: params.maxFavorableExcursion,
      maxAdverseExcursion: params.maxAdverseExcursion,
      exitReason: params.exitReason,
    });

    const outcome: ShadowOutcome = {
      outcomeId,
      decisionId: params.decision.decisionId,
      pairId,
      outcomeStartTimestamp: params.outcomeStartTimestamp,
      outcomeEndTimestamp: params.outcomeEndTimestamp,
      entryFill: params.entryFill ? { ...params.entryFill } : undefined,
      exitFill: params.exitFill ? { ...params.exitFill } : undefined,
      grossPnL: params.grossPnL,
      fees: params.fees,
      slippage: params.slippage,
      netPnL: params.netPnL,
      maxFavorableExcursion: params.maxFavorableExcursion,
      maxAdverseExcursion: params.maxAdverseExcursion,
      holdingDurationMs: params.holdingDurationMs,
      exitReason: params.exitReason,
      outcomeStatus: params.outcomeStatus || 'EVALUATED',
      outcomeHash,
    };

    return deepFreeze(outcome);
  }
}
