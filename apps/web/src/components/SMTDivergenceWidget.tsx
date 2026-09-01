'use client';

import React, { useState, useEffect } from 'react';
import {
  Zap,
  TrendingUp,
  TrendingDown,
  ShieldCheck,
  RefreshCw,
  Layers,
  ArrowRightLeft,
  Flame,
  Activity,
  CheckCircle2,
  AlertOctagon,
} from 'lucide-react';

interface SMTTimeframeResult {
  timeframe: string;
  divergenceType: 'BEARISH_SMT' | 'BULLISH_SMT' | 'NEUTRAL';
  convictionScore: number;
  assetASwing: { type: 'HIGH' | 'LOW'; price1: number; price2: number; trend: 'HH' | 'LH' | 'LL' | 'HL' };
  assetBSwing: { type: 'HIGH' | 'LOW'; price1: number; price2: number; trend: 'HH' | 'LH' | 'LL' | 'HL' };
  narrative: string;
  actionableSignal: string;
}

export const SMTDivergenceWidget: React.FC = () => {
  const [assetA, setAssetA] = useState<string>('NIFTY');
  const [assetB, setAssetB] = useState<string>('BANKNIFTY');
  const [loading, setLoading] = useState<boolean>(true);
  const [mtfData, setMtfData] = useState<any>(null);

  const fetchSMT = async () => {
    try {
      setLoading(true);
      const res = await fetch(
        `http://localhost:3001/api/accuracy/smt-mtf?assetA=${assetA}&assetB=${assetB}`,
      );
      const data = await res.json();
      if (data && data.primary) {
        setMtfData(data);
      }
    } catch (e) {
      console.error('Failed to fetch SMT:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSMT();
    const interval = setInterval(fetchSMT, 5000);
    return () => clearInterval(interval);
  }, [assetA, assetB]);

  const selectPreset = (a: string, b: string) => {
    setAssetA(a);
    setAssetB(b);
  };

  const primary = mtfData?.primary;
  const isBearish = primary?.divergenceType === 'BEARISH_SMT';
  const isBullish = primary?.divergenceType === 'BULLISH_SMT';
  const hasDivergence = isBearish || isBullish;

  return (
    <div className="bg-[#0B0F19] border border-slate-800 rounded-xl p-5 font-mono space-y-5 shadow-2xl">
      {/* Header & Quick Benchmark Presets */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-400 animate-pulse" />
            <h2 className="text-base font-black text-white tracking-tight">
              SMT CORRELATION DIVERGENCE & MULTI-TIMEFRAME HEATMAP
            </h2>
            <span className="bg-amber-500/10 text-amber-400 border border-amber-500/30 text-[10px] font-bold px-2 py-0.5 rounded">
              INSTITUTIONAL RADAR
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Detects institutional accumulation & distribution when one benchmark makes a <strong className="text-emerald-400">Higher High (HH)</strong> while correlated benchmark makes a <strong className="text-rose-400">Lower High (LH)</strong>.
          </p>
        </div>

        {/* Pair Preset Selector & Refresh */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Quick Presets */}
          <div className="flex items-center gap-1 bg-slate-900/90 border border-slate-800 p-1 rounded-lg">
            <button
              onClick={() => selectPreset('NIFTY', 'BANKNIFTY')}
              className={`px-2 py-1 rounded text-[11px] font-black transition-all ${
                assetA === 'NIFTY' && assetB === 'BANKNIFTY'
                  ? 'bg-cyan-500 text-slate-950 shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              NIFTY / BANKNIFTY
            </button>
            <button
              onClick={() => selectPreset('BTCUSDT', 'ETHUSDT')}
              className={`px-2 py-1 rounded text-[11px] font-black transition-all ${
                assetA === 'BTCUSDT' && assetB === 'ETHUSDT'
                  ? 'bg-cyan-500 text-slate-950 shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              BTC / ETH
            </button>
            <button
              onClick={() => selectPreset('RELIANCE', 'HDFCBANK')}
              className={`px-2 py-1 rounded text-[11px] font-black transition-all ${
                assetA === 'RELIANCE' && assetB === 'HDFCBANK'
                  ? 'bg-cyan-500 text-slate-950 shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              RELIANCE / HDFC
            </button>
          </div>

          {/* Custom Selector */}
          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-1 text-xs">
            <select
              value={assetA}
              onChange={(e) => setAssetA(e.target.value)}
              className="bg-transparent text-cyan-400 font-bold outline-none px-2 cursor-pointer"
            >
              <option value="NIFTY" className="bg-slate-900 text-white">NIFTY</option>
              <option value="BTCUSDT" className="bg-slate-900 text-white">BTCUSDT</option>
              <option value="RELIANCE" className="bg-slate-900 text-white">RELIANCE</option>
            </select>
            <ArrowRightLeft className="w-3.5 h-3.5 text-slate-500 mx-1" />
            <select
              value={assetB}
              onChange={(e) => setAssetB(e.target.value)}
              className="bg-transparent text-indigo-400 font-bold outline-none px-2 cursor-pointer"
            >
              <option value="BANKNIFTY" className="bg-slate-900 text-white">BANKNIFTY</option>
              <option value="ETHUSDT" className="bg-slate-900 text-white">ETHUSDT</option>
              <option value="HDFCBANK" className="bg-slate-900 text-white">HDFCBANK</option>
              <option value="INFY" className="bg-slate-900 text-white">INFY</option>
            </select>
          </div>

          <button
            onClick={fetchSMT}
            disabled={loading}
            className="p-2 bg-slate-900 hover:bg-slate-800 text-slate-300 rounded-lg border border-slate-800 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Main Primary SMT Divergence Status Banner */}
      {primary && (
        <div
          className={`p-5 rounded-xl border transition-all ${
            isBearish
              ? 'bg-rose-950/20 border-rose-500/50 shadow-lg shadow-rose-950/30'
              : isBullish
              ? 'bg-emerald-950/20 border-emerald-500/50 shadow-lg shadow-emerald-950/30'
              : 'bg-slate-900/40 border-slate-800'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div
                className={`w-12 h-12 rounded-xl flex items-center justify-center border ${
                  isBearish
                    ? 'bg-rose-500/20 text-rose-400 border-rose-500/50'
                    : isBullish
                    ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50'
                    : 'bg-slate-800 text-slate-400 border-slate-700'
                }`}
              >
                {isBearish ? (
                  <TrendingDown className="w-6 h-6" />
                ) : isBullish ? (
                  <TrendingUp className="w-6 h-6" />
                ) : (
                  <Layers className="w-6 h-6" />
                )}
              </div>

              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">
                    15M PRIMARY SMT STATUS
                  </span>
                  <span className="bg-slate-800 text-slate-300 px-1.5 py-0.2 text-[9px] font-bold rounded border border-slate-700">
                    {assetA} vs {assetB}
                  </span>
                </div>
                <h3
                  className={`text-base sm:text-lg font-black tracking-tight mt-0.5 ${
                    isBearish
                      ? 'text-rose-400'
                      : isBullish
                      ? 'text-emerald-400'
                      : 'text-slate-300'
                  }`}
                >
                  {primary.divergenceType === 'BEARISH_SMT'
                    ? `🔥 BEARISH SMT DISTRIBUTION (${assetA} ${primary.assetASwing.trend} vs ${assetB} ${primary.assetBSwing.trend})`
                    : primary.divergenceType === 'BULLISH_SMT'
                    ? `🔥 BULLISH SMT ACCUMULATION (${assetA} ${primary.assetASwing.trend} vs ${assetB} ${primary.assetBSwing.trend})`
                    : 'SYNCHRONIZED BENCHMARK CORRELATION (NO SMT DIVERGENCE)'}
                </h3>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="bg-slate-900/90 border border-slate-800 px-3.5 py-1.5 rounded-lg text-right">
                <span className="text-[10px] text-slate-400 block">CONVICTION</span>
                <span className="text-base font-black text-cyan-400">
                  {primary.convictionScore}/100
                </span>
              </div>

              <div className="bg-slate-900/90 border border-slate-800 px-3.5 py-1.5 rounded-lg text-right">
                <span className="text-[10px] text-slate-400 block">ACTION SIGNAL</span>
                <span
                  className={`text-xs font-black px-2 py-0.5 rounded inline-block mt-0.5 ${
                    primary.actionableSignal === 'STRONG_SELL'
                      ? 'bg-rose-500/20 text-rose-400 border border-rose-500/40'
                      : primary.actionableSignal === 'STRONG_BUY'
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                      : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {primary.actionableSignal}
                </span>
              </div>
            </div>
          </div>

          {/* Narrative description */}
          <div className="mt-3 pt-3 border-t border-slate-800/60 bg-slate-950/50 p-2.5 rounded-lg">
            <p className="text-xs text-slate-300 leading-relaxed font-sans">
              {primary.narrative}
            </p>
          </div>
        </div>
      )}

      {/* SECTION 2: LIVE MULTI-TIMEFRAME DIVERGENCE HEATMAP */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-cyan-400" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
              Live Multi-Timeframe Divergence Heatmap Matrix
            </h3>
          </div>
          {mtfData && (
            <span className="text-[11px] font-bold text-slate-400 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></span>
              Confluence: <strong className="text-cyan-300">{mtfData.divergenceConfluenceCount || 0} / 6 Timeframes Diverging</strong>
            </span>
          )}
        </div>

        {/* Heatmap Grid Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 pt-1">
          {mtfData?.timeframeResults?.map((tfItem: SMTTimeframeResult) => {
            const isTFBearish = tfItem.divergenceType === 'BEARISH_SMT';
            const isTFBullish = tfItem.divergenceType === 'BULLISH_SMT';
            const isTFActive = isTFBearish || isTFBullish;

            const labelMap: Record<string, string> = {
              M1: '1m Scalp',
              M5: '5m Intraday',
              M15: '15m Micro',
              H1: '1h Trend',
              H4: '4h Macro',
              D1: '1d Daily',
            };

            return (
              <div
                key={tfItem.timeframe}
                className={`p-3 rounded-xl border text-center transition-all ${
                  isTFBearish
                    ? 'bg-rose-950/30 border-rose-500/60 text-rose-300 shadow-md shadow-rose-950/20'
                    : isTFBullish
                    ? 'bg-emerald-950/30 border-emerald-500/60 text-emerald-300 shadow-md shadow-emerald-950/20'
                    : 'bg-slate-950/60 border-slate-800 text-slate-400'
                }`}
              >
                <div className="flex items-center justify-between text-[10px] mb-1 font-bold">
                  <span className="text-white font-mono">{labelMap[tfItem.timeframe] || tfItem.timeframe}</span>
                  {isTFActive ? (
                    <span className="px-1 py-0.2 rounded text-[8px] bg-cyan-950 text-cyan-300 border border-cyan-700">
                      {tfItem.convictionScore}%
                    </span>
                  ) : (
                    <span className="text-slate-600 text-[8px]">SYNC</span>
                  )}
                </div>

                <div className="mt-1">
                  <span
                    className={`text-xs font-black block tracking-tight ${
                      isTFBearish ? 'text-rose-400' : isTFBullish ? 'text-emerald-400' : 'text-slate-500'
                    }`}
                  >
                    {isTFBearish ? 'BEARISH SMT' : isTFBullish ? 'BULLISH SMT' : 'SYNCHRONIZED'}
                  </span>
                  <span className="text-[9px] text-slate-400 block mt-0.5 font-mono">
                    {isTFActive
                      ? `${tfItem.assetASwing.trend} vs ${tfItem.assetBSwing.trend}`
                      : 'Aligned Swings'}
                  </span>
                </div>

                <div className="mt-2 pt-1.5 border-t border-slate-800/80 text-[8px] text-slate-400 flex items-center justify-center gap-1">
                  {isTFBearish ? (
                    <span className="text-rose-400 font-bold">⚠️ Liquidity Sweep</span>
                  ) : isTFBullish ? (
                    <span className="text-emerald-400 font-bold">⚡ Accumulation</span>
                  ) : (
                    <span className="text-slate-500">In Equilibrium</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* SECTION 3: Comparative Swing Nodes Footprint Breakdown */}
      {primary && hasDivergence && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-slate-900/60 border border-slate-800 p-4 rounded-xl space-y-2">
            <div className="flex justify-between items-center text-xs">
              <span className="text-cyan-400 font-bold">{assetA} Swing Footprint</span>
              <span className="bg-cyan-950 text-cyan-400 px-2 py-0.5 rounded text-[10px] font-bold border border-cyan-800">
                Pattern: {primary.assetASwing.trend} ({primary.assetASwing.type === 'HIGH' ? 'Highs' : 'Lows'})
              </span>
            </div>
            <div className="text-xs space-y-1 text-slate-300">
              <div className="flex justify-between">
                <span className="text-slate-400">Previous Swing:</span>
                <span className="font-bold text-white">₹{primary.assetASwing.price1.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Current Swing:</span>
                <span className="font-bold text-cyan-300">₹{primary.assetASwing.price2.toFixed(2)}</span>
              </div>
            </div>
          </div>

          <div className="bg-slate-900/60 border border-slate-800 p-4 rounded-xl space-y-2">
            <div className="flex justify-between items-center text-xs">
              <span className="text-indigo-400 font-bold">{assetB} Swing Footprint</span>
              <span className="bg-indigo-950 text-indigo-400 px-2 py-0.5 rounded text-[10px] font-bold border border-indigo-800">
                Pattern: {primary.assetBSwing.trend} ({primary.assetBSwing.type === 'HIGH' ? 'Highs' : 'Lows'})
              </span>
            </div>
            <div className="text-xs space-y-1 text-slate-300">
              <div className="flex justify-between">
                <span className="text-slate-400">Previous Swing:</span>
                <span className="font-bold text-white">₹{primary.assetBSwing.price1.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Current Swing:</span>
                <span className="font-bold text-indigo-300">₹{primary.assetBSwing.price2.toFixed(2)}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
