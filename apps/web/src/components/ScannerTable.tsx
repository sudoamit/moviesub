'use client';

import React, { useState } from 'react';
import { ISignalSetup } from '@quant/shared';
import { Radar, ArrowUpRight, ArrowDownRight, RefreshCw, Filter, Sparkles } from 'lucide-react';

interface ScannerTableProps {
  signals: ISignalSetup[];
  selectedSymbol: string;
  onSelectSignal: (signal: ISignalSetup) => void;
  onRefreshScan: () => void;
  isScanning: boolean;
}

export const ScannerTable: React.FC<ScannerTableProps> = ({
  signals,
  selectedSymbol,
  onSelectSignal,
  onRefreshScan,
  isScanning,
}) => {
  const [directionFilter, setDirectionFilter] = useState<'ALL' | 'LONG' | 'SHORT'>('ALL');
  const [minGradeFilter, setMinGradeFilter] = useState<'ALL' | 'A_PLUS' | 'A'>('ALL');

  const filteredSignals = signals.filter((s) => {
    if (directionFilter === 'LONG' && s.direction !== 'BULLISH') return false;
    if (directionFilter === 'SHORT' && s.direction !== 'BEARISH') return false;
    if (minGradeFilter === 'A_PLUS' && s.grade !== 'A+') return false;
    if (minGradeFilter === 'A' && s.grade !== 'A+' && s.grade !== 'A') return false;
    return true;
  });

  const getGradeStyle = (grade: string) => {
    switch (grade) {
      case 'A+':
        return 'text-emerald-400 border-emerald-500/50 bg-emerald-500/10';
      case 'A':
        return 'text-cyan-400 border-cyan-500/50 bg-cyan-500/10';
      case 'B':
        return 'text-amber-400 border-amber-500/50 bg-amber-500/10';
      default:
        return 'text-slate-400 border-slate-700 bg-slate-800';
    }
  };

  return (
    <div className="bg-[#111827]/80 backdrop-blur border border-slate-800 rounded-xl p-5 shadow-lg space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
        <div className="flex items-center gap-2">
          <Radar className="w-4 h-4 text-cyan-400 animate-pulse" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            Live Market Scanner
          </h3>
          <span className="text-[10px] text-slate-500 font-mono">
            ({filteredSignals.length} Setups)
          </span>
        </div>

        {/* Filter Toolbar */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Direction filters */}
          <div className="flex bg-slate-900 border border-slate-800 rounded p-0.5 text-xs">
            {(['ALL', 'LONG', 'SHORT'] as const).map((dir) => (
              <button
                key={dir}
                onClick={() => setDirectionFilter(dir)}
                className={`px-2.5 py-1 rounded text-[10px] font-semibold transition-all ${
                  directionFilter === dir
                    ? 'bg-slate-700 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {dir}
              </button>
            ))}
          </div>

          {/* Grade filter */}
          <div className="flex bg-slate-900 border border-slate-800 rounded p-0.5 text-xs">
            <button
              onClick={() => setMinGradeFilter('ALL')}
              className={`px-2 py-1 rounded text-[10px] font-semibold ${
                minGradeFilter === 'ALL'
                  ? 'bg-slate-700 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              All Grades
            </button>
            <button
              onClick={() => setMinGradeFilter('A')}
              className={`px-2 py-1 rounded text-[10px] font-semibold ${
                minGradeFilter === 'A'
                  ? 'bg-cyan-500 text-slate-950 font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Grade A/A+
            </button>
          </div>

          {/* Trigger Scan Button */}
          <button
            onClick={onRefreshScan}
            disabled={isScanning}
            className="flex items-center gap-1.5 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 px-3 py-1 rounded text-[11px] font-semibold transition-all disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${isScanning ? 'animate-spin' : ''}`} />
            {isScanning ? 'Scanning...' : 'Scan Now'}
          </button>
        </div>
      </div>

      {/* Scanner Table View */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs min-w-[650px]">
          <thead>
            <tr className="text-[10px] uppercase text-slate-500 border-b border-slate-800">
              <th className="pb-2.5">Asset</th>
              <th className="pb-2.5">Direction</th>
              <th className="pb-2.5">Setup Score</th>
              <th className="pb-2.5">Grade</th>
              <th className="pb-2.5">TF</th>
              <th className="pb-2.5">Entry Zone</th>
              <th className="pb-2.5">Stop Loss</th>
              <th className="pb-2.5">Target 2</th>
              <th className="pb-2.5">R:R</th>
              <th className="pb-2.5 text-right">Trigger Confluence</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            {filteredSignals.map((signal) => {
              const isSelected = selectedSymbol === signal.symbol;
              const isLong = signal.direction === 'BULLISH';

              return (
                <tr
                  key={signal.symbol}
                  onClick={() => onSelectSignal(signal)}
                  className={`cursor-pointer transition-colors ${
                    isSelected ? 'bg-cyan-500/10' : 'hover:bg-slate-800/40'
                  }`}
                >
                  <td className="py-3">
                    <div className="font-bold text-white font-mono flex items-center gap-1.5">
                      <span>{signal.symbol}</span>
                    </div>
                  </td>

                  <td className="py-3">
                    <span
                      className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-bold ${
                        isLong
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                          : 'bg-rose-500/10 text-rose-400 border border-rose-500/30'
                      }`}
                    >
                      {isLong ? (
                        <ArrowUpRight className="w-3 h-3" />
                      ) : (
                        <ArrowDownRight className="w-3 h-3" />
                      )}
                      {isLong ? 'LONG' : 'SHORT'}
                    </span>
                  </td>

                  <td className="py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-12 bg-slate-800 h-1.5 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            signal.score >= 85
                              ? 'bg-emerald-400'
                              : signal.score >= 75
                              ? 'bg-cyan-400'
                              : 'bg-amber-400'
                          }`}
                          style={{ width: `${signal.score}%` }}
                        />
                      </div>
                      <span className="font-mono font-bold text-white text-[11px]">
                        {signal.score}
                      </span>
                    </div>
                  </td>

                  <td className="py-3">
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${getGradeStyle(
                        signal.grade,
                      )}`}
                    >
                      {signal.grade}
                    </span>
                  </td>

                  <td className="py-3 text-slate-400 font-mono text-[11px]">
                    {signal.timeframe}
                  </td>

                  <td className="py-3 font-mono text-white text-[11px]">
                    {signal.entryZone.optimal}
                  </td>

                  <td className="py-3 font-mono text-rose-400 text-[11px]">
                    {signal.stopLoss}
                  </td>

                  <td className="py-3 font-mono text-emerald-400 text-[11px]">
                    {signal.takeProfits.tp2}
                  </td>

                  <td className="py-3 font-mono text-cyan-300 text-[11px] font-bold">
                    1:{signal.riskRewardRatios.rr2}
                  </td>

                  <td className="py-3 text-right">
                    <span className="text-[10px] text-slate-400 bg-slate-800/80 px-2 py-1 rounded truncate max-w-[140px] inline-block font-sans">
                      {signal.reasoning.confirmedChecklist?.[1] || 'SMC Alignment'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
