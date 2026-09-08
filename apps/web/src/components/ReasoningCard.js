"use strict";
'use client';
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReasoningCard = void 0;
const react_1 = __importDefault(require("react"));
const lucide_react_1 = require("lucide-react");
const ReasoningCard = ({ signal }) => {
    if (!signal || !signal.reasoning) {
        return (<div className="bg-[#0B0F19] border border-slate-800 rounded-xl p-6 shadow-2xl space-y-3 font-mono">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-300 flex items-center gap-2">
          <lucide_react_1.Compass className="w-4 h-4 text-cyan-400"/>
          Quantitative Trade Rationale & Institutional Footprint
        </h3>
        <p className="text-xs text-slate-500">
          Select an asset to view its multi-confluence SMC footprint, institutional liquidity sweep
          mechanics, and structural checklist.
        </p>
      </div>);
    }
    const { symbol, timeframe, direction, score, grade, reasoning, entryZone, stopLoss, takeProfits, riskRewardRatios, } = signal;
    const isUsd = symbol === 'BTCUSDT' || symbol === 'XAUUSD' || symbol === 'GOLD';
    const currencySymbol = isUsd ? '$' : '₹';
    const riskPts = Math.abs(entryZone.optimal - stopLoss).toFixed(2);
    const rewardPts = Math.abs(takeProfits.tp2 - entryZone.optimal).toFixed(2);
    const isBull = direction === 'BULLISH';
    return (<div className="bg-[#0B0F19] border border-slate-800 rounded-xl p-4 sm:p-6 shadow-2xl space-y-5 font-mono relative overflow-hidden">
      {/* Ambient background glow */}
      <div className="absolute top-0 right-0 w-80 h-80 bg-cyan-500/5 rounded-full blur-3xl pointer-events-none"/>

      {/* Header Bar with Symbol, Direction & Score */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shadow-lg shadow-cyan-500/10">
            <lucide_react_1.Sparkles className="w-5 h-5"/>
          </div>

          <div>
            <div className="flex items-center gap-2">
              <span className="text-base font-black text-white tracking-tight">{symbol}</span>
              <span className="text-[10px] text-slate-400 bg-slate-900 px-2 py-0.5 rounded border border-slate-800 font-bold">
                {timeframe}
              </span>
              <span className={`text-xs font-black px-2.5 py-0.5 rounded-lg flex items-center gap-1 ${isBull
            ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-500/40 shadow-sm shadow-emerald-950'
            : 'bg-rose-950/80 text-rose-400 border border-rose-500/40 shadow-sm shadow-rose-950'}`}>
                {isBull ? (<lucide_react_1.ArrowUpRight className="w-3.5 h-3.5"/>) : (<lucide_react_1.ArrowDownRight className="w-3.5 h-3.5"/>)}
                {direction} {isBull ? 'LONG' : 'SHORT'}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              High-expectancy institutional setup scored across multi-timeframe liquidity sweeps and
              order blocks.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="bg-slate-900/90 border border-slate-800 px-3 py-1.5 rounded-xl flex items-center gap-2">
            <span className="text-[11px] text-slate-400">Setup Quality:</span>
            <strong className="text-cyan-400 text-sm font-black">{score}/100</strong>
            <span className="text-[10px] bg-cyan-950 text-cyan-300 border border-cyan-800 px-1.5 py-0.5 rounded font-bold">
              {grade}
            </span>
          </div>

          <div className="bg-emerald-950/40 border border-emerald-800/40 px-3 py-1.5 rounded-xl text-emerald-300 font-bold text-xs">
            R:R 1:{riskRewardRatios?.rr2 || 2.5}
          </div>
        </div>
      </div>

      {/* Executive Summary Thesis Box */}
      <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl shadow-inner space-y-1.5">
        <div className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-cyan-400">
          <lucide_react_1.Zap className="w-3.5 h-3.5"/>
          QUANTITATIVE TRADE THESIS & STRUCTURAL LOGIC
        </div>
        <p className="text-xs text-slate-200 leading-relaxed font-sans font-normal">
          {reasoning.summary}
        </p>
      </div>

      {/* Confirmed Technical Checklist */}
      <div>
        <h4 className="text-xs font-black text-slate-400 uppercase tracking-wider mb-2.5 flex items-center gap-1.5">
          <lucide_react_1.CheckCircle2 className="w-4 h-4 text-emerald-400"/>
          INSTITUTIONAL CONFLUENCE CRITERIA ({reasoning.confirmedChecklist?.length || 0} CONFIRMED)
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {reasoning.confirmedChecklist?.map((item, idx) => (<div key={idx} className="flex items-center gap-2.5 bg-slate-900/80 border border-slate-800/90 px-3.5 py-2.5 rounded-xl text-xs text-slate-200 hover:border-slate-700 transition-all">
              <div className="w-4 h-4 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
                <lucide_react_1.CheckCircle2 className="w-3.5 h-3.5"/>
              </div>
              <span className="truncate">{item}</span>
            </div>))}
        </div>
      </div>

      {/* 4 Structural Breakdown Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
        <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-bold text-cyan-400">
            <lucide_react_1.Compass className="w-4 h-4 text-cyan-400"/>
            1. Higher-Timeframe Trend & Structure
          </div>
          <p className="text-xs text-slate-300 leading-relaxed font-sans">
            {reasoning.htfStructure}
          </p>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-bold text-amber-400">
            <lucide_react_1.Layers className="w-4 h-4 text-amber-400"/>
            2. Institutional Trigger & Footprint
          </div>
          <p className="text-xs text-slate-300 leading-relaxed font-sans">
            {reasoning.triggerReason}
          </p>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-400">
            <lucide_react_1.Target className="w-4 h-4 text-emerald-400"/>
            3. Liquidity Sweep & Target Pools
          </div>
          <p className="text-xs text-slate-300 leading-relaxed font-sans">
            {reasoning.liquidityReason}
          </p>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-bold text-rose-400">
            <lucide_react_1.ShieldAlert className="w-4 h-4 text-rose-400"/>
            4. Invalidation & Risk Parameters
          </div>
          <p className="text-xs text-slate-300 leading-relaxed font-sans">
            {reasoning.invalidationReason}
          </p>
        </div>
      </div>

      {/* Trade Geometry Levels Matrix */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
        <div className="bg-cyan-950/30 border border-cyan-500/40 p-3 rounded-xl">
          <span className="text-[10px] text-cyan-400 uppercase font-bold block">Optimal Entry</span>
          <span className="text-base font-black text-cyan-200 block mt-0.5">
            {currencySymbol}
            {entryZone.optimal.toFixed(2)}
          </span>
          <span className="text-[9px] text-slate-400 block mt-0.5">Limit Execution</span>
        </div>

        <div className="bg-rose-950/30 border border-rose-500/40 p-3 rounded-xl">
          <span className="text-[10px] text-rose-400 uppercase font-bold block">
            Stop Loss (SL)
          </span>
          <span className="text-base font-black text-rose-300 block mt-0.5">
            {currencySymbol}
            {stopLoss.toFixed(2)}
          </span>
          <span className="text-[9px] text-rose-400/80 block mt-0.5">-{riskPts} pts risk</span>
        </div>

        <div className="bg-emerald-950/30 border border-emerald-500/40 p-3 rounded-xl">
          <span className="text-[10px] text-emerald-400 uppercase font-bold block">
            Target 1 (1.5R)
          </span>
          <span className="text-base font-black text-emerald-300 block mt-0.5">
            {currencySymbol}
            {takeProfits.tp1.toFixed(2)}
          </span>
          <span className="text-[9px] text-emerald-400/80 block mt-0.5">Scale-Out 50%</span>
        </div>

        <div className="bg-teal-950/30 border border-teal-500/40 p-3 rounded-xl">
          <span className="text-[10px] text-teal-400 uppercase font-bold block">
            Target 2 (2.5R)
          </span>
          <span className="text-base font-black text-teal-300 block mt-0.5">
            {currencySymbol}
            {takeProfits.tp2.toFixed(2)}
          </span>
          <span className="text-[9px] text-teal-400/80 block mt-0.5">+{rewardPts} pts gain</span>
        </div>
      </div>
    </div>);
};
exports.ReasoningCard = ReasoningCard;
//# sourceMappingURL=ReasoningCard.js.map