'use client';

import React from 'react';
import { Activity, AlertTriangle, XCircle } from 'lucide-react';
import { AuthoritativePosition, AlgoExecutionRecord } from '../hooks/usePaperTrading';
import { ISignalSetup } from '@quant/shared';
import { ExecutionStageRail } from './execution/ExecutionStageRail';
import { FillCard } from './execution/FillCard';
import { PositionStateCard } from './execution/PositionStateCard';
import { TriggerCard } from './execution/TriggerCard';

interface ExecutionTimelineProps {
  symbol: string;
  signal: ISignalSetup | null;
  position: AuthoritativePosition | null;
  execution: AlgoExecutionRecord | null;
  onClosePosition?: (positionId: string) => void;
  isClosing?: boolean;
}

export const ExecutionTimeline: React.FC<ExecutionTimelineProps> = ({
  symbol,
  signal,
  position,
  execution,
  onClosePosition,
  isClosing,
}) => {
  const isPositionOpen = position?.status === 'OPEN';
  const isPositionClosed = position?.status === 'CLOSED';

  const isCrypto = symbol === 'BTCUSDT';
  const isGold = symbol === 'XAUUSD';
  const currPrefix = isCrypto || isGold ? '$' : '₹';

  return (
    <div className="terminal-panel p-4 space-y-4 font-mono text-xs">
      {/* 1. Header with Authoritative Execution State */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border pb-3">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-cyan-400" />
          <h3 className="font-bold text-white text-sm">AUTHORITATIVE EXECUTION DESK</h3>
          <span className="text-[10px] text-slate-400 font-normal">
            ({symbol} • PostgreSQL Backend Engine)
          </span>
        </div>

        <div className="flex items-center gap-2">
          {isPositionOpen ? (
            <span className="px-2.5 py-1 rounded-md bg-emerald-950/90 border border-emerald-500/50 text-emerald-400 font-bold text-xs flex items-center gap-1.5 shadow-sm shadow-emerald-500/20">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              POSITION OPEN ({position.direction})
            </span>
          ) : isPositionClosed ? (
            <span className="px-2.5 py-1 rounded-md bg-surface-panel border border-surface-border text-slate-300 font-bold text-xs flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-slate-500" />
              POSITION CLOSED
            </span>
          ) : execution?.state === 'FAILED_RETRYABLE' ? (
            <span className="px-2.5 py-1 rounded-md bg-amber-950/80 border border-amber-500/40 text-amber-400 font-bold text-xs flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" />
              FAILED_RETRYABLE ({execution.failureReasonCode || 'BROKER_UNAVAILABLE'})
            </span>
          ) : execution?.state === 'FAILED_FINAL' ? (
            <span className="px-2.5 py-1 rounded-md bg-rose-950/80 border border-rose-500/40 text-rose-400 font-bold text-xs flex items-center gap-1.5">
              <XCircle className="w-3.5 h-3.5" />
              FAILED_FINAL ({execution.failureReasonCode || 'BROKER_REJECTED'})
            </span>
          ) : (
            <span className="px-2.5 py-1 rounded-md bg-surface-panel border border-surface-border text-slate-400 text-xs font-bold">
              STANDBY / READY
            </span>
          )}
        </div>
      </div>

      {/* 2. Structured Execution Workflow Hierarchy: Fill -> Position State -> Trigger Specs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Priority 1: Fill / Execution Status */}
        <FillCard position={position} execution={execution} currPrefix={currPrefix} />

        {/* Priority 2: Position State & Live P&L */}
        <PositionStateCard
          position={position}
          currPrefix={currPrefix}
          onClosePosition={onClosePosition}
          isClosing={isClosing}
        />

        {/* Priority 3: Historical Trigger Details */}
        <TriggerCard signal={signal} currPrefix={currPrefix} />
      </div>

      {/* 3. Strict Authoritative Execution Lifecycle Pipeline Stepper */}
      <ExecutionStageRail signal={signal} position={position} execution={execution} />
    </div>
  );
};
