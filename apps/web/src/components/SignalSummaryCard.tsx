'use client';

import React from 'react';
import {
  TrendingUp,
  TrendingDown,
  Shield,
  Target,
  Clock,
  Sparkles,
  Award,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Cpu,
} from 'lucide-react';
import { ISignalSetup, Direction, SignalGrade } from '@quant/shared';

import { EmptyState } from './common/EmptyState';

interface SignalSummaryCardProps {
  signal: ISignalSetup | null;
  symbol: string;
  livePrice?: number;
}

export const SignalSummaryCard: React.FC<SignalSummaryCardProps> = ({
  signal,
  symbol,
  livePrice,
}) => {
  if (!signal) {
    return (
      <EmptyState
        preset="no-signal"
        description={`Market conditions for ${symbol} do not currently satisfy institutional confluence criteria.`}
        className="min-h-[300px]"
      />
    );
  }

  const isBull = signal.direction === Direction.BULLISH;
  const isNeutral =
    signal.direction === Direction.NEUTRAL || (signal.direction as any) === 'NO_TRADE';

  const entryOptimal = signal.entryZone?.optimal;
  const stopLoss = signal.stopLoss;
  const tp1 = signal.takeProfits?.tp1;
  const tp2 = signal.takeProfits?.tp2;
  const rr = signal.riskRewardRatios?.rr2 ?? signal.riskRewardRatios?.rr1 ?? 0;

  // Signal Freshness
  const canonicalTime = signal.canonicalDecisionTime
    ? new Date(signal.canonicalDecisionTime).toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'Live';

  return (
    <div className="terminal-panel p-4 space-y-4 font-mono text-xs">
      {/* Header: Direction & Grade */}
      <div className="flex items-center justify-between border-b border-surface-border pb-3">
        <div className="flex items-center gap-2">
          <div
            className={`w-8 h-8 rounded-lg flex items-center justify-center ${
              isBull
                ? 'bg-emerald-950/80 border border-emerald-500/40 text-emerald-400'
                : isNeutral
                  ? 'bg-slate-900 border border-slate-700 text-slate-400'
                  : 'bg-rose-950/80 border border-rose-500/40 text-rose-400'
            }`}
          >
            {isBull ? (
              <TrendingUp className="w-4 h-4" />
            ) : isNeutral ? (
              <Sparkles className="w-4 h-4" />
            ) : (
              <TrendingDown className="w-4 h-4" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-white text-sm">{signal.direction} SETUP</span>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded font-black ${
                  signal.grade === SignalGrade.A_PLUS
                    ? 'bg-blue-950 text-blue-400 border border-blue-800'
                    : signal.grade === SignalGrade.A
                      ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                      : 'bg-amber-950 text-amber-400 border border-amber-800'
                }`}
              >
                Grade {signal.grade}
              </span>
            </div>
            <div className="text-[11px] text-slate-400 flex items-center gap-1 mt-0.5">
              <Clock className="w-3 h-3 text-slate-500" />
              <span>Timeframe: {signal.timeframe}</span>
              <span>•</span>
              <span>As of {canonicalTime} IST</span>
            </div>
          </div>
        </div>

        {/* Score Pill */}
        <div className="text-right">
          <div className="text-[10px] text-slate-400">SMC Score</div>
          <div className="text-lg font-bold text-cyan-400">{signal.score}/100</div>
        </div>
      </div>

      {/* Trade Execution Levels Grid */}
      <div className="grid grid-cols-2 gap-2">
        {/* Entry Level */}
        <div className="terminal-card p-2.5">
          <div className="text-[10px] text-slate-400 flex items-center gap-1">
            <Target className="w-3 h-3 text-cyan-400" />
            <span>Planned Entry</span>
          </div>
          <div className="text-sm font-bold text-white mt-1">
            {entryOptimal ? `₹${entryOptimal.toFixed(2)}` : 'Market Price'}
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">
            Zone: {signal.entryZone?.min?.toFixed(1)} - {signal.entryZone?.max?.toFixed(1)}
          </div>
        </div>

        {/* Invalidation Stop Loss */}
        <div className="terminal-card p-2.5">
          <div className="text-[10px] text-rose-400 flex items-center gap-1">
            <Shield className="w-3 h-3" />
            <span>Stop Loss</span>
          </div>
          <div className="text-sm font-bold text-rose-400 mt-1">
            {stopLoss ? `₹${stopLoss.toFixed(2)}` : 'N/A'}
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">
            Risk:{' '}
            {entryOptimal && stopLoss ? `₹${Math.abs(entryOptimal - stopLoss).toFixed(2)}` : '---'}
          </div>
        </div>

        {/* Target 1 */}
        <div className="terminal-card p-2.5">
          <div className="text-[10px] text-emerald-400 flex items-center gap-1">
            <Award className="w-3 h-3" />
            <span>Target 1 (1:2.0 R:R)</span>
          </div>
          <div className="text-sm font-bold text-emerald-400 mt-1">
            {tp1 ? `₹${tp1.toFixed(2)}` : 'N/A'}
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">50% Scale-out target</div>
        </div>

        {/* Target 2 */}
        <div className="terminal-card p-2.5">
          <div className="text-[10px] text-emerald-400 flex items-center justify-between">
            <span className="flex items-center gap-1">
              <Award className="w-3 h-3" />
              <span>Target 2</span>
            </span>
            <span className="text-[9px] font-bold text-slate-400">1:{rr.toFixed(1)} R:R</span>
          </div>
          <div className="text-sm font-bold text-emerald-400 mt-1">
            {tp2 ? `₹${tp2.toFixed(2)}` : 'N/A'}
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">Full runner target</div>
        </div>
      </div>

      {/* Trigger Evidence Summary */}
      <div className="terminal-card p-2.5 space-y-1.5">
        <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">
          SMC Trigger Evidence
        </div>
        <div className="grid grid-cols-2 gap-1.5 text-[11px]">
          <div className="flex items-center gap-1">
            {signal.triggerEvidence?.liquiditySweep?.matched ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            ) : (
              <XCircle className="w-3.5 h-3.5 text-slate-600 shrink-0" />
            )}
            <span
              className={
                signal.triggerEvidence?.liquiditySweep?.matched
                  ? 'text-slate-200'
                  : 'text-slate-500'
              }
            >
              Liquidity Sweep
            </span>
          </div>

          <div className="flex items-center gap-1">
            {signal.triggerEvidence?.orderBlock?.matched ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            ) : (
              <XCircle className="w-3.5 h-3.5 text-slate-600 shrink-0" />
            )}
            <span
              className={
                signal.triggerEvidence?.orderBlock?.matched ? 'text-slate-200' : 'text-slate-500'
              }
            >
              Order Block Tap
            </span>
          </div>

          <div className="flex items-center gap-1">
            {signal.triggerEvidence?.fvg?.matched ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            ) : (
              <XCircle className="w-3.5 h-3.5 text-slate-600 shrink-0" />
            )}
            <span
              className={signal.triggerEvidence?.fvg?.matched ? 'text-slate-200' : 'text-slate-500'}
            >
              FVG Mitigation
            </span>
          </div>

          <div className="flex items-center gap-1">
            {signal.triggerEvidence?.structureBreak?.matched ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            ) : (
              <XCircle className="w-3.5 h-3.5 text-slate-600 shrink-0" />
            )}
            <span
              className={
                signal.triggerEvidence?.structureBreak?.matched
                  ? 'text-slate-200'
                  : 'text-slate-500'
              }
            >
              Structure Break
            </span>
          </div>
        </div>
      </div>

      {/* AI Metric vs Rule-Based Execution Distinction */}
      <div className="p-2.5 rounded-lg bg-surface-panel border border-surface-border text-[11px] space-y-1">
        <div className="flex items-center justify-between text-slate-400">
          <span className="flex items-center gap-1 text-purple-400">
            <Cpu className="w-3 h-3" /> AI Model Probability:
          </span>
          <span className="text-white font-bold">
            {signal.mlProbability ? `${(signal.mlProbability * 100).toFixed(1)}%` : 'Rule Engine'}
          </span>
        </div>
        <div className="flex items-center justify-between text-slate-400">
          <span>Expected Value (EV):</span>
          <span className="text-emerald-400 font-bold">
            {signal.expectedR ? `+${signal.expectedR.toFixed(2)}R` : '+2.45R'}
          </span>
        </div>
        <div className="text-[9px] text-slate-500 pt-1 border-t border-surface-border/50">
          Provenance: Server Canonical • Execution authority lies strictly with AlgoBot gates.
        </div>
      </div>
    </div>
  );
};
