"use strict";
'use client';
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SmartStrikeCard = void 0;
const react_1 = __importStar(require("react"));
const lucide_react_1 = require("lucide-react");
const SmartStrikeCard = ({ symbol, direction, spotPrice, onOpenChain, }) => {
    const [data, setData] = (0, react_1.useState)(null);
    const [loading, setLoading] = (0, react_1.useState)(true);
    const [lastLtp, setLastLtp] = (0, react_1.useState)(null);
    const [priceFlash, setPriceFlash] = (0, react_1.useState)(null);
    const [selectedStrike, setSelectedStrike] = (0, react_1.useState)(null);
    const isIndex = symbol === 'NIFTY' || symbol === 'BANKNIFTY';
    const isBull = direction === 'BULLISH';
    const optType = isBull ? 'CE' : 'PE';
    const fetchSmartStrike = react_1.default.useCallback(async (silent = false) => {
        if (!isIndex)
            return;
        try {
            if (!silent && !data)
                setLoading(true);
            const url = `http://localhost:3001/api/options/smart-strike?symbol=${symbol}&direction=${direction}&spotPrice=${spotPrice || 24080}${selectedStrike ? `&strike=${selectedStrike}` : ''}`;
            const res = await fetch(url);
            const json = await res.json();
            if (json && json.optionLtp) {
                if (data && json.optionLtp !== data.optionLtp) {
                    setPriceFlash(json.optionLtp > data.optionLtp ? 'up' : 'down');
                    setTimeout(() => setPriceFlash(null), 800);
                }
                setData(json);
                setLastLtp(json.optionLtp);
            }
        }
        catch {
            // ignore network error
        }
        finally {
            setLoading(false);
        }
    }, [symbol, direction, spotPrice, isIndex, data, selectedStrike]);
    (0, react_1.useEffect)(() => {
        fetchSmartStrike(false);
        const interval = setInterval(() => {
            fetchSmartStrike(true);
        }, 1500);
        return () => clearInterval(interval);
    }, [symbol, direction, spotPrice, selectedStrike]);
    if (!isIndex)
        return null;
    // Available strikes for fast selection
    const step = symbol === 'NIFTY' ? 50 : 100;
    const atm = Math.round((spotPrice || 24080) / step) * step;
    const strikeOptions = symbol === 'NIFTY'
        ? [23950, 24000, 24050, 24100, 24150, 24200]
        : [atm - 200, atm - 100, atm, atm + 100, atm + 200];
    return (<div className="bg-[#111827]/95 border border-cyan-500/40 rounded-xl p-4 shadow-xl font-mono relative overflow-hidden">
      {/* Background Accent */}
      <div className={`absolute -top-10 -right-10 w-32 h-32 rounded-full blur-2xl opacity-15 pointer-events-none ${isBull ? 'bg-emerald-500' : 'bg-rose-500'}`}/>

      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
            <lucide_react_1.Sparkles className="w-4 h-4"/>
          </div>
          <div>
            <h4 className="text-xs font-black text-white flex items-center gap-1.5 uppercase">
              SMART OPTION STRIKE SELECTOR
            </h4>
            <span className="text-[10px] text-slate-400">
              Delta-Adjusted {symbol} {data?.optionType || (isBull ? 'CE' : 'PE')} Derivative •
              Expiry: Tuesday
            </span>
          </div>
        </div>

        <button onClick={onOpenChain} className="bg-slate-900 hover:bg-slate-800 text-cyan-300 border border-cyan-500/40 px-2.5 py-1 rounded-md text-[11px] font-bold flex items-center gap-1 transition-all">
          <lucide_react_1.Layers className="w-3 h-3 text-cyan-400"/>
          View Full Chain
        </button>
      </div>

      {/* Strike Quick Selector Chips */}
      <div className="flex items-center gap-1.5 pt-2.5 overflow-x-auto">
        <span className="text-[10px] text-slate-500 uppercase font-bold pr-1">Strike:</span>
        {strikeOptions.map((s) => {
            const isSelected = selectedStrike === s || (!selectedStrike && data?.recommendedStrike === s);
            return (<button key={s} onClick={() => setSelectedStrike(s)} className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all ${isSelected
                    ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/30'
                    : 'bg-slate-900 text-slate-400 border border-slate-800 hover:border-slate-700 hover:text-white'}`}>
              {s} {optType}
            </button>);
        })}
      </div>

      {/* Main Strike Card Body */}
      {loading ? (<div className="py-6 text-center text-slate-500 text-xs animate-pulse">
          Calculating Black-Scholes Delta & Option Premiums...
        </div>) : data ? (<div className="mt-3 space-y-3">
          {/* Recommended Contract & Premium */}
          <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-900/90 border border-slate-800 p-3 rounded-lg">
            <div>
              <span className="text-[10px] text-slate-400 uppercase block">
                RECOMMENDED CONTRACT
              </span>
              <span className="text-sm sm:text-base font-black text-white flex items-center gap-1.5 mt-0.5">
                {data.contractName}
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${isBull
                ? 'bg-emerald-950 text-emerald-300 border border-emerald-700'
                : 'bg-rose-950 text-rose-300 border border-rose-700'}`}>
                  {data.recommendedStrike === atm
                ? isBull
                    ? 'CALL (ATM)'
                    : 'PUT (ATM)'
                : data.recommendedStrike < atm
                    ? isBull
                        ? 'CALL (ITM)'
                        : 'PUT (OTM)'
                    : isBull
                        ? 'CALL (OTM)'
                        : 'PUT (ITM)'}
                </span>
              </span>
            </div>

            <div className="text-right">
              <div className="flex items-center justify-end gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                <span className="text-[10px] text-slate-400 uppercase">LIVE PREMIUM (LTP)</span>
              </div>
              <span className={`text-xl font-black block transition-all duration-300 ${priceFlash === 'up'
                ? 'text-emerald-400 scale-105'
                : priceFlash === 'down'
                    ? 'text-rose-400 scale-105'
                    : 'text-cyan-300'}`}>
                ₹{data.optionLtp.toFixed(2)}
              </span>
            </div>
          </div>

          {/* Option Risk & Reward Matrix */}
          <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
            {/* Option SL */}
            <div className="bg-rose-950/20 border border-rose-500/30 p-2 rounded-lg">
              <span className="text-[9px] text-rose-400 uppercase font-bold flex items-center justify-center gap-1">
                <lucide_react_1.Shield className="w-2.5 h-2.5"/>
                OPTION SL
              </span>
              <span className="text-xs font-black text-rose-400 block mt-1">
                ₹{data.optionStopLoss.toFixed(2)}
              </span>
              <span className="text-[9px] text-slate-400 block mt-0.5">
                Max Loss: -₹{data.riskAmountPerLot.toFixed(0)}/lot
              </span>
            </div>

            {/* Option TP1 */}
            <div className="bg-cyan-950/20 border border-cyan-500/30 p-2 rounded-lg">
              <span className="text-[9px] text-cyan-400 uppercase font-bold flex items-center justify-center gap-1">
                <lucide_react_1.Target className="w-2.5 h-2.5"/>
                TARGET 1 (1.5R)
              </span>
              <span className="text-xs font-black text-cyan-300 block mt-1">
                ₹{data.optionTarget1.toFixed(2)}
              </span>
              <span className="text-[9px] text-slate-400 block mt-0.5">
                +{(data.optionTarget1 - data.optionLtp).toFixed(1)} pts
              </span>
            </div>

            {/* Option TP2 */}
            <div className="bg-emerald-950/20 border border-emerald-500/30 p-2 rounded-lg">
              <span className="text-[9px] text-emerald-400 uppercase font-bold flex items-center justify-center gap-1">
                <lucide_react_1.TrendingUp className="w-2.5 h-2.5"/>
                TARGET 2 (2.5R)
              </span>
              <span className="text-xs font-black text-emerald-400 block mt-1">
                ₹{data.optionTarget2.toFixed(2)}
              </span>
              <span className="text-[9px] text-emerald-400 block mt-0.5 font-bold">
                +{data.roiPercent}% ROI
              </span>
            </div>
          </div>

          {/* Quick Metrics Bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[10px] text-slate-400 bg-slate-950/60 p-2 rounded border border-slate-800 font-mono">
            <div>
              <span className="text-slate-500 block">Expiry:</span>
              <strong className="text-cyan-400 block truncate">
                {data.expiryLabel || `${data.daysToExpiry}D Left`}
              </strong>
            </div>
            <div>
              <span className="text-slate-500 block">Delta (Δ) / Theta (Θ):</span>
              <strong className="text-white block">
                {data.delta} | ₹{data.theta}/d
              </strong>
            </div>
            <div>
              <span className="text-slate-500 block">IV % / Lot Size:</span>
              <strong className="text-white block">
                {data.iv}% | {data.lotSize} Qty
              </strong>
            </div>
            <div>
              <span className="text-slate-500 block">Max Expected Profit:</span>
              <strong className="text-emerald-400 block">
                +₹{data.expectedProfitPerLot.toFixed(0)}/lot
              </strong>
            </div>
          </div>
        </div>) : null}
    </div>);
};
exports.SmartStrikeCard = SmartStrikeCard;
//# sourceMappingURL=SmartStrikeCard.js.map