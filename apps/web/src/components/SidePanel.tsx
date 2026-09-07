'use client';

import React from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  Compass,
  Crosshair,
  TrendingUp,
  Scale,
  ShieldAlert,
} from 'lucide-react';

export function SidePanel({ symbol }: { symbol: string }) {
  return (
    <div className="bg-surface rounded-xl border border-surface-border p-4 flex flex-col gap-5 h-full overflow-y-auto font-mono text-xs">
      {/* Header Summary */}
      <div className="border-b border-surface-border pb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-slate-400 font-semibold uppercase">SETUP ANALYSIS</span>
          <span className="px-2 py-0.5 rounded bg-bullish/10 text-bullish border border-bullish/20 font-bold">
            LONG SETUP
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-2xl font-bold text-white tracking-tight">87 / 100</span>
          <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 font-bold border border-blue-500/30">
            GRADE A+
          </span>
        </div>
        <p className="text-[10px] text-slate-500 mt-1">
          Analytical scoring based on multi-timeframe SMC alignment.
        </p>
      </div>

      {/* Trade Parameters */}
      <div className="space-y-2 bg-slate-900/60 p-3 rounded-lg border border-surface-border">
        <div className="text-[11px] font-semibold text-slate-300 flex items-center gap-1.5 mb-2">
          <Crosshair className="w-3.5 h-3.5 text-indigo-400" />
          <span>EXECUTION BOUNDARIES</span>
        </div>
        <div className="flex justify-between py-1 border-b border-slate-800/80">
          <span className="text-slate-400">Entry Price:</span>
          <span className="font-bold text-slate-100">24,850.00</span>
        </div>
        <div className="flex justify-between py-1 border-b border-slate-800/80">
          <span className="text-slate-400">Invalidation (SL):</span>
          <span className="font-bold text-bearish">24,770.00</span>
        </div>
        <div className="flex justify-between py-1 border-b border-slate-800/80">
          <span className="text-slate-400">Target 1 (1.5R):</span>
          <span className="font-bold text-bullish">24,970.00</span>
        </div>
        <div className="flex justify-between py-1 border-b border-slate-800/80">
          <span className="text-slate-400">Target 2 (2.0R):</span>
          <span className="font-bold text-bullish">25,090.00</span>
        </div>
        <div className="flex justify-between pt-1">
          <span className="text-slate-400">Risk : Reward</span>
          <span className="font-bold text-indigo-400">1 : 2.80</span>
        </div>
      </div>

      {/* Multi-Timeframe Bias */}
      <div className="space-y-2">
        <div className="text-[11px] font-semibold text-slate-300 flex items-center gap-1.5">
          <Compass className="w-3.5 h-3.5 text-indigo-400" />
          <span>MULTI-TIMEFRAME BIAS</span>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="bg-slate-900 p-2 rounded border border-slate-800">
            <div className="text-[10px] text-slate-500">4H HTF</div>
            <div className="text-bullish font-bold text-xs mt-0.5">BULLISH</div>
          </div>
          <div className="bg-slate-900 p-2 rounded border border-slate-800">
            <div className="text-[10px] text-slate-500">1H BIAS</div>
            <div className="text-bullish font-bold text-xs mt-0.5">BULLISH</div>
          </div>
          <div className="bg-slate-900 p-2 rounded border border-slate-800">
            <div className="text-[10px] text-slate-500">15M SETUP</div>
            <div className="text-indigo-400 font-bold text-xs mt-0.5">SWEEP+BOS</div>
          </div>
        </div>
      </div>

      {/* Why This Trade Section */}
      <div className="space-y-2">
        <div className="text-[11px] font-semibold text-slate-300 flex items-center gap-1.5">
          <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
          <span>WHY THIS TRADE?</span>
        </div>
        <div className="space-y-1.5 bg-slate-900/40 p-3 rounded-lg border border-slate-800/80 text-[11px]">
          <div className="flex items-start gap-2 text-slate-300">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
            <span>4H & 1H higher timeframe structure confirmed bullish</span>
          </div>
          <div className="flex items-start gap-2 text-slate-300">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
            <span>Sell-side liquidity swept below 24,720</span>
          </div>
          <div className="flex items-start gap-2 text-slate-300">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
            <span>15M bullish BOS confirmed on candle close with displacement</span>
          </div>
          <div className="flex items-start gap-2 text-slate-300">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
            <span>Entry inside discount dealing range (below 50% equilibrium)</span>
          </div>
        </div>
      </div>

      {/* Risk Factors */}
      <div className="space-y-2">
        <div className="text-[11px] font-semibold text-slate-300 flex items-center gap-1.5">
          <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
          <span>RISK FACTORS</span>
        </div>
        <div className="space-y-1.5 bg-amber-950/20 p-3 rounded-lg border border-amber-900/30 text-[11px]">
          <div className="flex items-start gap-2 text-amber-200/90">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
            <span>Nearby resistance zone at 24,980 (HTF Swing High)</span>
          </div>
          <div className="flex items-start gap-2 text-amber-200/90">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
            <span>ADX indicates expanding volatility; keep strict SL</span>
          </div>
        </div>
      </div>

      {/* Disclaimer */}
      <div className="mt-auto pt-3 border-t border-surface-border text-[9px] text-slate-500 leading-relaxed">
        <strong className="text-slate-400">Disclaimer:</strong> Signals are analytical model outputs
        and not guaranteed investment recommendations. Always manage risk.
      </div>
    </div>
  );
}
