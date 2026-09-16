'use client';

import React from 'react';
import {
  CheckCircle2,
  Clock,
  AlertTriangle,
  XCircle,
  ArrowRight,
  ShieldCheck,
  Zap,
  Activity,
  DollarSign,
} from 'lucide-react';
import { AuthoritativePosition, AlgoExecutionRecord } from '../hooks/usePaperTrading';
import { ISignalSetup } from '@quant/shared';

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
  const hasExecution = !!execution;

  // Determine stage progress
  const stages = [
    { id: 'signal', label: 'Signal Detected', status: signal ? 'DONE' : 'PENDING' },
    { id: 'eligibility', label: 'Eligibility Check', status: signal ? 'DONE' : 'PENDING' },
    {
      id: 'reserved',
      label: 'DB Reservation',
      status: execution?.state ? 'DONE' : isPositionOpen ? 'DONE' : 'PENDING',
    },
    {
      id: 'executing',
      label: 'Executing Lock',
      status:
        execution?.state === 'EXECUTING' || execution?.state === 'EXECUTED' || isPositionOpen
          ? 'DONE'
          : execution?.state?.startsWith('FAILED')
            ? 'FAILED'
            : 'PENDING',
    },
    {
      id: 'placed',
      label: 'Order Filled',
      status:
        execution?.state === 'EXECUTED' || isPositionOpen
          ? 'DONE'
          : execution?.state?.startsWith('FAILED')
            ? 'FAILED'
            : 'PENDING',
    },
    {
      id: 'open',
      label: 'Position Open',
      status: isPositionOpen ? 'ACTIVE' : position?.status === 'CLOSED' ? 'DONE' : 'PENDING',
    },
  ];

  return (
    <div className="terminal-panel p-4 space-y-4 font-mono text-xs">
      {/* Header & Status Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border pb-3">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-cyan-400" />
          <h3 className="font-bold text-white text-sm">AUTHORITATIVE EXECUTION DESK</h3>
          <span className="text-[10px] text-slate-400 font-normal">
            ({symbol} • Backend PostgreSQL & Paper Trading Engine)
          </span>
        </div>

        <div className="flex items-center gap-2">
          {isPositionOpen ? (
            <span className="px-2.5 py-1 rounded-md bg-emerald-950/80 border border-emerald-500/40 text-emerald-400 font-bold text-xs flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              POSITION OPEN ({position.direction})
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

      {/* Trigger vs Fill Section (Requirement 7) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Trigger Specifications */}
        <div className="terminal-card p-3 space-y-2">
          <div className="text-[11px] font-bold text-slate-300 uppercase tracking-wide flex items-center gap-1.5 border-b border-surface-border pb-1.5">
            <Zap className="w-3.5 h-3.5 text-cyan-400" />
            <span>Trigger Specification</span>
          </div>

          <div className="space-y-1 text-[11px]">
            <div className="flex justify-between text-slate-400">
              <span>Trigger Price:</span>
              <span className="text-white font-bold">
                {signal?.entryZone?.optimal ? `₹${signal.entryZone.optimal.toFixed(2)}` : 'Market'}
              </span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>Trigger Time:</span>
              <span className="text-slate-200">
                {signal?.canonicalDecisionTime
                  ? new Date(signal.canonicalDecisionTime).toLocaleTimeString('en-IN')
                  : 'N/A'}
              </span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>Trigger Reason:</span>
              <span className="text-cyan-400 truncate max-w-[200px]">
                {signal?.triggerEvidence?.liquiditySweep?.matched
                  ? 'Liquidity Pool Sweep'
                  : signal?.triggerEvidence?.orderBlock?.matched
                    ? 'Order Block Tap'
                    : 'Institutional SMC Confluence'}
              </span>
            </div>
          </div>
        </div>

        {/* Execution & Fill Details */}
        <div className="terminal-card p-3 space-y-2">
          <div className="text-[11px] font-bold text-slate-300 uppercase tracking-wide flex items-center gap-1.5 border-b border-surface-border pb-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span>Execution & Fill Record</span>
          </div>

          <div className="space-y-1 text-[11px]">
            <div className="flex justify-between text-slate-400">
              <span>Execution State:</span>
              <span className="font-bold text-emerald-400">
                {isPositionOpen ? 'POSITION_OPEN' : execution?.state || 'NO_ACTIVE_ORDER'}
              </span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>Actual Fill Price:</span>
              <span className="text-white font-bold">
                {position?.entryPrice ? `₹${Number(position.entryPrice).toFixed(2)}` : 'Pending'}
              </span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>Quantity / Lots:</span>
              <span className="text-slate-200">{position?.quantity ?? 1}</span>
            </div>
            {isPositionOpen && position && onClosePosition && (
              <div className="pt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => onClosePosition(position.id)}
                  disabled={isClosing}
                  className="px-3 py-1 rounded bg-rose-950/80 hover:bg-rose-900 border border-rose-500/40 text-rose-300 text-xs font-bold transition-colors disabled:opacity-50"
                >
                  {isClosing ? 'Closing...' : 'Close Position (Market)'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Execution Lifecycle Timeline Stepper (Requirement 9) */}
      <div className="terminal-card p-3 space-y-2">
        <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">
          Execution Lifecycle Pipeline
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          {stages.map((stage, idx) => {
            const isDone = stage.status === 'DONE' || stage.status === 'ACTIVE';
            const isFailed = stage.status === 'FAILED';
            const isActive = stage.status === 'ACTIVE';

            return (
              <React.Fragment key={stage.id}>
                <div className="flex items-center gap-1.5">
                  <div
                    className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                      isFailed
                        ? 'bg-rose-950 text-rose-400 border border-rose-500'
                        : isActive
                          ? 'bg-cyan-500 text-slate-950 ring-2 ring-cyan-400/40'
                          : isDone
                            ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/50'
                            : 'bg-surface-panel text-slate-600 border border-surface-border'
                    }`}
                  >
                    {isFailed ? '✕' : isDone ? '✓' : idx + 1}
                  </div>
                  <span
                    className={`text-[11px] ${
                      isFailed
                        ? 'text-rose-400 font-bold'
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
    </div>
  );
};
