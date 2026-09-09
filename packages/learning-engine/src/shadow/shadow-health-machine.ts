import { DriftEvent, ShadowHealthState, ShadowStatus } from './shadow-types';

export interface HealthMachineConfig {
  readonly minObservationsForHealthy: number; // e.g. 30
  readonly minTradesForHealthy: number; // e.g. 10
  readonly requiredConsecutiveHealthyWindowsForRecovery: number; // e.g. 3
  readonly maxConsecutiveDegradedWindowsBeforeFailure: number; // e.g. 5
}

export const DEFAULT_HEALTH_MACHINE_CONFIG: HealthMachineConfig = {
  minObservationsForHealthy: 30,
  minTradesForHealthy: 10,
  requiredConsecutiveHealthyWindowsForRecovery: 3,
  maxConsecutiveDegradedWindowsBeforeFailure: 5,
};

export class ShadowHealthMachine {
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

    // 2. Insufficient sample size -> remain ACTIVE
    if (
      observationCount < config.minObservationsForHealthy ||
      tradeCount < config.minTradesForHealthy
    ) {
      return {
        candidateId: currentState.candidateId,
        status: 'ACTIVE',
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
      status: 'ACTIVE',
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
