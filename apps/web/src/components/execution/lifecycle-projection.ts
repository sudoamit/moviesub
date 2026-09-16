import { ISignalSetup } from '@quant/shared';
import { AuthoritativePosition, AlgoExecutionRecord } from '../../hooks/usePaperTrading';

export type StageState = 'DONE' | 'ACTIVE' | 'FAILED' | 'BLOCKED' | 'NOT_REACHED' | 'PENDING';

export interface ExecutionStage {
  id: string;
  label: string;
  status: StageState;
  reason?: string;
}

export interface LifecycleProjectionParams {
  signal: ISignalSetup | null;
  execution: AlgoExecutionRecord | null;
  position: AuthoritativePosition | null;
}

export function calculateExecutionLifecycle({
  signal,
  execution,
  position,
}: LifecycleProjectionParams): ExecutionStage[] {
  const isPositionOpen = position?.status === 'OPEN';
  const isPositionClosed = position?.status === 'CLOSED';

  // 1. Stage 1: Signal Detection (Authoritative Canonical Event Evidence)
  // Contract: Signal detection strictly requires canonical market-data event timestamps
  // (canonicalCandleTime AND canonicalDecisionTime) or authoritative persisted signal identity (id)
  // with canonical timestamps. Uninitialized or client-only { symbol, timeframe } shells are rejected.
  const isSignalDetected = Boolean(
    signal &&
      ((signal.canonicalCandleTime && signal.canonicalDecisionTime) ||
        (signal.id && (signal.canonicalCandleTime || signal.timestamp)))
  );
  const signalStatus: StageState = isSignalDetected ? 'DONE' : 'PENDING';
  const signalReason =
    signal && isSignalDetected
      ? `${signal.symbol} ${signal.timeframe} • ${signal.direction}`
      : undefined;

  // 2. Stage 2: Eligibility Gate (Consumes Authoritative Backend Eligibility Evidence)
  // Contract: Progression downstream (RESERVED/EXECUTING/EXECUTED) must NEVER substitute for
  // explicit eligibility evidence. If authoritative eligibility evidence is absent, status is PENDING.
  let eligibilityStatus: StageState = 'PENDING';
  let eligibilityReason: string | undefined;

  if (!signal) {
    eligibilityStatus = 'PENDING';
    eligibilityReason = undefined;
  } else if (execution?.eligibilityState) {
    switch (execution.eligibilityState) {
      case 'ELIGIBLE':
        eligibilityStatus = 'DONE';
        eligibilityReason = execution.eligibilityReason || 'Eligible for execution';
        break;
      case 'BLOCKED':
        eligibilityStatus = 'BLOCKED';
        eligibilityReason =
          execution.eligibilityReason || execution.eligibilityReasonCode || 'Blocked by execution gate';
        break;
      case 'FAILED':
        eligibilityStatus = 'FAILED';
        eligibilityReason =
          execution.eligibilityReason || execution.eligibilityReasonCode || 'Eligibility evaluation failed';
        break;
      case 'PENDING':
      default:
        eligibilityStatus = 'PENDING';
        eligibilityReason = 'Awaiting backend eligibility evaluation';
        break;
    }
  } else if (
    execution?.failureReasonCode === 'INELIGIBLE_FOR_EXECUTION' ||
    execution?.failureReasonCode === 'SCORE_BELOW_MIN' ||
    execution?.failureReasonCode === 'AUTO_EXECUTE_DISABLED' ||
    execution?.failureReasonCode === 'BOT_INACTIVE' ||
    execution?.failureReasonCode === 'SMC_CONDITION_MISMATCH' ||
    execution?.failureReasonCode === 'SYMBOL_MISMATCH' ||
    execution?.failureReasonCode === 'DIRECTION_MISMATCH'
  ) {
    eligibilityStatus = 'BLOCKED';
    eligibilityReason = execution.failureReason || execution.failureReasonCode;
  } else if ((signal as any).eligibility?.state === 'ELIGIBLE') {
    eligibilityStatus = 'DONE';
    eligibilityReason = (signal as any).eligibility?.reason || 'Eligible for execution';
  } else if (
    (signal as any).eligibility?.state === 'BLOCKED' ||
    (signal as any).eligibility?.state === 'REJECTED'
  ) {
    eligibilityStatus = 'BLOCKED';
    eligibilityReason = (signal as any).eligibility?.reason || 'Blocked by market gate';
  } else if (
    (signal as any).rejectionReasons &&
    (signal as any).rejectionReasons.length > 0
  ) {
    eligibilityStatus = 'BLOCKED';
    eligibilityReason = (signal as any).rejectionReasons[0];
  } else {
    // Strictest contract: Without authoritative backend execution/signal eligibility evidence, stage is PENDING
    eligibilityStatus = 'PENDING';
    eligibilityReason = 'Awaiting backend eligibility evaluation';
  }

  // 3. Stage 3: DB Reservation (Requires Explicit Authoritative Reservation Evidence)
  let reservationStatus: StageState = 'PENDING';
  let reservationReason: string | undefined;

  const hasExplicitReservation = Boolean(
    execution &&
      (execution.reservationFingerprint ||
        execution.reservationId ||
        execution.reservationState === 'RESERVED' ||
        execution.state === 'RESERVED')
  );

  const isReservationLockedOrFailed =
    execution?.failureReasonCode === 'EXECUTION_LOCKED' ||
    execution?.reservationState === 'FAILED' ||
    (execution?.state === 'FAILED_FINAL' && !execution.orderPositionId);

  if (eligibilityStatus === 'BLOCKED' || eligibilityStatus === 'FAILED') {
    reservationStatus = 'NOT_REACHED';
  } else if (hasExplicitReservation) {
    reservationStatus = 'DONE';
    reservationReason = execution?.reservationFingerprint
      ? `Lock reserved (${execution.botId})`
      : `Lock reserved (${execution?.botId || 'bot'})`;
  } else if (isReservationLockedOrFailed) {
    reservationStatus = 'FAILED';
    reservationReason =
      execution?.failureReason || execution?.failureReasonCode || 'Reservation lock conflict';
  } else {
    reservationStatus = 'PENDING';
  }

  // 4. Stage 4: Execution Lock & Order Dispatch
  let executionLockStatus: StageState = 'PENDING';
  let executionLockReason: string | undefined;

  if (
    reservationStatus === 'FAILED' ||
    reservationStatus === 'NOT_REACHED' ||
    eligibilityStatus === 'BLOCKED' ||
    eligibilityStatus === 'FAILED'
  ) {
    executionLockStatus = 'NOT_REACHED';
  } else if (execution?.state === 'EXECUTED') {
    executionLockStatus = 'DONE';
    executionLockReason = 'Order placed';
  } else if (execution?.state === 'EXECUTING') {
    executionLockStatus = 'ACTIVE';
    executionLockReason = 'Dispatching to broker';
  } else if (execution?.state?.startsWith('FAILED')) {
    executionLockStatus = 'FAILED';
    executionLockReason =
      execution.failureReason || execution.failureReasonCode || 'Broker execution error';
  } else {
    executionLockStatus = 'PENDING';
  }

  // 5. Stage 5: Order Filled (Strictly Authoritative Execution Record)
  let orderFilledStatus: StageState = 'PENDING';
  let orderFilledReason: string | undefined;

  const isAuthoritativelyFilled =
    execution?.state === 'EXECUTED' || Boolean(execution?.orderPositionId);

  if (
    executionLockStatus === 'NOT_REACHED' ||
    executionLockStatus === 'FAILED' ||
    reservationStatus === 'FAILED' ||
    reservationStatus === 'NOT_REACHED' ||
    eligibilityStatus === 'BLOCKED' ||
    eligibilityStatus === 'FAILED'
  ) {
    orderFilledStatus = 'NOT_REACHED';
  } else if (isAuthoritativelyFilled) {
    orderFilledStatus = 'DONE';
    const fillPrice = execution?.fillPrice;
    orderFilledReason =
      fillPrice !== undefined && fillPrice !== null
        ? `Filled @ ₹${Number(fillPrice).toFixed(2)}`
        : 'Filled';
  } else if (execution?.state?.startsWith('FAILED')) {
    orderFilledStatus = 'FAILED';
    orderFilledReason = 'Execution failed';
  } else {
    orderFilledStatus = 'PENDING';
  }

  // 6. Stage 6: Position State (Strictly from Authoritative Portfolio/Position Object)
  let positionStatus: StageState = 'PENDING';
  let positionReason: string | undefined;

  if (
    orderFilledStatus === 'NOT_REACHED' ||
    orderFilledStatus === 'FAILED' ||
    executionLockStatus === 'FAILED' ||
    executionLockStatus === 'NOT_REACHED' ||
    reservationStatus === 'FAILED' ||
    reservationStatus === 'NOT_REACHED' ||
    eligibilityStatus === 'BLOCKED' ||
    eligibilityStatus === 'FAILED'
  ) {
    positionStatus = 'NOT_REACHED';
  } else if (isPositionOpen) {
    positionStatus = 'ACTIVE';
    positionReason = `${position.direction} Active`;
  } else if (isPositionClosed) {
    positionStatus = 'DONE';
    positionReason = 'Position Closed';
  } else {
    positionStatus = 'PENDING';
  }

  return [
    { id: 'signal', label: 'Signal Detected', status: signalStatus, reason: signalReason },
    {
      id: 'eligibility',
      label: 'Eligibility Gate',
      status: eligibilityStatus,
      reason: eligibilityReason,
    },
    {
      id: 'reserved',
      label: 'DB Reservation',
      status: reservationStatus,
      reason: reservationReason,
    },
    {
      id: 'executing',
      label: 'Execution Lock',
      status: executionLockStatus,
      reason: executionLockReason,
    },
    { id: 'placed', label: 'Order Filled', status: orderFilledStatus, reason: orderFilledReason },
    {
      id: 'open',
      label: isPositionClosed ? 'Position Closed' : 'Position Open',
      status: positionStatus,
      reason: positionReason,
    },
  ];
}
