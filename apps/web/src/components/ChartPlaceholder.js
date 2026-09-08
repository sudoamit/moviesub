"use strict";
'use client';
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChartPlaceholder = ChartPlaceholder;
const react_1 = __importDefault(require("react"));
const lucide_react_1 = require("lucide-react");
function ChartPlaceholder({ symbol }) {
    return (<div className="bg-surface rounded-xl border border-surface-border flex flex-col h-full overflow-hidden">
      {/* Chart Toolbar */}
      <div className="p-3 border-b border-surface-border flex items-center justify-between bg-slate-900/40">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 font-mono">
            <span className="text-base font-bold text-white">{symbol}</span>
            <span className="text-xs px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-semibold">
              15M
            </span>
          </div>

          <div className="hidden sm:flex items-center gap-1 text-xs font-mono text-slate-400 border-l border-slate-800 pl-3">
            {['1m', '5m', '15m', '1h', '4h', '1d'].map((tf) => (<button key={tf} className={`px-2 py-0.5 rounded transition ${tf === '15m'
                ? 'bg-indigo-600 text-white font-medium'
                : 'hover:bg-slate-800 text-slate-400'}`}>
                {tf}
              </button>))}
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs font-mono">
          <div className="flex items-center gap-1 bg-slate-900 px-2.5 py-1 rounded border border-slate-800 text-slate-300">
            <lucide_react_1.Layers className="w-3.5 h-3.5 text-indigo-400"/>
            <span>SMC Overlay (Active)</span>
          </div>
          <button className="p-1.5 rounded hover:bg-slate-800 text-slate-400">
            <lucide_react_1.SlidersHorizontal className="w-4 h-4"/>
          </button>
          <button className="p-1.5 rounded hover:bg-slate-800 text-slate-400">
            <lucide_react_1.Maximize2 className="w-4 h-4"/>
          </button>
        </div>
      </div>

      {/* Chart Visual Surface */}
      <div className="flex-1 relative flex flex-col items-center justify-center p-6 bg-gradient-to-b from-surface via-[#0d121f] to-background">
        <div className="w-full h-full flex flex-col justify-between relative border border-dashed border-slate-800/60 rounded-lg p-6">
          {/* Mock Markers on Chart */}
          <div className="absolute top-8 left-1/4 px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-500 text-emerald-400 text-[10px] font-mono flex items-center gap-1 shadow-lg shadow-emerald-950">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
            BOS (Bullish Break of Structure) @ 24,810
          </div>

          <div className="absolute top-28 right-1/3 px-2 py-0.5 rounded bg-indigo-500/20 border border-indigo-500 text-indigo-300 text-[10px] font-mono flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400"></span>
            Bullish FVG Zone [24,780 - 24,805]
          </div>

          <div className="absolute bottom-16 left-1/3 px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500 text-amber-300 text-[10px] font-mono flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
            Sell-side Liquidity Swept @ 24,720
          </div>

          {/* Central Overlay Indicator */}
          <div className="m-auto text-center z-10 flex flex-col items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-indigo-600/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <lucide_react_1.BarChart3 className="w-6 h-6"/>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-200 font-mono">
                TradingView Lightweight Candlestick Chart
              </h3>
              <p className="text-xs text-slate-500 mt-1 max-w-sm">
                Interactive real-time candlestick visualizer with BOS, CHoCH, Liquidity, FVG, and
                Order Block overlays.
              </p>
            </div>
          </div>

          {/* Chart Price Scale Reference */}
          <div className="flex justify-between items-end text-[10px] font-mono text-slate-600 border-t border-slate-800/80 pt-2">
            <span>09:15</span>
            <span>11:00</span>
            <span>13:00</span>
            <span>14:30</span>
            <span>15:30 (Live)</span>
          </div>
        </div>
      </div>
    </div>);
}
//# sourceMappingURL=ChartPlaceholder.js.map