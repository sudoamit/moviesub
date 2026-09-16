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
  const hasExecutionRecord = !!execution;
  const isExecutionFailed = execution?.state?.startsWith('FAILED');
  const isExecuted = execution?.state === 'EXECUTED' || Boolean(execution?.orderPositionId);
  const isExecuting = execution?.state === 'EXECUTING';
  const isReserved =
    execution?.state === 'RESERVED' || isExecuting || isExecuted;

  // 1. Signal Stage
  const signalStatus: StageState = signal ? 'DONE' : 'PENDING';

  // 2. Eligibility Gate Stage
  const eligibilityStatus: StageState = signal ? 'DONE' : 'PENDING';

  // 3. DB Reservation Stage
  let reservationStatus: StageState = 'PENDING';
  if (isReserved) {
    reservationStatus = 'DONE';
  } else if (isExecutionFailed) {
    reservationStatus = 'FAILED';
  } else if (!signal) {
    reservationStatus = 'PENDING';
  }

  // 4. Execution Lock Stage
  let executionLockStatus: StageState = 'PENDING';
  if (isExecuted) {
    executionLockStatus = 'DONE';
  } else if (isExecuting) {
    executionLockStatus = 'ACTIVE';
  } else if (isExecutionFailed) {
    executionLockStatus = 'FAILED';
  } else if (reservationStatus === 'FAILED') {
    executionLockStatus = 'BLOCKED';
  } else {
    executionLockStatus = 'PENDING';
  }

  // 5. Order Filled Stage (Strictly Authoritative)
  let orderFilledStatus: StageState = 'PENDING';
  if (isExecuted) {
    orderFilledStatus = 'DONE';
  } else if (isExecutionFailed) {
    orderFilledStatus = 'BLOCKED';
  } else if (executionLockStatus === 'BLOCKED' || reservationStatus === 'FAILED') {
    orderFilledStatus = 'NOT_REACHED';
  } else {
    orderFilledStatus = 'PENDING';
  }

  // 6. Position Open Stage (Strictly from Authoritative Position State)
  let positionStatus: StageState = 'PENDING';
  if (isPositionOpen) {
    positionStatus = 'ACTIVE';
  } else if (isPositionClosed) {
    positionStatus = 'DONE';
  } else if (isExecutionFailed || orderFilledStatus === 'BLOCKED' || orderFilledStatus === 'NOT_REACHED') {
    positionStatus = 'NOT_REACHED';
  } else {
    positionStatus = 'PENDING';
  }

  const stages: ExecutionStage[] = [
    { id: 'signal', label: 'Signal Detected', status: signalStatus },
    { id: 'eligibility', label: 'Eligibility Gate', status: eligibilityStatus },
    { id: 'reserved', label: 'DB Reservation', status: reservationStatus },
    { id: 'executing', label: 'Execution Lock', status: executionLockStatus },
    { id: 'placed', label: 'Order Filled', status: orderFilledStatus },
    {
      id: 'open',
      label: isPositionClosed ? 'Position Closed' : 'Position Open',
      status: positionStatus,
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
          <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold bg-amber-950/80 text-amber-400 border border-amber-500/60" title="Blocked by upstream failure">
            ⊘
          </div>
        );
      case 'NOT_REACHED':
        return (
          <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold bg-slate-900 text-slate-600 border border-slate-800" title="Not reached">
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
            <div className="flex items-center gap-1.5">
              {getStageBadge(stage.status, idx)}
              <span className={`text-[11px] ${getStageTextColor(stage.status)}`}>
                {stage.label}
              </span>
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
