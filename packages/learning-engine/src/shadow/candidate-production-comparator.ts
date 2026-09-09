import { createHash } from 'crypto';
import { CandidateProductionComparison, DriftEvent, ShadowSignalSnapshot } from './shadow-types';

export class CandidateProductionComparator {
  /**
   * Compares candidate strategy signal with production strategy signal evaluated on the exact same market observation.
   */
  public static compareSignals(
    candidateId: string,
    marketTimestamp: number,
    candidateSignal: ShadowSignalSnapshot,
    productionSignal: ShadowSignalSnapshot,
    timestamp = Date.now(),
  ): {
    comparison: CandidateProductionComparison;
    divergenceEvent?: DriftEvent;
  } {
    const directionMatch = candidateSignal.direction === productionSignal.direction;
    const candConf = candidateSignal.confidence ?? 0.5;
    const prodConf = productionSignal.confidence ?? 0.5;
    const confidenceDelta = Number(Math.abs(candConf - prodConf).toFixed(4));

    const comparison: CandidateProductionComparison = {
      timestamp,
      marketTimestamp,
      candidateSignal,
      productionSignal,
      directionMatch,
      confidenceDelta,
    };

    let divergenceEvent: DriftEvent | undefined;

    // Detect major divergence (e.g. Opposite Direction: LONG vs SHORT)
    if (
      (candidateSignal.direction === 'LONG' && productionSignal.direction === 'SHORT') ||
      (candidateSignal.direction === 'SHORT' && productionSignal.direction === 'LONG')
    ) {
      const rawPayload = `${candidateId}|CANDIDATE_VS_PRODUCTION|OPPOSITE_DIRECTION|${marketTimestamp}`;
      const evidenceHash = createHash('sha256').update(rawPayload).digest('hex');
      const id = `drift-diverge-${candidateId}-${marketTimestamp}-${evidenceHash.slice(0, 8)}`;

      divergenceEvent = {
        id,
        candidateId,
        timestamp,
        marketTimestamp,
        type: 'CANDIDATE_VS_PRODUCTION',
        severity: 'INFO',
        metric: 'signal_direction_divergence',
        baselineValue: 1.0, // 1.0 = agreement
        observedValue: 0.0, // 0.0 = opposition
        threshold: 0.5,
        windowStart: marketTimestamp,
        windowEnd: marketTimestamp,
        evidenceHash,
        details: `Signal direction opposition: Candidate issued ${candidateSignal.direction} while Production issued ${productionSignal.direction}`,
      };
    }

    return { comparison, divergenceEvent };
  }
}
