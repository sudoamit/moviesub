'use client';

import React from 'react';
import { ArrowUpRight, ArrowDownRight, Zap } from 'lucide-react';

interface MockScannerRow {
  symbol: string;
  name: string;
  direction: 'LONG' | 'SHORT' | 'NO_TRADE';
  score: number;
  grade: 'A+' | 'A' | 'B' | 'C';
  price: string;
  change: string;
  isPositive: boolean;
  regime: string;
}

const SAMPLE_SCANNER_DATA: MockScannerRow[] = [
  {
    symbol: 'NIFTY',
    name: 'NIFTY 50 Index',
    direction: 'LONG',
    score: 87,
    grade: 'A+',
    price: '24,850.40',
    change: '+0.85%',
    isPositive: true,
    regime: 'BULLISH TREND',
  },
  {
    symbol: 'BANKNIFTY',
    name: 'NIFTY Bank',
    direction: 'SHORT',
    score: 81,
    grade: 'A',
    price: '51,320.15',
    change: '-0.42%',
    isPositive: false,
    regime: 'BEARISH TREND',
  },
  {
    symbol: 'RELIANCE',
    name: 'Reliance Industries',
    direction: 'LONG',
    score: 79,
    grade: 'B',
    price: '3,020.50',
    change: '+1.15%',
    isPositive: true,
    regime: 'RANGE',
  },
  {
    symbol: 'BTCUSDT',
    name: 'Bitcoin / USDT',
    direction: 'LONG',
    score: 76,
    grade: 'B',
    price: '92,450.00',
    change: '+3.20%',
    isPositive: true,
    regime: 'HIGH VOLATILITY',
  },
  {
    symbol: 'INFY',
    name: 'Infosys Ltd.',
    direction: 'NO_TRADE',
    score: 61,
    grade: 'C',
    price: '1,890.30',
    change: '-0.10%',
    isPositive: false,
    regime: 'LOW VOLATILITY',
  },
];

export function ScannerTableSkeleton({
  selectedSymbol,
  onSelectSymbol,
}: {
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
}) {
  return (
    <div className="bg-surface rounded-xl border border-surface-border overflow-hidden flex flex-col h-full">
      <div className="p-4 border-b border-surface-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-indigo-400" />
          <h2 className="text-sm font-semibold tracking-wide uppercase text-slate-200">
            Market Scanner (SMC Matrix)
          </h2>
        </div>
        <span className="text-xs text-slate-400 font-mono">5 Active Assets</span>
      </div>

      <div className="overflow-x-auto flex-1">
        <table className="w-full text-left text-xs font-mono">
          <thead className="bg-slate-900/70 text-slate-400 border-b border-surface-border">
            <tr>
              <th className="p-3 font-medium">INSTRUMENT</th>
              <th className="p-3 font-medium">SETUP</th>
              <th className="p-3 font-medium">SCORE</th>
              <th className="p-3 font-medium">GRADE</th>
              <th className="p-3 font-medium text-right">PRICE</th>
              <th className="p-3 font-medium">REGIME</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {SAMPLE_SCANNER_DATA.map((row) => {
              const isSelected = selectedSymbol === row.symbol;
              return (
                <tr
                  key={row.symbol}
                  onClick={() => onSelectSymbol(row.symbol)}
                  className={`cursor-pointer transition-colors ${
                    isSelected ? 'bg-indigo-950/40 border-l-2 border-indigo-500' : 'hover:bg-surface-hover'
                  }`}
                >
                  <td className="p-3">
                    <div className="font-bold text-slate-200">{row.symbol}</div>
                    <div className="text-[10px] text-slate-500">{row.name}</div>
                  </td>
                  <td className="p-3">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded font-semibold text-[11px] ${
                        row.direction === 'LONG'
                          ? 'bg-bullish/10 text-bullish border border-bullish/20'
                          : row.direction === 'SHORT'
                          ? 'bg-bearish/10 text-bearish border border-bearish/20'
                          : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {row.direction === 'LONG' && <ArrowUpRight className="w-3 h-3" />}
                      {row.direction === 'SHORT' && <ArrowDownRight className="w-3 h-3" />}
                      {row.direction}
                    </span>
                  </td>
                  <td className="p-3">
                    <div className="font-bold text-slate-200">{row.score}/100</div>
                    <div className="w-16 bg-slate-800 h-1.5 rounded-full overflow-hidden mt-1">
                      <div
                        className={`h-full ${
                          row.score >= 80 ? 'bg-indigo-500' : row.score >= 70 ? 'bg-emerald-500' : 'bg-amber-500'
                        }`}
                        style={{ width: `${row.score}%` }}
                      ></div>
                    </div>
                  </td>
                  <td className="p-3">
                    <span
                      className={`px-2 py-0.5 rounded font-bold text-xs ${
                        row.grade === 'A+'
                          ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                          : row.grade === 'A'
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          : row.grade === 'B'
                          ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                          : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {row.grade}
                    </span>
                  </td>
                  <td className="p-3 text-right">
                    <div className="font-semibold text-slate-200">{row.price}</div>
                    <div className={row.isPositive ? 'text-bullish text-[10px]' : 'text-bearish text-[10px]'}>
                      {row.change}
                    </div>
                  </td>
                  <td className="p-3">
                    <span className="text-[10px] text-slate-400 bg-slate-900 px-2 py-1 rounded border border-slate-800">
                      {row.regime}
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
}
