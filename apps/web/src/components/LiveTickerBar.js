"use strict";
'use client';
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LiveTickerBar = void 0;
const react_1 = __importDefault(require("react"));
const lucide_react_1 = require("lucide-react");
const LiveTickerBar = ({ tickers, selectedSymbol, onSelectSymbol, }) => {
    const assetConfig = [
        { sym: 'NIFTY', name: 'Nifty 50', tag: 'INDEX' },
        { sym: 'BANKNIFTY', name: 'Bank Nifty', tag: 'INDEX' },
        { sym: 'XAUUSD', name: 'Gold Spot', tag: 'GOLD' },
        { sym: 'BTCUSDT', name: 'Bitcoin', tag: 'CRYPTO' },
        { sym: 'RELIANCE', name: 'Reliance Ind.', tag: 'EQUITY' },
        { sym: 'HDFCBANK', name: 'HDFC Bank', tag: 'EQUITY' },
        { sym: 'INFY', name: 'Infosys', tag: 'EQUITY' },
    ];
    return (<div className="bg-[#080C14]/95 border-b border-slate-800/80 px-3 sm:px-6 py-2 overflow-x-auto">
      <div className="flex items-center gap-2.5 min-w-max">
        <div className="flex items-center gap-1.5 pr-3 border-r border-slate-800 text-[11px] font-mono text-cyan-400 font-bold uppercase tracking-wider">
          <lucide_react_1.Activity className="w-3.5 h-3.5 animate-pulse text-cyan-400"/>
          <span className="hidden sm:inline">LIVE QUOTES:</span>
        </div>

        {assetConfig.map(({ sym, name, tag }) => {
            const item = tickers[sym];
            const isSelected = selectedSymbol === sym;
            if (!item) {
                return (<div key={sym} onClick={() => onSelectSymbol(sym)} className={`cursor-pointer px-3 py-1 rounded-xl border text-xs font-mono transition-all ${isSelected
                        ? 'bg-cyan-500/10 border-cyan-500/50 text-white'
                        : 'bg-slate-900/60 border-slate-800/60 text-slate-400 hover:border-slate-700'}`}>
                <span className="font-bold">{sym}</span>
                <span className="ml-2 text-[10px] text-slate-500">Connecting...</span>
              </div>);
            }
            const isUp = item.changePercent >= 0;
            const currency = sym === 'XAUUSD' ? '$' : sym === 'BTCUSDT' ? '$' : '₹';
            return (<div key={sym} onClick={() => onSelectSymbol(sym)} className={`cursor-pointer flex items-center gap-2.5 px-3 py-1.5 rounded-xl border text-xs font-mono transition-all relative ${isSelected
                    ? 'bg-gradient-to-r from-cyan-950/60 to-slate-900 border-cyan-500/70 text-white shadow-lg shadow-cyan-500/10 ring-1 ring-cyan-500/30'
                    : 'bg-slate-900/70 border-slate-800/90 text-slate-300 hover:bg-slate-800/60 hover:border-slate-700'}`}>
              <div className="flex flex-col">
                <div className="flex items-center gap-1">
                  <span className="font-black text-white">{sym}</span>
                  <span className="text-[8px] text-slate-500 px-1 py-0.5 rounded bg-slate-950">
                    {tag}
                  </span>
                </div>
              </div>

              <div className="flex items-baseline gap-1.5">
                <span className="font-bold text-slate-100">
                  {currency}
                  {item.price?.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                })}
                </span>

                <span className={`flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded ${isUp
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'}`}>
                  {isUp ? (<lucide_react_1.ArrowUpRight className="w-3 h-3 mr-0.5"/>) : (<lucide_react_1.ArrowDownRight className="w-3 h-3 mr-0.5"/>)}
                  {isUp ? '+' : ''}
                  {item.changePercent?.toFixed(2)}%
                </span>
              </div>

              {isSelected && (<span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-cyan-400 animate-ping"/>)}
            </div>);
        })}
      </div>
    </div>);
};
exports.LiveTickerBar = LiveTickerBar;
//# sourceMappingURL=LiveTickerBar.js.map