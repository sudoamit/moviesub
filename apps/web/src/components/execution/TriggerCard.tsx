'use client';

import React from 'react';
import { Zap } from 'lucide-react';
import { ISignalSetup } from '@quant/shared';

interface TriggerCardProps {
  signal: ISignalSetup | null;
  currPrefix: string;
}

export const TriggerCard: React.FC<TriggerCardProps> = ({ signal, currPrefix }) => {
  return (
    <div className="terminal-card p-3 space-y-2">
      <div className="text-[11px] font-bold text-slate-300 uppercase tracking-wide flex items-center gap-1.5 border-b border-surface-border pb-1.5">
        <Zap className="w-3.5 h-3.5 text-cyan-400" />
        <span>Trigger Specification</span>
      </div>

      <div className="space-y-1 text-[11px]">
        <div className="flex justify-between text-slate-400">
          <span>Trigger Price:</span>
          <span className="text-white font-bold">
            {signal?.entryZone?.optimal
              ? `${currPrefix}${signal.entryZone.optimal.toFixed(2)}`
              : 'Market'}
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
          <span className="text-cyan-400 truncate max-w-[150px]">
            {signal?.triggerEvidence?.liquiditySweep?.matched
              ? 'Liquidity Sweep'
              : signal?.triggerEvidence?.orderBlock?.matched
                ? 'Order Block Tap'
                : 'SMC Confluence'}
          </span>
        </div>
      </div>
    </div>
  );
};
