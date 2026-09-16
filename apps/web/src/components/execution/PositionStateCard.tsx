'use client';

import React from 'react';
import { Clock, TrendingUp, TrendingDown } from 'lucide-react';
import { AuthoritativePosition } from '../../hooks/usePaperTrading';

interface PositionStateCardProps {
  position: AuthoritativePosition | null;
  currPrefix: string;
  onClosePosition?: (positionId: string) => void;
  isClosing?: boolean;
}

export const PositionStateCard: React.FC<PositionStateCardProps> = ({
  position,
  currPrefix,
  onClosePosition,
  isClosing,
}) => {
  const isPositionOpen = position?.status === 'OPEN';
  const isPositionClosed = position?.status === 'CLOSED';
  const unrealizedPnL = position?.unrealizedPnL ?? 0;
  const isProfit = unrealizedPnL >= 0;

  return (
    <div className="terminal-card p-3 space-y-2">
      <div className="text-[11px] font-bold text-slate-300 uppercase tracking-wide flex items-center gap-1.5 border-b border-surface-border pb-1.5">
        <Clock className="w-3.5 h-3.5 text-amber-400" />
        <span>Live State & Exit</span>
      </div>

      <div className="space-y-1.5 text-[11px]">
        <div className="flex justify-between items-center text-slate-400">
          <span>Unrealized P&L:</span>
          {isPositionOpen ? (
            <span
              className={`font-black flex items-center gap-1 ${
                isProfit ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {isProfit ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {isProfit ? '+' : ''}
              {currPrefix}
              {Math.abs(unrealizedPnL).toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
          ) : (
            <span className="text-slate-500">₹0.00</span>
          )}
        </div>

        <div className="flex justify-between text-slate-400">
          <span>Exit Status:</span>
          <span className="text-slate-300">
            {isPositionOpen
              ? 'Active / Not Triggered'
              : isPositionClosed
                ? 'Exited'
                : 'Standby'}
          </span>
        </div>

        {isPositionOpen && position && onClosePosition && (
          <div className="pt-1">
            <button
              type="button"
              onClick={() => onClosePosition(position.id)}
              disabled={isClosing}
              className="w-full py-1 rounded bg-rose-950/80 hover:bg-rose-900 border border-rose-500/40 text-rose-300 text-xs font-bold transition-colors disabled:opacity-50"
            >
              {isClosing ? 'Closing Position...' : 'Market Exit Position'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
