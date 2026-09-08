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
exports.OptionsSuiteView = void 0;
const react_1 = __importStar(require("react"));
const lucide_react_1 = require("lucide-react");
const OptionsSuiteView = ({ initialSymbol = 'NIFTY', liveSpotPrice, }) => {
    const [symbol, setSymbol] = (0, react_1.useState)(initialSymbol);
    const [selectedExpiry, setSelectedExpiry] = (0, react_1.useState)('');
    const [data, setData] = (0, react_1.useState)(null);
    const [loading, setLoading] = (0, react_1.useState)(true);
    const [viewMode, setViewMode] = (0, react_1.useState)('chain');
    const fetchOptionChain = async (sym, expiry, silent = false) => {
        try {
            if (!silent && !data)
                setLoading(true);
            const spotParam = liveSpotPrice && liveSpotPrice > 0 ? `&spotPrice=${liveSpotPrice}` : '';
            const url = `http://localhost:3001/api/options/chain?symbol=${sym}${expiry ? `&expiryDate=${expiry}` : ''}${spotParam}`;
            const res = await fetch(url);
            const json = await res.json();
            if (json) {
                setData(json);
                if (!selectedExpiry && json.selectedExpiry) {
                    setSelectedExpiry(json.selectedExpiry);
                }
            }
        }
        catch (e) {
            console.error('Failed to fetch option chain:', e);
        }
        finally {
            setLoading(false);
        }
    };
    (0, react_1.useEffect)(() => {
        fetchOptionChain(symbol, selectedExpiry, false);
        const interval = setInterval(() => {
            fetchOptionChain(symbol, selectedExpiry, true);
        }, 1500);
        return () => clearInterval(interval);
    }, [symbol, selectedExpiry, liveSpotPrice]);
    const isNifty = symbol === 'NIFTY';
    const isBankNifty = symbol === 'BANKNIFTY';
    const isBullishSentiment = data?.pcr > 1.0;
    // Max OI for bar scaling
    const maxOI = data?.strikes
        ? Math.max(...data.strikes.map((s) => Math.max(s.call.oi, s.put.oi)), 1000)
        : 100000;
    return (<div className="bg-[#0B0F19] border border-slate-800 rounded-xl p-4 sm:p-6 font-mono space-y-6">
      {/* Header & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
              <lucide_react_1.Layers className="w-5 h-5"/>
            </div>
            <div>
              <h2 className="text-base font-black text-white tracking-tight flex items-center gap-2">
                INSTITUTIONAL OPTIONS SUITE & CHAIN MATRIX
                <span className="bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 text-[10px] font-bold px-2 py-0.5 rounded">
                  BLACK-SCHOLES GREEKS
                </span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Real-time Black-Scholes-Merton pricing, Open Interest buildup, Max Pain, and
                delta-adjusted Smart Strikes.
              </p>
            </div>
          </div>
        </div>

        {/* Symbol & Expiry Pickers */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Symbol selector */}
          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5 text-xs">
            {['NIFTY', 'BANKNIFTY', 'BTCUSDT', 'XAUUSD', 'RELIANCE', 'HDFCBANK', 'INFY'].map((s) => (<button key={s} onClick={() => {
                setSymbol(s);
                setSelectedExpiry('');
            }} className={`px-2.5 py-1 rounded transition-all font-bold ${symbol === s
                ? 'bg-cyan-500 text-slate-950 shadow-sm'
                : 'text-slate-400 hover:text-white'}`}>
                  {s}
                </button>))}
          </div>

          {/* Expiry Dropdown */}
          {data?.availableExpiries && (<div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-xs">
              <lucide_react_1.Calendar className="w-3.5 h-3.5 text-cyan-400 mr-1.5"/>
              <select value={selectedExpiry || data.selectedExpiry} onChange={(e) => setSelectedExpiry(e.target.value)} className="bg-transparent text-white font-bold outline-none cursor-pointer">
                {data.availableExpiries.map((exp) => (<option key={exp.dateString} value={exp.dateString} className="bg-slate-900 text-white">
                    {exp.formattedLabel}
                  </option>))}
              </select>
            </div>)}

          <button onClick={() => fetchOptionChain(symbol, selectedExpiry)} disabled={loading} className="p-2 bg-slate-900 hover:bg-slate-800 text-slate-300 rounded-lg border border-slate-800 transition-colors">
            <lucide_react_1.RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}/>
          </button>
        </div>
      </div>

      {/* Analytics Summary Metric Strip */}
      {data && (<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
          {/* Underlying Spot */}
          <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl">
            <span className="text-[10px] text-slate-400 block uppercase">UNDERLYING SPOT</span>
            <span className="text-base font-black text-white mt-1 block">
              ₹{data.spotPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
            <span className="text-[9px] text-slate-500 block mt-0.5">Live Exchange Feed</span>
          </div>

          {/* ATM Strike */}
          <div className="bg-slate-900/90 border border-cyan-500/30 p-3 rounded-xl">
            <span className="text-[10px] text-cyan-400 block uppercase font-bold">ATM STRIKE</span>
            <span className="text-base font-black text-cyan-300 mt-1 block">
              ₹{data.atmStrike.toLocaleString()}
            </span>
            <span className="text-[9px] text-slate-500 block mt-0.5">
              Lot Size: {data.lotSize} Qty
            </span>
          </div>

          {/* Max Pain */}
          <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl">
            <span className="text-[10px] text-amber-400 block uppercase font-bold">
              MAX PAIN STRIKE
            </span>
            <span className="text-base font-black text-amber-300 mt-1 block">
              ₹{data.maxPain.toLocaleString()}
            </span>
            <span className="text-[9px] text-slate-500 block mt-0.5">
              Lowest Option Writer Loss
            </span>
          </div>

          {/* PCR Ratio */}
          <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl">
            <span className="text-[10px] text-slate-400 block uppercase">PUT-CALL RATIO (PCR)</span>
            <div className="flex items-center gap-1.5 mt-1">
              <span className={`text-base font-black ${isBullishSentiment ? 'text-emerald-400' : 'text-rose-400'}`}>
                {data.pcr}
              </span>
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${data.pcr > 1.2
                ? 'bg-emerald-500/20 text-emerald-300'
                : data.pcr < 0.8
                    ? 'bg-rose-500/20 text-rose-300'
                    : 'bg-slate-800 text-slate-300'}`}>
                {data.pcr > 1.2 ? 'BULLISH' : data.pcr < 0.8 ? 'BEARISH' : 'NEUTRAL'}
              </span>
            </div>
            <span className="text-[9px] text-slate-500 block mt-0.5">Total OI Sentiment</span>
          </div>

          {/* Expected Expiry Move */}
          <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl">
            <span className="text-[10px] text-slate-400 block uppercase">ATM STRADDLE MOVE</span>
            <span className="text-base font-black text-teal-300 mt-1 block">
              ±{data.expectedWeeklyMovePts} pts
            </span>
            <span className="text-[9px] text-slate-500 block mt-0.5">
              Implied Expiry Volatility
            </span>
          </div>

          {/* Expected Expiry Range */}
          <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl">
            <span className="text-[10px] text-slate-400 block uppercase">
              EXPECTED EXPIRY RANGE
            </span>
            <span className="text-xs font-black text-slate-200 mt-1.5 block">
              {data.expectedRange.lower.toLocaleString()} -{' '}
              {data.expectedRange.upper.toLocaleString()}
            </span>
            <span className="text-[9px] text-slate-500 block mt-0.5">1-StdDev Expected Band</span>
          </div>
        </div>)}

      {/* Smart Strike Recommendation Banner */}
      {data &&
            (() => {
                const atmRow = data.strikes.find((s) => s.isATM) || data.strikes[7];
                const isBull = isBullishSentiment;
                const opt = isBull ? atmRow.call : atmRow.put;
                const optType = isBull ? 'CE' : 'PE';
                const underlyingRisk = isBankNifty ? 85 : 30;
                const optRisk = Number(Math.max(8.0, underlyingRisk * opt.delta * 0.95).toFixed(2));
                const optSL = Number(Math.max(5.0, opt.ltp - optRisk).toFixed(2));
                const optTP1 = Number((opt.ltp + optRisk * 1.5).toFixed(2));
                const optTP2 = Number((opt.ltp + optRisk * 2.5).toFixed(2));
                const riskPerLot = optRisk * data.lotSize;
                const profitPerLot = (optTP2 - opt.ltp) * data.lotSize;
                return (<div className="bg-gradient-to-r from-slate-900 via-slate-900/90 to-slate-950 border border-cyan-500/40 rounded-xl p-4 shadow-lg space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-lg bg-cyan-500/20 text-cyan-400 border border-cyan-500/40">
                    <lucide_react_1.Sparkles className="w-5 h-5 animate-pulse"/>
                  </div>
                  <div>
                    <span className="text-[10px] text-cyan-400 font-bold uppercase tracking-wider block">
                      AI DELTA-ADJUSTED SMART STRIKE
                    </span>
                    <h3 className="text-base font-black text-white flex items-center gap-2">
                      {symbol} {data.selectedExpiry} {data.atmStrike} {optType}
                      <span className={`text-xs px-2 py-0.5 rounded font-bold ${isBull
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                        : 'bg-rose-500/20 text-rose-400 border border-rose-500/40'}`}>
                        {isBull ? 'CALL (ATM)' : 'PUT (ATM)'}
                      </span>
                    </h3>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <span className="text-[10px] text-slate-400 block">BLACK-SCHOLES PREMIUM</span>
                    <span className="text-xl font-black text-cyan-300">₹{opt.ltp.toFixed(2)}</span>
                  </div>
                </div>
              </div>

              {/* Smart Strike Execution Matrix */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <div className="bg-rose-950/20 border border-rose-500/30 p-2.5 rounded-lg">
                  <span className="text-[10px] text-rose-400 uppercase font-bold flex items-center gap-1">
                    <lucide_react_1.Shield className="w-3 h-3"/>
                    OPTION SL
                  </span>
                  <span className="text-sm font-black text-rose-400 block mt-1">
                    ₹{optSL.toFixed(2)}
                  </span>
                  <span className="text-[10px] text-slate-400 block mt-0.5">
                    Risk: -₹{riskPerLot.toFixed(0)} / lot
                  </span>
                </div>

                <div className="bg-cyan-950/20 border border-cyan-500/30 p-2.5 rounded-lg">
                  <span className="text-[10px] text-cyan-400 uppercase font-bold flex items-center gap-1">
                    <lucide_react_1.Target className="w-3 h-3"/>
                    TARGET 1 (1.5R)
                  </span>
                  <span className="text-sm font-black text-cyan-300 block mt-1">
                    ₹{optTP1.toFixed(2)}
                  </span>
                  <span className="text-[10px] text-slate-400 block mt-0.5">
                    +{(optTP1 - opt.ltp).toFixed(1)} pts
                  </span>
                </div>

                <div className="bg-emerald-950/20 border border-emerald-500/30 p-2.5 rounded-lg">
                  <span className="text-[10px] text-emerald-400 uppercase font-bold flex items-center gap-1">
                    <lucide_react_1.TrendingUp className="w-3 h-3"/>
                    TARGET 2 (2.5R)
                  </span>
                  <span className="text-sm font-black text-emerald-400 block mt-1">
                    ₹{optTP2.toFixed(2)}
                  </span>
                  <span className="text-[10px] text-slate-400 block mt-0.5">
                    Profit: +₹{profitPerLot.toFixed(0)} / lot
                  </span>
                </div>

                <div className="bg-slate-900 border border-slate-800 p-2.5 rounded-lg">
                  <span className="text-[10px] text-slate-400 uppercase font-bold">
                    GREEKS & LOT
                  </span>
                  <span className="text-sm font-black text-white block mt-1">
                    Δ {opt.delta} | Θ {opt.theta}
                  </span>
                  <span className="text-[10px] text-slate-400 block mt-0.5">
                    IV: {opt.iv}% | Lot: {data.lotSize}
                  </span>
                </div>
              </div>
            </div>);
            })()}

      {/* View Switcher Tabs (Option Chain Table vs OI Bar Visualizer) */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-2 text-xs">
        <div className="flex items-center gap-2">
          <button onClick={() => setViewMode('chain')} className={`px-3 py-1.5 rounded-lg font-bold transition-all flex items-center gap-1.5 ${viewMode === 'chain'
            ? 'bg-cyan-500 text-slate-950 shadow'
            : 'text-slate-400 hover:text-white'}`}>
            <lucide_react_1.Layers className="w-3.5 h-3.5"/>
            Full Option Chain Matrix
          </button>

          <button onClick={() => setViewMode('oi_bars')} className={`px-3 py-1.5 rounded-lg font-bold transition-all flex items-center gap-1.5 ${viewMode === 'oi_bars'
            ? 'bg-cyan-500 text-slate-950 shadow'
            : 'text-slate-400 hover:text-white'}`}>
            <lucide_react_1.BarChart2 className="w-3.5 h-3.5"/>
            Open Interest (OI) Profile
          </button>
        </div>

        <div className="text-[10px] text-slate-500 flex items-center gap-2">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400"/> Call OI (Resistance)
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-rose-400"/> Put OI (Support)
          </span>
        </div>
      </div>

      {/* 1. Main Option Chain Table */}
      {viewMode === 'chain' && data && (<div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/40">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-slate-900 text-slate-400 uppercase text-[10px] tracking-wider border-b border-slate-800">
                <th className="py-2.5 px-2 text-center bg-emerald-950/40 text-emerald-300 font-bold border-r border-slate-800" colSpan={6}>
                  CALL OPTIONS (CE)
                </th>
                <th className="py-2.5 px-3 text-center bg-slate-950 font-black text-white border-r border-slate-800">
                  STRIKE
                </th>
                <th className="py-2.5 px-2 text-center bg-rose-950/40 text-rose-300 font-bold" colSpan={6}>
                  PUT OPTIONS (PE)
                </th>
              </tr>
              <tr className="bg-slate-950 text-slate-400 text-[10px] border-b border-slate-800">
                {/* Calls */}
                <th className="py-1.5 px-2 text-left">OI</th>
                <th className="py-1.5 px-2 text-left">OI Chg</th>
                <th className="py-1.5 px-2 text-right">IV %</th>
                <th className="py-1.5 px-2 text-right">Delta</th>
                <th className="py-1.5 px-2 text-right">Theta</th>
                <th className="py-1.5 px-2 text-right text-emerald-400 border-r border-slate-800">
                  Call LTP (₹)
                </th>

                {/* Strike */}
                <th className="py-1.5 px-3 text-center text-cyan-400 font-bold border-r border-slate-800">
                  ₹ STRIKE
                </th>

                {/* Puts */}
                <th className="py-1.5 px-2 text-left text-rose-400 border-r border-slate-800/40">
                  Put LTP (₹)
                </th>
                <th className="py-1.5 px-2 text-left">Delta</th>
                <th className="py-1.5 px-2 text-left">Theta</th>
                <th className="py-1.5 px-2 text-right">IV %</th>
                <th className="py-1.5 px-2 text-right">OI Chg</th>
                <th className="py-1.5 px-2 text-right">OI</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
              {data.strikes.map((row) => {
                const isATM = row.isATM;
                const isITMCall = row.strikePrice < data.spotPrice;
                const isITMPut = row.strikePrice > data.spotPrice;
                return (<tr key={row.strikePrice} className={`transition-colors ${isATM ? 'bg-cyan-950/40 font-bold' : 'hover:bg-slate-900/60'}`}>
                    {/* Call OI */}
                    <td className={`py-2 px-2 text-left ${isITMCall ? 'bg-emerald-950/20 text-slate-200' : 'text-slate-400'}`}>
                      {row.call.oi.toLocaleString()}
                    </td>
                    <td className={`py-2 px-2 text-left ${row.call.oiChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {row.call.oiChange >= 0 ? '+' : ''}
                      {row.call.oiChange.toLocaleString()}
                    </td>
                    <td className="py-2 px-2 text-right text-slate-400">{row.call.iv}%</td>
                    <td className="py-2 px-2 text-right text-slate-300">{row.call.delta}</td>
                    <td className="py-2 px-2 text-right text-slate-400">{row.call.theta}</td>
                    <td className={`py-2 px-2 text-right font-black border-r border-slate-800 ${isITMCall ? 'bg-emerald-950/20 text-emerald-300 font-bold' : 'text-emerald-400'}`}>
                      ₹{row.call.ltp.toFixed(2)}
                    </td>

                    {/* STRIKE */}
                    <td className={`py-2 px-3 text-center font-black border-r border-slate-800 ${isATM
                        ? 'bg-cyan-500 text-slate-950 font-black shadow-md'
                        : 'bg-slate-900/90 text-white'}`}>
                      {row.strikePrice.toLocaleString()} {isATM && '★ ATM'}
                    </td>

                    {/* Put LTP */}
                    <td className={`py-2 px-2 text-left font-black border-r border-slate-800/40 ${isITMPut ? 'bg-rose-950/20 text-rose-300 font-bold' : 'text-rose-400'}`}>
                      ₹{row.put.ltp.toFixed(2)}
                    </td>
                    <td className="py-2 px-2 text-left text-slate-300">{row.put.delta}</td>
                    <td className="py-2 px-2 text-left text-slate-400">{row.put.theta}</td>
                    <td className="py-2 px-2 text-right text-slate-400">{row.put.iv}%</td>
                    <td className={`py-2 px-2 text-right ${row.put.oiChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {row.put.oiChange >= 0 ? '+' : ''}
                      {row.put.oiChange.toLocaleString()}
                    </td>
                    <td className={`py-2 px-2 text-right ${isITMPut ? 'bg-rose-950/20 text-slate-200' : 'text-slate-400'}`}>
                      {row.put.oi.toLocaleString()}
                    </td>
                  </tr>);
            })}
            </tbody>
          </table>
        </div>)}

      {/* 2. Visual Open Interest Bar Chart */}
      {viewMode === 'oi_bars' && data && (<div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4 space-y-3">
          <div className="text-xs text-slate-400 flex justify-between items-center border-b border-slate-800 pb-2">
            <span className="text-emerald-400 font-bold">CALL OI (RESISTANCE WALLS)</span>
            <span className="text-white font-bold">STRIKE</span>
            <span className="text-rose-400 font-bold">PUT OI (SUPPORT WALLS)</span>
          </div>

          <div className="space-y-2">
            {data.strikes.map((row) => {
                const callWidth = (row.call.oi / maxOI) * 100;
                const putWidth = (row.put.oi / maxOI) * 100;
                const isATM = row.isATM;
                return (<div key={row.strikePrice} className="grid grid-cols-11 items-center gap-2 text-[11px]">
                  {/* Call OI Bar */}
                  <div className="col-span-5 flex items-center justify-end gap-2">
                    <span className="text-[10px] text-slate-400">
                      {row.call.oi.toLocaleString()}
                    </span>
                    <div className="w-full bg-slate-900 h-3.5 rounded-l overflow-hidden flex justify-end">
                      <div className="bg-emerald-500 h-full rounded-l transition-all" style={{ width: `${Math.min(100, callWidth)}%` }}/>
                    </div>
                  </div>

                  {/* Strike Price */}
                  <div className={`col-span-1 text-center py-0.5 rounded text-[10px] font-black ${isATM ? 'bg-cyan-500 text-slate-950' : 'bg-slate-900 text-slate-200'}`}>
                    {row.strikePrice}
                  </div>

                  {/* Put OI Bar */}
                  <div className="col-span-5 flex items-center gap-2">
                    <div className="w-full bg-slate-900 h-3.5 rounded-r overflow-hidden">
                      <div className="bg-rose-500 h-full rounded-r transition-all" style={{ width: `${Math.min(100, putWidth)}%` }}/>
                    </div>
                    <span className="text-[10px] text-slate-400">
                      {row.put.oi.toLocaleString()}
                    </span>
                  </div>
                </div>);
            })}
          </div>
        </div>)}
    </div>);
};
exports.OptionsSuiteView = OptionsSuiteView;
//# sourceMappingURL=OptionsSuiteView.js.map