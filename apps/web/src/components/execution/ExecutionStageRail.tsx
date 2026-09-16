'use client';

import React from 'react';
import { ArrowRight } from 'lucide-react';
import { AuthoritativePosition, AlgoExecutionRecord } from '../../hooks/usePaperTrading';
import { ISignalSetup } from '@quant/shared';

export type StageState = 'DONE' | 'ACTIVE' | 'FAILED' | 'BLOCKED' | 'NOT_REACHED' | 'PENDING';

export interface ExecutionStage {
  id: string;
  label: string;
  status: StageState;
  reason?: string;
}

interface ExecutionStageRailProps {
  signal: ISignalSetup | null;
  position: AuthoritativePosition | null;
  execution: AlgoExecutionRecord | null;
}

export const ExecutionStageRail: React.FC<ExecutionStageRailProps> = ({
  signal,
  position,
  execution,
}) => {
  const isPositionOpen = position?.status === 'OPEN';
  const isPositionClosed = position?.status === 'CLOSED';

  // 1. Stage 1: Signal Detection (Authoritative Canonical Evidence)
  const isSignalDetected = !!signal && !!signal.canonicalDecisionTime;
  const signalStatus: StageState = isSignalDetected ? 'DONE' : 'PENDING';

  // 2. Stage 2: Eligibility Gate (First-Class Authoritative Evaluation)
  let eligibilityStatus: StageState = 'PENDING';
  let eligibilityReason: string | undefined;

  if (!signal) {
    eligibilityStatus = 'PENDING';
  } else if (signal.score < 70 || (signal.grade as string) === 'NO_TRADE' || (signal.direction as string) === 'NEUTRAL') {
    eligibilityStatus = 'BLOCKED';
    eligibilityReason = `Score ${signal.score}/100 below gate threshold`;
  } else {
    eligibilityStatus = 'DONE';
    eligibilityReason = `Score ${signal.score}/100 • Grade ${signal.grade}`;
  }

  // 3. Stage 3: DB Reservation (Explicit Authoritative Evidence in PostgreSQL)
  let reservationStatus: StageState = 'PENDING';
  let reservationReason: string | undefined;

  const hasExplicitReservation =
    !!execution?.id &&
    (execution.state === 'RESERVED' ||
      execution.state === 'EXECUTING' ||
      execution.state === 'EXECUTED');

  const isReservationLockedOrFailed =
    execution?.failureReasonCode === 'EXECUTION_LOCKED' ||
    (execution?.state === 'FAILED_FINAL' && !execution.orderPositionId);

  if (hasExplicitReservation) {
    reservationStatus = 'DONE';
    reservationReason = execution.botId ? `Lock reserved (${execution.botId})` : 'Lock reserved';
  } else if (isReservationLockedOrFailed) {
    reservationStatus = 'FAILED';
    reservationReason = execution?.failureReason || execution?.failureReasonCode || 'Reservation lock failed';
  } else if (eligibilityStatus === 'BLOCKED') {
    reservationStatus = 'NOT_REACHED';
  } else {
    reservationStatus = 'PENDING';
  }

  // 4. Stage 4: Execution Lock & Order Dispatch
  let executionLockStatus: StageState = 'PENDING';
  let executionLockReason: string | undefined;

  if (execution?.state === 'EXECUTED') {
    executionLockStatus = 'DONE';
    executionLockReason = 'Order placed';
  } else if (execution?.state === 'EXECUTING') {
    executionLockStatus = 'ACTIVE';
    executionLockReason = 'Dispatching to broker';
  } else if (execution?.state?.startsWith('FAILED')) {
    executionLockStatus = 'FAILED';
    executionLockReason = execution.failureReason || execution.failureReasonCode || 'Broker error';
  } else if (reservationStatus === 'FAILED' || reservationStatus === 'NOT_REACHED') {
    executionLockStatus = 'NOT_REACHED';
  } else {
    executionLockStatus = 'PENDING';
  }

  // 5. Stage 5: Order Filled (Strictly Authoritative Execution Record)
  let orderFilledStatus: StageState = 'PENDING';
  let orderFilledReason: string | undefined;

  const isAuthoritativelyFilled =
    execution?.state === 'EXECUTED' || Boolean(execution?.orderPositionId);

  if (isAuthoritativelyFilled) {
    orderFilledStatus = 'DONE';
    orderFilledReason = position?.entryPrice ? `Filled @ ₹${Number(position.entryPrice).toFixed(2)}` : 'Filled';
  } else if (execution?.state?.startsWith('FAILED')) {
    orderFilledStatus = 'BLOCKED';
    orderFilledReason = 'Execution failed';
  } else if (
    executionLockStatus === 'NOT_REACHED' ||
    reservationStatus === 'FAILED' ||
    reservationStatus === 'NOT_REACHED'
  ) {
    orderFilledStatus = 'NOT_REACHED';
  } else {
    orderFilledStatus = 'PENDING';
  }

  // 6. Stage 6: Position State (Strictly from Authoritative Portfolio/Position Object)
  let positionStatus: StageState = 'PENDING';
  let positionReason: string | undefined;

  if (isPositionOpen) {
    positionStatus = 'ACTIVE';
    positionReason = `${position.direction} Active`;
  } else if (isPositionClosed) {
    positionStatus = 'DONE';
    positionReason = 'Closed';
  } else if (
    orderFilledStatus === 'BLOCKED' ||
    orderFilledStatus === 'NOT_REACHED' ||
    executionLockStatus === 'FAILED'
  ) {
    positionStatus = 'NOT_REACHED';
  } else {
    positionStatus = 'PENDING';
  }

  const stages: ExecutionStage[] = [
    { id: 'signal', label: 'Signal Detected', status: signalStatus },
    { id: 'eligibility', label: 'Eligibility Gate', status: eligibilityStatus, reason: eligibilityReason },
    { id: 'reserved', label: 'DB Reservation', status: reservationStatus, reason: reservationReason },
    { id: 'executing', label: 'Execution Lock', status: executionLockStatus, reason: executionLockReason },
    { id: 'placed', label: 'Order Filled', status: orderFilledStatus, reason: orderFilledReason },
    {
      id: 'open',
      label: isPositionClosed ? 'Position Closed' : 'Position Open',
      status: positionStatus,
      reason: positionReason,
    },
  ];

  const getStageBadge = (status: StageState, idx: number) => {
    switch (status) {
      case 'DONE':
        return (
          <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold bg-emerald-950 text-emerald-400 border border-emerald-500/50">
            ✓
          </div>
        );
      case 'ACTIVE':
        return (
          <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold bg-cyan-500 text-slate-950 ring-2 ring-cyan-400/40 animate-pulse">
            ●
          </div>
        );
      case 'FAILED':
        return (
          <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold bg-rose-950 text-rose-400 border border-rose-500">
            ✕
          </div>
        );
      case 'BLOCKED':
        return (
          <div
            className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold bg-amber-950/80 text-amber-400 border border-amber-500/60"
            title="Blocked by upstream gate failure"
          >
            ⊘
          </div>
        );
      case 'NOT_REACHED':
        return (
          <div
            className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold bg-slate-900 text-slate-600 border border-slate-800"
            title="Stage not reached"
          >
            —
          </div>
        );
      case 'PENDING':
      default:
        return (
          <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold bg-surface-panel text-slate-600 border border-surface-border">
            {idx + 1}
          </div>
        );
    }
  };

  const getStageTextColor = (status: StageState) => {
    switch (status) {
      case 'DONE':
        return 'text-slate-200 font-bold';
      case 'ACTIVE':
        return 'text-cyan-300 font-bold';
      case 'FAILED':
        return 'text-rose-400 font-bold';
      case 'BLOCKED':
        return 'text-amber-400 font-bold';
      case 'NOT_REACHED':
        return 'text-slate-600';
      case 'PENDING':
      default:
        return 'text-slate-600';
    }
  };

  return (
    <div className="terminal-card p-3 space-y-2">
      <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">
        Authoritative Execution Lifecycle Rail
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        {stages.map((stage, idx) => (
          <React.Fragment key={stage.id}>
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                {getStageBadge(stage.status, idx)}
                <span className={`text-[11px] ${getStageTextColor(stage.status)}`}>
                  {stage.label}
                </span>
              </div>
              {stage.reason && stage.status !== 'PENDING' && stage.status !== 'NOT_REACHED' && (
                <span className="text-[9px] text-slate-400 pl-6.5 truncate max-w-[120px]">
                  {stage.reason}
                </span>
              )}
            </div>

            {idx < stages.length - 1 && (
              <ArrowRight
                className={`w-3.5 h-3.5 shrink-0 hidden sm:block ${
                  stage.status === 'DONE' ? 'text-emerald-600' : 'text-slate-700'
                }`}
              />
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};
