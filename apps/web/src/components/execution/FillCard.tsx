'use client';

import React from 'react';
import { ShieldCheck } from 'lucide-react';
import { AuthoritativePosition, AlgoExecutionRecord } from '../../hooks/usePaperTrading';

interface FillCardProps {
  position: AuthoritativePosition | null;
  execution: AlgoExecutionRecord | null;
  currPrefix: string;
}

export const FillCard: React.FC<FillCardProps> = ({ position, execution, currPrefix }) => {
  const isPositionOpen = position?.status === 'OPEN';
  const isPositionClosed = position?.status === 'CLOSED';

  const fillTimeFormatted = position?.openedAt
    ? new Date(position.openedAt).toLocaleTimeString('en-IN')
    : execution?.createdAt
      ? new Date(execution.createdAt).toLocaleTimeString('en-IN')
      : null;

  return (
    <div className="terminal-card p-3 space-y-2">
      <div className="text-[11px] font-bold text-slate-300 uppercase tracking-wide flex items-center gap-1.5 border-b border-surface-border pb-1.5">
        <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
        <span>Execution & Fill Record</span>
      </div>

      <div className="space-y-1 text-[11px]">
        <div className="flex justify-between text-slate-400">
          <span>Execution State:</span>
          <span className="font-bold text-emerald-400">
            {isPositionOpen
              ? 'POSITION_OPEN'
              : isPositionClosed
                ? 'POSITION_CLOSED'
                : execution?.state || 'NO_ACTIVE_ORDER'}
          </span>
        </div>
        <div className="flex justify-between text-slate-400">
          <span>Fill Price:</span>
          <span className="text-white font-bold">
            {position?.entryPrice
              ? `${currPrefix}${Number(position.entryPrice).toFixed(2)}`
              : 'Pending'}
          </span>
        </div>
        <div className="flex justify-between text-slate-400">
          <span>Fill Time:</span>
          <span className="text-slate-200">{fillTimeFormatted || 'N/A'}</span>
        </div>
        <div className="flex justify-between text-slate-400">
          <span>Quantity:</span>
          <span className="text-slate-200">{position?.quantity ?? 1} Lots</span>
        </div>
      </div>
    </div>
  );
};
