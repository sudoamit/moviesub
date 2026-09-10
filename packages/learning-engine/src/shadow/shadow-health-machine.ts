import { DriftEvent, ShadowHealthState, ShadowStatus } from './shadow-types';

export interface HealthMachineConfig {
  readonly minObservationsForHealthy: number; // e.g. 30
  readonly minTradesForHealthy: number; // e.g. 10
  readonly requiredConsecutiveHealthyWindowsForRecovery: number; // e.g. 3
  readonly maxConsecutiveDegradedWindowsBeforeFailure: number; // e.g. 5
  readonly activeDriftLookbackMs?: number; // e.g. 3600000 (1 hour default)
}

export const DEFAULT_HEALTH_MACHINE_CONFIG: HealthMachineConfig = {
  minObservationsForHealthy: 30,
  minTradesForHealthy: 10,
  requiredConsecutiveHealthyWindowsForRecovery: 3,
  maxConsecutiveDegradedWindowsBeforeFailure: 5,
  activeDriftLookbackMs: 3600000,
};

const ALLOWED_TRANSITIONS: Record<ShadowStatus, readonly ShadowStatus[]> = {
  INSUFFICIENT_EVIDENCE: ['INSUFFICIENT_EVIDENCE', 'ACTIVE', 'HEALTHY', 'DEGRADED', 'CRITICAL', 'FAILED', 'STOPPED', 'REJECTED'],
  PENDING: ['PENDING', 'INSUFFICIENT_EVIDENCE', 'ACTIVE', 'STOPPED', 'REJECTED'],
  ACTIVE: ['ACTIVE', 'INSUFFICIENT_EVIDENCE', 'HEALTHY', 'DEGRADED', 'CRITICAL', 'FAILED', 'STOPPED', 'REJECTED'],
  HEALTHY: ['HEALTHY', 'DEGRADED', 'CRITICAL', 'FAILED', 'STOPPED', 'REJECTED'],
  DEGRADED: ['DEGRADED', 'HEALTHY', 'CRITICAL', 'FAILED', 'STOPPED', 'REJECTED'],
  CRITICAL: ['CRITICAL', 'FAILED', 'STOPPED', 'REJECTED'],
  FAILED: ['FAILED'],
  REJECTED: ['REJECTED'],
  STOPPED: ['STOPPED'],
};

export class ShadowHealthMachine {
  /**
   * Validates if a state transition is permitted in the explicit state transition matrix.
   */
  public static validateTransition(from: ShadowStatus, to: ShadowStatus): void {
    const allowed = ALLOWED_TRANSITIONS[from];
    if (!allowed || !allowed.includes(to)) {
      throw new Error(`INVALID_HEALTH_TRANSITION: Cannot transition shadow health state from '${from}' to '${to}'`);
    }
  }

