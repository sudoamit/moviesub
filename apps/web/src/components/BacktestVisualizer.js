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
exports.BacktestVisualizer = void 0;
const react_1 = __importStar(require("react"));
const lucide_react_1 = require("lucide-react");
const BacktestVisualizer = ({ initialSymbol = 'NIFTY', }) => {
    const [symbol, setSymbol] = (0, react_1.useState)(initialSymbol);
    const [timeframe, setTimeframe] = (0, react_1.useState)('15m');
    const [initialCapital, setInitialCapital] = (0, react_1.useState)(100000);
    const [riskPercent, setRiskPercent] = (0, react_1.useState)(1.0);
    const [minScore, setMinScore] = (0, react_1.useState)(65);
    const [isLoading, setIsLoading] = (0, react_1.useState)(false);
    const [results, setResults] = (0, react_1.useState)(null);
    const handleRun = async () => {
        setIsLoading(true);
        try {
            const res = await fetch('http://localhost:3001/api/backtests/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    symbol,
                    timeframe,
                    initialCapital,
                    riskPerTradePercent: riskPercent,
                    minScore,
                    limit: 300,
                }),
            });
            const data = await res.json();
            setResults(data);
        }
        catch (err) {
            console.error('Backtest error:', err);
        }
        finally {
            setIsLoading(false);
        }
    };
    // Render SVG Equity curve
    const renderEquityCurve = (curve) => {
        if (!curve || curve.length < 2)
            return null;
        const equities = curve.map((c) => c.equity);
        const minEq = Math.min(...equities) * 0.99;
        const maxEq = Math.max(...equities) * 1.01;
        const range = maxEq - minEq || 1;
        const width = 600;
        const height = 140;
        const points = curve
            .map((pt, i) => {
            const x = (i / (curve.length - 1)) * width;
            const y = height - ((pt.equity - minEq) / range) * height;
            return `${x},${y}`;
        })
            .join(' ');
        return (<div className="w-full overflow-hidden bg-slate-900/90 border border-slate-800 rounded-lg p-3">
        <div className="flex justify-between text-[11px] text-slate-400 mb-2 font-mono">
          <span>Starting: ₹{initialCapital.toLocaleString()}</span>
          <span className={results.netPnL >= 0 ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
            Final: ₹{results.finalEquity?.toLocaleString()} ({results.netPnL >= 0 ? '+' : ''}
            {results.netPnL})
          </span>
        </div>
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-32 overflow-visible">
          <defs>
            <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10B981" stopOpacity="0.4"/>
              <stop offset="100%" stopColor="#10B981" stopOpacity="0.0"/>
            </linearGradient>
          </defs>
          <polygon points={`0,${height} ${points} ${width},${height}`} fill="url(#equityGrad)"/>
          <polyline fill="none" stroke="#10B981" strokeWidth="2.5" points={points} strokeLinecap="round"/>
        </svg>
      </div>);
    };
    return (<div className="bg-[#111827]/80 backdrop-blur border border-slate-800 rounded-xl p-5 shadow-lg space-y-5">
      <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-2">
          <lucide_react_1.BarChart3 className="w-4 h-4 text-cyan-400"/>
          Quantitative Historical Backtester
        </h3>
        <span className="text-[10px] text-slate-400 font-mono">Zero Look-Ahead Simulation</span>
      </div>

      {/* Inputs Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
        <div>
          <label className="text-[10px] uppercase text-slate-400 block mb-1">Asset</label>
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-white font-mono focus:outline-none">
            <option value="NIFTY">NIFTY 50</option>
            <option value="BANKNIFTY">BANKNIFTY</option>
            <option value="BTCUSDT">BTCUSDT</option>
            <option value="XAUUSD">XAUUSD (Gold Spot)</option>
            <option value="RELIANCE">RELIANCE</option>
            <option value="HDFCBANK">HDFCBANK</option>
            <option value="INFY">INFY</option>
          </select>
        </div>

        <div>
          <label className="text-[10px] uppercase text-slate-400 block mb-1">Timeframe</label>
          <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-white font-mono focus:outline-none">
            <option value="5m">5m (Scalp)</option>
            <option value="15m">15m (Intraday)</option>
            <option value="1h">1h (Swing)</option>
            <option value="4h">4h (Macro)</option>
          </select>
        </div>

        <div>
          <label className="text-[10px] uppercase text-slate-400 block mb-1">Initial Capital</label>
          <input type="number" value={initialCapital} onChange={(e) => setInitialCapital(Number(e.target.value))} className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-white font-mono focus:outline-none"/>
        </div>

        <div>
          <label className="text-[10px] uppercase text-slate-400 block mb-1">Min Setup Score</label>
          <input type="number" value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-white font-mono focus:outline-none"/>
        </div>

        <div className="flex items-end">
          <button onClick={handleRun} disabled={isLoading} className="w-full bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold py-1.5 px-3 rounded flex items-center justify-center gap-1.5 transition-all text-xs shadow-md disabled:opacity-50">
            <lucide_react_1.Play className="w-3.5 h-3.5 fill-current"/>
            {isLoading ? 'Simulating...' : 'Run Backtest'}
          </button>
        </div>
      </div>

      {/* Results View */}
      {results && (<div className="space-y-4">
          {/* Key Metrics Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 text-center text-xs">
            <div className="bg-slate-900/90 border border-slate-800 p-2.5 rounded-lg">
              <span className="text-[10px] text-slate-500 uppercase block">Win Rate</span>
              <span className="text-sm font-bold text-emerald-400 font-mono">
                {results.winRate}%
              </span>
              <span className="text-[9px] text-slate-500 block">
                {results.winningTrades}W / {results.losingTrades}L
              </span>
            </div>

            <div className="bg-slate-900/90 border border-slate-800 p-2.5 rounded-lg">
              <span className="text-[10px] text-slate-500 uppercase block">Profit Factor</span>
              <span className="text-sm font-bold text-cyan-400 font-mono">
                {results.profitFactor}
              </span>
              <span className="text-[9px] text-slate-500 block">Gross ratio</span>
            </div>

            <div className="bg-slate-900/90 border border-slate-800 p-2.5 rounded-lg">
              <span className="text-[10px] text-slate-500 uppercase block">Net PnL</span>
              <span className={`text-sm font-bold font-mono ${results.netPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                ₹{results.netPnL}
              </span>
              <span className="text-[9px] text-slate-500 block">{results.totalTrades} trades</span>
            </div>

            <div className="bg-slate-900/90 border border-slate-800 p-2.5 rounded-lg">
              <span className="text-[10px] text-slate-500 uppercase block">Avg R-Multiple</span>
              <span className="text-sm font-bold text-indigo-400 font-mono">
                +{results.averageR}R
              </span>
              <span className="text-[9px] text-slate-500 block">per trade</span>
            </div>

            <div className="bg-slate-900/90 border border-slate-800 p-2.5 rounded-lg">
              <span className="text-[10px] text-slate-500 uppercase block">Max Drawdown</span>
              <span className="text-sm font-bold text-rose-400 font-mono">
                {results.maxDrawdownPercent}%
              </span>
              <span className="text-[9px] text-slate-500 block">Peak-to-trough</span>
            </div>

            <div className="bg-slate-900/90 border border-slate-800 p-2.5 rounded-lg">
              <span className="text-[10px] text-slate-500 uppercase block">Expectancy</span>
              <span className="text-sm font-bold text-amber-400 font-mono">
                {results.expectancy}
              </span>
              <span className="text-[9px] text-slate-500 block">Math edge</span>
            </div>
          </div>

          {/* Equity Curve */}
          {results.equityCurve && renderEquityCurve(results.equityCurve)}

          {/* Trades Table */}
          {results.trades && results.trades.length > 0 && (<div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-[10px] uppercase text-slate-500 border-b border-slate-800">
                    <th className="pb-2">Trade #</th>
                    <th className="pb-2">Dir</th>
                    <th className="pb-2">Entry Time</th>
                    <th className="pb-2">Qty</th>
                    <th className="pb-2 text-cyan-400 font-bold">Margin Used</th>
                    <th className="pb-2">Entry</th>
                    <th className="pb-2">Exit</th>
                    <th className="pb-2">R-Multiple</th>
                    <th className="pb-2 text-right">PnL</th>
                    <th className="pb-2 text-right">Exit Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {results.trades.map((tr) => {
                    const margin = tr.marginRequired ||
                        Number(((tr.entryPrice * (tr.positionSize || 1)) / 5).toFixed(2));
                    return (<tr key={tr.id} className="hover:bg-slate-800/30">
                        <td className="py-2 text-slate-400 font-mono">{tr.id}</td>
                        <td className="py-2">
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${tr.direction === 'BULLISH' ? 'text-emerald-400 bg-emerald-500/10' : 'text-rose-400 bg-rose-500/10'}`}>
                            {tr.direction === 'BULLISH' ? 'LONG' : 'SHORT'}
                          </span>
                        </td>
                        <td className="py-2 text-slate-400 text-[11px] font-mono" suppressHydrationWarning>
                          {new Date(tr.entryTime).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                        })}
                        </td>
                        <td className="py-2 font-mono text-cyan-300 font-bold">
                          {tr.positionSize || 1}
                        </td>
                        <td className="py-2 font-mono text-cyan-300 font-bold">
                          ₹{margin.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                        <td className="py-2 font-mono text-white">{tr.entryPrice}</td>
                        <td className="py-2 font-mono text-white">{tr.exitPrice}</td>
                        <td className="py-2 font-mono font-bold text-cyan-400">
                          {tr.pnlRMultiple > 0 ? `+${tr.pnlRMultiple}R` : `${tr.pnlRMultiple}R`}
                        </td>
                        <td className={`py-2 text-right font-mono font-bold ${tr.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {tr.pnl >= 0 ? `+₹${tr.pnl}` : `-₹${Math.abs(tr.pnl)}`}
                        </td>
                        <td className="py-2 text-right">
                          <span className="text-[10px] text-slate-400 font-mono bg-slate-800 px-1.5 py-0.5 rounded">
                            {tr.exitReason}
                          </span>
                        </td>
                      </tr>);
                })}
                </tbody>
              </table>
            </div>)}
        </div>)}
    </div>);
};
exports.BacktestVisualizer = BacktestVisualizer;
//# sourceMappingURL=BacktestVisualizer.js.map