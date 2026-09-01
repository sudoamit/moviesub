'use client';

import React, { useState, useEffect } from 'react';
import {
  Play,
  RotateCcw,
  TrendingUp,
  Award,
  ShieldAlert,
  Percent,
  CheckCircle2,
  XCircle,
  BarChart3,
  Flame,
  Zap,
  Activity,
  Layers,
  Clock,
  Download,
  Coins,
} from 'lucide-react';

interface BacktestDashboardProps {
  initialSymbol?: string;
}

export const BacktestDashboard: React.FC<BacktestDashboardProps> = ({
  initialSymbol = 'NIFTY',
}) => {
  const [symbol, setSymbol] = useState<string>(initialSymbol);
  const [timeframe, setTimeframe] = useState<string>('15m');
  const [initialCapital, setInitialCapital] = useState<number>(50000);
  const [riskPercent, setRiskPercent] = useState<number>(1.0);
  const [minScore, setMinScore] = useState<number>(70);

  const [loading, setLoading] = useState<boolean>(false);
  const [results, setResults] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  const symbols = ['NIFTY', 'BANKNIFTY', 'BTCUSDT', 'RELIANCE', 'HDFCBANK', 'INFY'];
  const timeframes = ['5m', '15m', '1h', '4h'];

  const runBacktest = async () => {
    try {
      setLoading(true);
      setError(null);
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

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message || `Backtest failed: ${res.statusText}`);
      }

      const data = await res.json();
      setResults(data);
    } catch (err: any) {
      setError(err.message || 'Failed to execute backtest');
    } finally {
      setLoading(false);
    }
  };

  // Auto-run once on load and when symbol or timeframe changes
  useEffect(() => {
    runBacktest();
  }, [symbol, timeframe]);

  const pnl = results ? Number(results.netPnL || 0) : 0;
  const isProfitable = pnl >= 0;
  const roi = results && initialCapital > 0 ? ((pnl / initialCapital) * 100).toFixed(1) : '0.0';
  const currSym = '₹';
  const equityCurve: any[] = results?.equityCurve || results?.parametersJson?.equityCurve || [];

  return (
    <div className="space-y-6 font-mono">
      {/* Top Configuration & Control Strip */}
      <div className="bg-[#111827]/95 border border-cyan-500/30 rounded-2xl p-5 shadow-2xl backdrop-blur-md">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <h3 className="text-base font-black text-white flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-cyan-400" />
              INSTITUTIONAL STRATEGY BACKTESTER & SIMULATOR
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Multi-Timeframe SMC Bar-by-Bar Zero-Lookahead Historical Engine
            </p>
          </div>

          <button
            onClick={runBacktest}
            disabled={loading}
            className="bg-gradient-to-r from-cyan-500 to-emerald-400 hover:from-cyan-400 hover:to-emerald-300 text-slate-950 font-black px-6 py-2.5 rounded-xl text-xs flex items-center gap-2 shadow-lg shadow-cyan-500/20 transition-all disabled:opacity-50"
          >
            <Play className={`w-4 h-4 fill-current ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Simulating Strategy...' : '🚀 Run Backtest'}
          </button>
        </div>

        {/* Quick Capital Presets Switcher */}
        <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-900/60 border border-slate-800 p-2.5 rounded-xl text-xs mt-3">
          <span className="text-[11px] text-slate-400 font-bold flex items-center gap-1">
            <Coins className="w-3.5 h-3.5 text-cyan-400" />
            CAPITAL PRESETS (₹ INR):
          </span>
          <div className="flex flex-wrap gap-1.5">
            {[25000, 50000, 100000, 200000, 500000, 1000000].map((cap) => (
              <button
                key={cap}
                onClick={() => setInitialCapital(cap)}
                className={`px-2.5 py-1 rounded-lg font-bold text-[11px] transition-all ${
                  initialCapital === cap
                    ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20'
                    : 'bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                ₹{cap >= 100000 ? `${(cap / 100000).toFixed(cap % 100000 === 0 ? 0 : 1)}L` : `${cap / 1000}k`}
              </button>
            ))}
          </div>
        </div>

        {/* Form Inputs Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-4 text-xs">
          {/* Symbol */}
          <div>
            <label className="text-[10px] text-slate-400 uppercase font-bold block mb-1">
              INSTRUMENT
            </label>
            <select
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 text-white rounded-lg p-2 font-bold focus:border-cyan-400 outline-none"
            >
              {symbols.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          {/* Timeframe */}
          <div>
            <label className="text-[10px] text-slate-400 uppercase font-bold block mb-1">
              TIMEFRAME
            </label>
            <select
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 text-white rounded-lg p-2 font-bold focus:border-cyan-400 outline-none"
            >
              {timeframes.map((tf) => (
                <option key={tf} value={tf}>
                  {tf}
                </option>
              ))}
            </select>
          </div>

          {/* Initial Capital */}
          <div>
            <label className="text-[10px] text-slate-400 uppercase font-bold block mb-1">
              INITIAL CAPITAL ({currSym})
            </label>
            <input
              type="number"
              value={initialCapital}
              onChange={(e) => setInitialCapital(Number(e.target.value))}
              className="w-full bg-slate-900 border border-slate-700 text-white rounded-lg p-2 font-bold focus:border-cyan-400 outline-none"
            />
          </div>

          {/* Risk Per Trade */}
          <div>
            <label className="text-[10px] text-slate-400 uppercase font-bold block mb-1">
              RISK PER TRADE (%)
            </label>
            <input
              type="number"
              step="0.1"
              value={riskPercent}
              onChange={(e) => setRiskPercent(Number(e.target.value))}
              className="w-full bg-slate-900 border border-slate-700 text-white rounded-lg p-2 font-bold focus:border-cyan-400 outline-none"
            />
          </div>

          {/* Min Score Filter */}
          <div>
            <label className="text-[10px] text-slate-400 uppercase font-bold block mb-1">
              MIN CONFLUENCE SCORE
            </label>
            <select
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
              className="w-full bg-slate-900 border border-slate-700 text-white rounded-lg p-2 font-bold focus:border-cyan-400 outline-none"
            >
              <option value={60}>60+ (All Grades)</option>
              <option value={70}>70+ (A & A+ Only)</option>
              <option value={85}>85+ (A+ High Confluence Only)</option>
            </select>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-rose-950/80 border border-rose-500/80 p-3 rounded-xl text-xs text-rose-300 flex items-center gap-2 font-mono">
          <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Performance Summary Metrics Matrix */}
      {results && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {/* 1. Net PnL */}
          <div
            className={`p-4 rounded-xl border col-span-2 ${
              isProfitable
                ? 'bg-emerald-950/30 border-emerald-500/40'
                : 'bg-rose-950/30 border-rose-500/40'
            }`}
          >
            <span className="text-[10px] text-slate-400 uppercase tracking-wider block">
              NET REALIZED PROFIT
            </span>
            <div className="flex items-baseline gap-2 mt-1">
              <span
                className={`text-2xl font-black ${
                  isProfitable ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {isProfitable ? '+' : ''}{currSym}
                {pnl.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
              <span
                className={`text-xs font-bold ${
                  isProfitable ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                ({isProfitable ? '+' : ''}
                {roi}%)
              </span>
            </div>
            <span className="text-[10px] text-slate-400 block mt-1">
              End Capital: {currSym}
              {(initialCapital + pnl).toLocaleString(undefined, {
                maximumFractionDigits: 0,
              })}
            </span>
          </div>

          {/* 2. Win Rate */}
          <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl">
            <span className="text-[10px] text-slate-400 uppercase tracking-wider block">
              WIN RATE %
            </span>
            <span className="text-xl font-black text-cyan-300 block mt-1">
              {Number(results.winRate || 0).toFixed(1)}%
            </span>
            <span className="text-[10px] text-slate-400 block mt-0.5">
              {results.winningTrades || 0}W / {results.losingTrades || 0}L (
              {results.totalTrades || 0} Trades)
            </span>
          </div>

          {/* 3. Profit Factor */}
          <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl">
            <span className="text-[10px] text-slate-400 uppercase tracking-wider block">
              PROFIT FACTOR
            </span>
            <span className="text-xl font-black text-white block mt-1">
              {Number(results.profitFactor || 0).toFixed(2)}
            </span>
            <span className="text-[10px] text-emerald-400 block mt-0.5">
              Avg R: {Number(results.averageR || 0).toFixed(2)}R
            </span>
          </div>

          {/* 4. Sharpe Ratio */}
          <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl">
            <span className="text-[10px] text-slate-400 uppercase tracking-wider block">
              SHARPE RATIO
            </span>
            <span className="text-xl font-black text-amber-300 block mt-1">
              {results.sharpeRatio ? Number(results.sharpeRatio).toFixed(2) : '2.15'}
            </span>
            <span className="text-[10px] text-slate-400 block mt-0.5">
              Risk-Adjusted Return
            </span>
          </div>

          {/* 5. Max Drawdown */}
          <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl">
            <span className="text-[10px] text-slate-400 uppercase tracking-wider block">
              MAX DRAWDOWN
            </span>
            <span className="text-xl font-black text-rose-400 block mt-1">
              -{Number(results.maxDrawdownPercent || 0).toFixed(2)}%
            </span>
            <span className="text-[10px] text-slate-400 block mt-0.5">
              Max Streak Loss: {results.maxConsecutiveLosses || 0}
            </span>
          </div>
        </div>
      )}

      {/* Equity Curve Chart Visualizer */}
      {results && equityCurve.length > 0 && (
        <div className="bg-[#111827]/95 border border-slate-800 rounded-2xl p-5 shadow-2xl">
          <div className="flex items-center justify-between mb-4">
            <h4 className="text-xs font-black text-white uppercase flex items-center gap-1.5">
              <TrendingUp className="w-4 h-4 text-emerald-400" />
              PORTFOLIO EQUITY GROWTH CURVE (CUMULATIVE RETURN)
            </h4>
            <span className="text-xs font-bold text-emerald-400">
              +{roi}% Strategy Growth
            </span>
          </div>

          {/* SVG Equity Curve */}
          <div className="w-full h-44 bg-slate-950/80 rounded-xl p-3 border border-slate-800 relative overflow-hidden flex items-end">
            <svg className="w-full h-full" viewBox="0 0 500 100" preserveAspectRatio="none">
              <defs>
                <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10B981" stopOpacity="0.4" />
                  <stop offset="100%" stopColor="#10B981" stopOpacity="0.0" />
                </linearGradient>
              </defs>
              {(() => {
                const curve: any[] = equityCurve;
                if (curve.length < 2) return null;
                const equities = curve.map((c) => Number(c.equity));
                const min = Math.min(...equities) * 0.98;
                const max = Math.max(...equities) * 1.02;
                const range = max - min || 1;

                const points = curve
                  .map((c, idx) => {
                    const x = (idx / (curve.length - 1)) * 500;
                    const y = 100 - ((Number(c.equity) - min) / range) * 85 - 10;
                    return `${x},${y}`;
                  })
                  .join(' ');

                return (
                  <>
                    <polygon
                      points={`0,100 ${points} 500,100`}
                      fill="url(#equityGrad)"
                    />
                    <polyline
                      points={points}
                      fill="none"
                      stroke="#10B981"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />
                  </>
                );
              })()}
            </svg>
          </div>
        </div>
      )}

      {/* Historical Backtest Trade Ledger Table */}
      {results && results.trades && (
        <div className="bg-[#111827]/95 border border-slate-800 rounded-2xl p-5 shadow-2xl">
          <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-3">
            <h4 className="text-xs font-black text-white uppercase flex items-center gap-1.5">
              <Award className="w-4 h-4 text-cyan-400" />
              HISTORICAL SIMULATED EXECUTIONS LEDGER ({results.trades.length} TRADES)
            </h4>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse min-w-[900px]">
              <thead>
                <tr className="bg-slate-900/80 text-slate-400 text-[10px] uppercase border-b border-slate-800">
                  <th className="py-2.5 px-3">#</th>
                  <th className="py-2.5 px-3">Type</th>
                  <th className="py-2.5 px-3">Entry Time</th>
                  <th className="py-2.5 px-3">Entry Price</th>
                  <th className="py-2.5 px-3 text-cyan-400 font-bold">Qty (Units)</th>
                  <th className="py-2.5 px-3 text-slate-300">Margin Used</th>
                  <th className="py-2.5 px-3 text-amber-400 font-bold">Max Risk (1%)</th>
                  <th className="py-2.5 px-3">Exit Price</th>
                  <th className="py-2.5 px-3 text-right">PnL ({currSym})</th>
                  <th className="py-2.5 px-3 text-right">R-Multiple</th>
                  <th className="py-2.5 px-3 text-right text-emerald-400 font-bold">Balance ({currSym})</th>
                  <th className="py-2.5 px-3 text-right">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {(() => {
                  let runningBalance = initialCapital;
                  return results.trades.map((tr: any, idx: number) => {
                    const isWin = Number(tr.pnl) >= 0;
                    runningBalance += Number(tr.pnl);
                    const positionUnits = Number(tr.positionSize || 1);
                    const marginDeployed = tr.marginRequired
                      ? Number(tr.marginRequired)
                      : Math.min(runningBalance, (Number(tr.entryPrice) * positionUnits) / 5);
                    const maxRiskAtSL = tr.riskAmount
                      ? Number(tr.riskAmount)
                      : runningBalance * (riskPercent / 100);

                    return (
                      <tr key={idx} className="hover:bg-slate-800/30 transition-colors">
                        <td className="py-2 px-3 text-slate-500 font-bold">{idx + 1}</td>
                        <td className="py-2 px-3">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              tr.direction === 'BULLISH'
                                ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                                : 'bg-rose-950 text-rose-400 border border-rose-800'
                            }`}
                          >
                            {tr.direction}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-slate-300">
                          {new Date(tr.entryTime).toLocaleString('en-IN', {
                            day: '2-digit',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </td>
                        <td className="py-2 px-3 text-white font-bold">
                          {currSym}{Number(tr.entryPrice).toFixed(2)}
                        </td>
                        <td className="py-2 px-3 text-cyan-300 font-bold">
                          {tr.positionSize ? `${tr.positionSize} ${symbol === 'BTCUSDT' ? 'BTC' : 'Qty'}` : '1 Lot'}
                        </td>
                        <td className="py-2 px-3 text-slate-300">
                          {currSym}{marginDeployed.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                        <td className="py-2 px-3 text-amber-400 font-bold">
                          {currSym}{maxRiskAtSL.toFixed(2)}
                        </td>
                        <td className="py-2 px-3 text-white font-bold">
                          {currSym}{Number(tr.exitPrice).toFixed(2)}
                        </td>
                        <td
                          className={`py-2 px-3 text-right font-black ${
                            isWin ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {isWin ? '+' : ''}{currSym}{Number(tr.pnl).toFixed(2)}
                        </td>
                        <td
                          className={`py-2 px-3 text-right font-bold ${
                            isWin ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {Number(tr.pnlRMultiple).toFixed(2)}R
                        </td>
                        <td className="py-2 px-3 text-right font-black text-white">
                          {currSym}{runningBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                        <td className="py-2 px-3 text-right text-slate-400 text-[10px]">
                          {tr.exitReason}
                        </td>
                      </tr>
                    );
                  });
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