  /**
   * Evaluates the next deterministic health state based on observations, trades, active drift events, and history.
   */
  public static evaluateNextState(
    currentState: ShadowHealthState,
    observationCount: number,
    tradeCount: number,
    activeDrifts: readonly DriftEvent[],
    config: HealthMachineConfig = DEFAULT_HEALTH_MACHINE_CONFIG,
    now = Date.now(),
  ): ShadowHealthState {
    // If already in terminal failed / rejected / stopped state, remain terminal
    if (
      currentState.status === 'FAILED' ||
      currentState.status === 'REJECTED' ||
      currentState.status === 'STOPPED'
    ) {
      return {
        ...currentState,
        observationCount,
        tradeCount,
        activeDrifts,
        lastEvaluationAt: now,
        updatedAt: now,
      };
    }

    const hasCriticalDrift = activeDrifts.some((d) => d.severity === 'CRITICAL');
    const hasWarningDrift = activeDrifts.some((d) => d.severity === 'WARNING');

    // 1. Critical drift triggers immediate failure
    if (hasCriticalDrift) {
      const critDrift = activeDrifts.find((d) => d.severity === 'CRITICAL');
      this.validateTransition(currentState.status, 'FAILED');
      return {
        candidateId: currentState.candidateId,
        status: 'FAILED',
        observationCount,
        tradeCount,
        consecutiveHealthyWindows: 0,
        consecutiveDegradedWindows: currentState.consecutiveDegradedWindows + 1,
        lastObservationAt: currentState.lastObservationAt,
        lastEvaluationAt: now,
        activeDrifts,
        updatedAt: now,
        statusReason: `CRITICAL_DRIFT: ${critDrift?.details || 'Critical drift detected'}`,
      };
    }

    // 2. Insufficient sample size -> remain INSUFFICIENT_EVIDENCE / ACTIVE
    if (
      observationCount < config.minObservationsForHealthy ||
      tradeCount < config.minTradesForHealthy
    ) {
      const nextStatus: ShadowStatus = currentState.status === 'INSUFFICIENT_EVIDENCE' || currentState.status === 'PENDING' ? 'INSUFFICIENT_EVIDENCE' : 'ACTIVE';
      this.validateTransition(currentState.status, nextStatus);
      return {
        candidateId: currentState.candidateId,
        status: nextStatus,
        observationCount,
        tradeCount,
        consecutiveHealthyWindows: 0,
        consecutiveDegradedWindows: 0,
        lastObservationAt: currentState.lastObservationAt,
        lastEvaluationAt: now,
        activeDrifts,
        updatedAt: now,
        statusReason: 'INSUFFICIENT_SAMPLE_SIZE: Accumulating continuous shadow observations',
      };
    }

    // 3. Warning drift triggers DEGRADED
    if (hasWarningDrift) {
      const nextDegradedCount = currentState.consecutiveDegradedWindows + 1;
      if (nextDegradedCount >= config.maxConsecutiveDegradedWindowsBeforeFailure) {
        this.validateTransition(currentState.status, 'FAILED');
        return {
          candidateId: currentState.candidateId,
          status: 'FAILED',
          observationCount,
          tradeCount,
          consecutiveHealthyWindows: 0,
          consecutiveDegradedWindows: nextDegradedCount,
          lastObservationAt: currentState.lastObservationAt,
          lastEvaluationAt: now,
          activeDrifts,
          updatedAt: now,
          statusReason: `PERSISTENT_DEGRADATION: Exceeded max consecutive degraded windows (${config.maxConsecutiveDegradedWindowsBeforeFailure})`,
        };
      }

      const warnDrift = activeDrifts.find((d) => d.severity === 'WARNING');
      this.validateTransition(currentState.status, 'DEGRADED');
      return {
        candidateId: currentState.candidateId,
        status: 'DEGRADED',
        observationCount,
        tradeCount,
        consecutiveHealthyWindows: 0,
        consecutiveDegradedWindows: nextDegradedCount,
        lastObservationAt: currentState.lastObservationAt,
        lastEvaluationAt: now,
        activeDrifts,
        updatedAt: now,
        statusReason: `WARNING_DRIFT: ${warnDrift?.details || 'Warning drift active'}`,
      };
    }

    // 4. Healthy window evaluation (Zero active warning or critical drifts)
    if (currentState.status === 'DEGRADED') {
      const nextHealthyCount = currentState.consecutiveHealthyWindows + 1;
      if (nextHealthyCount >= config.requiredConsecutiveHealthyWindowsForRecovery) {
        this.validateTransition(currentState.status, 'HEALTHY');
        return {
          candidateId: currentState.candidateId,
          status: 'HEALTHY',
          observationCount,
          tradeCount,
          consecutiveHealthyWindows: nextHealthyCount,
          consecutiveDegradedWindows: 0,
          lastObservationAt: currentState.lastObservationAt,
          lastEvaluationAt: now,
          activeDrifts: [],
          updatedAt: now,
          statusReason: `RECOVERED: Achieved ${config.requiredConsecutiveHealthyWindowsForRecovery} consecutive healthy evaluation windows`,
        };
      } else {
        // Still recovering: remain DEGRADED until threshold met
        this.validateTransition(currentState.status, 'DEGRADED');
        return {
          candidateId: currentState.candidateId,
          status: 'DEGRADED',
          observationCount,
          tradeCount,
          consecutiveHealthyWindows: nextHealthyCount,
          consecutiveDegradedWindows: 0,
          lastObservationAt: currentState.lastObservationAt,
          lastEvaluationAt: now,
          activeDrifts: [],
          updatedAt: now,
          statusReason: `RECOVERY_IN_PROGRESS: ${nextHealthyCount}/${config.requiredConsecutiveHealthyWindowsForRecovery} healthy windows completed`,
        };
      }
    }

    // Normal Healthy State
    this.validateTransition(currentState.status, 'HEALTHY');
    return {
      candidateId: currentState.candidateId,
      status: 'HEALTHY',
      observationCount,
      tradeCount,
      consecutiveHealthyWindows: currentState.consecutiveHealthyWindows + 1,
      consecutiveDegradedWindows: 0,
      lastObservationAt: currentState.lastObservationAt,
      lastEvaluationAt: now,
      activeDrifts: [],
      updatedAt: now,
      statusReason: 'HEALTHY: All rolling performance, feature, regime, and execution metrics within normal bounds',
    };
  }

  /**
   * Initializes health state for a newly registered shadow candidate.
   */
  public static createInitialState(candidateId: string, now = Date.now()): ShadowHealthState {
    return {
      candidateId,
      status: 'INSUFFICIENT_EVIDENCE',
      observationCount: 0,
      tradeCount: 0,
      consecutiveHealthyWindows: 0,
      consecutiveDegradedWindows: 0,
      lastObservationAt: 0,
      lastEvaluationAt: 0,
      activeDrifts: [],
      updatedAt: now,
      statusReason: 'INITIALIZED: Ready for shadow market data stream',
    };
  }
}
