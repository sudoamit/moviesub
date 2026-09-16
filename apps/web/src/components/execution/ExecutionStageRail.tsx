'use client';

import React from 'react';
import { ArrowRight } from 'lucide-react';
import { AuthoritativePosition, AlgoExecutionRecord } from '../../hooks/usePaperTrading';
import { ISignalSetup } from '@quant/shared';

export interface ExecutionStage {
  id: string;
  label: string;
  status: 'DONE' | 'ACTIVE' | 'FAILED' | 'PENDING';
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
  const isExecuted = execution?.state === 'EXECUTED' || (!!position && Number(position.entryPrice) > 0);
  const isExecuting = execution?.state === 'EXECUTING' || isExecuted;
  const isReserved = !!execution?.state || isExecuted;
  const isFailed = execution?.state?.startsWith('FAILED');

  const stages: ExecutionStage[] = [
    {
      id: 'signal',
      label: 'Signal Detected',
      status: signal ? 'DONE' : 'PENDING',
    },
    {
      id: 'eligibility',
      label: 'Eligibility Gate',
      status: signal ? 'DONE' : 'PENDING',
    },
    {
      id: 'reserved',
      label: 'DB Reservation',
      status: isReserved ? 'DONE' : isFailed ? 'FAILED' : 'PENDING',
    },
    {
      id: 'executing',
      label: 'Execution Lock',
      status: isExecuting ? 'DONE' : isFailed ? 'FAILED' : 'PENDING',
    },
    {
      id: 'placed',
      label: 'Order Filled',
      status: isExecuted ? 'DONE' : isFailed ? 'FAILED' : 'PENDING',
    },
    {
      id: 'open',
      label: isPositionClosed ? 'Position Closed' : 'Position Open',
      status: isPositionOpen ? 'ACTIVE' : isPositionClosed ? 'DONE' : 'PENDING',
    },
  ];

  return (
    <div className="terminal-card p-3 space-y-2">
      <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">
        Authoritative Execution Lifecycle Rail
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        {stages.map((stage, idx) => {
          const isDone = stage.status === 'DONE';
          const isActive = stage.status === 'ACTIVE';
          const isFail = stage.status === 'FAILED';

          return (
            <React.Fragment key={stage.id}>
              <div className="flex items-center gap-1.5">
                <div
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                    isFail
                      ? 'bg-rose-950 text-rose-400 border border-rose-500'
                      : isActive
                        ? 'bg-cyan-500 text-slate-950 ring-2 ring-cyan-400/40'
                        : isDone
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/50'
                          : 'bg-surface-panel text-slate-600 border border-surface-border'
                  }`}
                >
                  {isFail ? '✕' : isDone ? '✓' : idx + 1}
                </div>
                <span
                  className={`text-[11px] ${
                    isFail
                      ? 'text-rose-400 font-bold'
                      : isActive
                        ? 'text-cyan-300 font-bold'
                        : isDone
                          ? 'text-slate-200 font-bold'
                          : 'text-slate-600'
                  }`}
                >
                  {stage.label}
                </span>
              </div>

              {idx < stages.length - 1 && (
                <ArrowRight
                  className={`w-3.5 h-3.5 shrink-0 hidden sm:block ${
                    isDone ? 'text-emerald-600' : 'text-slate-700'
                  }`}
                />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};
