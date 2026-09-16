'use client';

import React from 'react';
import { Zap } from 'lucide-react';

export const Brand: React.FC = () => {
  return (
    <div className="flex items-center gap-2.5">
      <div className="w-7 h-7 rounded-lg bg-surface-elevated border border-surface-border flex items-center justify-center text-cyan-400 shrink-0">
        <Zap className="w-3.5 h-3.5 fill-cyan-400/20 text-cyan-400" />
      </div>
      <div>
        <div className="flex items-center gap-1.5 leading-none">
          <span className="text-sm font-bold tracking-tight text-white font-mono">QUANT PLATFORM</span>
          <span className="text-[9px] font-semibold text-cyan-400 bg-cyan-950/80 border border-cyan-800/60 px-1 py-0.2 rounded font-mono">
            v2.8
          </span>
        </div>
        <span className="text-[10px] text-slate-400 font-mono">Trading Workstation</span>
      </div>
    </div>
  );
};
