'use client';

import React, { useState, useEffect } from 'react';
import {
  Radar,
  ShieldCheck,
  ShieldAlert,
  ArrowUpRight,
  ArrowDownRight,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';

interface MTFFlowRadarWidgetProps {
  symbol?: string;
}

export const MTFFlowRadarWidget: React.FC<MTFFlowRadarWidgetProps> = ({
  symbol = 'NIFTY',
}) => {
  const [selectedSym, setSelectedSym] = useState<string>(symbol);
  const [radarData, setRadarData] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const fetchRadar = async (sym: string) => {
    try {
      setLoading(true);
      const res = await fetch(`http://localhost:3001/api/accuracy/mtf-radar?symbol=${sym}`);
      const data = await res.json();
      setRadarData(data);
    } catch (e) {
      console.error('Failed to fetch MTF radar:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRadar(selectedSym);
  }, [selectedSym]);

  const isBuy = radarData?.tradePermission === 'STRONG_BUY_AUTHORIZED';
  const isSell = radarData?.tradePermission === 'STRONG_SELL_AUTHORIZED';
  const isCaution = radarData?.tradePermission === 'CAUTION_MIXED_FLOW';

  return (
    <div className="bg-[#0B0F19] border border-slate-800 rounded-xl p-5 font-mono space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <Radar className="w-5 h-5 text-cyan-400 animate-spin" style={{ animationDuration: '6s' }} />
            <h2 className="text-base font-black text-white tracking-tight">
              4-TIER MULTI-TIMEFRAME ORDER FLOW RADAR
            </h2>
            <span className="bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 text-[10px] font-bold px-2 py-0.5 rounded">
              HTF ➔ LTF CONFLUENCE
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            4-Tier institutional matrix validating 4h Macro Trend + 1h Structure + 15m SMC Footprint + 5m Entry Trigger before authorizing execution.
          </p>
        </div>

        {/* Asset Switcher */}
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5 text-xs">
            {['NIFTY', 'BANKNIFTY', 'BTCUSDT', 'RELIANCE', 'HDFCBANK', 'INFY'].map((s) => (
              <button
                key={s}
                onClick={() => setSelectedSym(s)}
                className={`px-2.5 py-1 rounded transition-all font-bold ${
                  selectedSym === s
                    ? 'bg-cyan-500 text-slate-950 shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {s}
              </button>
            ))}
          </div>

          <button
            onClick={() => fetchRadar(selectedSym)}
            disabled={loading}
            className="p-2 bg-slate-900 hover:bg-slate-800 text-slate-300 rounded-lg border border-slate-800 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Main Trade Permission Status Bar */}
      {radarData && (
        <div
          className={`p-5 rounded-xl border transition-all ${
            isBuy
              ? 'bg-emerald-950/25 border-emerald-500/50 shadow-lg shadow-emerald-950/20'
              : isSell
              ? 'bg-rose-950/25 border-rose-500/50 shadow-lg shadow-rose-950/20'
              : 'bg-amber-950/20 border-amber-500/40'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div
                className={`w-12 h-12 rounded-xl flex items-center justify-center border ${
                  isBuy
                    ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50'
                    : isSell
                    ? 'bg-rose-500/20 text-rose-400 border-rose-500/50'
                    : 'bg-amber-500/20 text-amber-400 border-amber-500/50'
                }`}
              >
                {isBuy ? (
                  <ShieldCheck className="w-7 h-7" />
                ) : isSell ? (
                  <ShieldAlert className="w-7 h-7" />
                ) : (
                  <AlertTriangle className="w-7 h-7" />
                )}
              </div>

              <div>
                <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">
                  INSTITUTIONAL TRADE PERMISSION
                </span>
                <h3
                  className={`text-lg font-black tracking-tight ${
                    isBuy ? 'text-emerald-400' : isSell ? 'text-rose-400' : 'text-amber-400'
                  }`}
                >
                  {radarData.tradePermission === 'STRONG_BUY_AUTHORIZED'
                    ? '🟢 STRONG BUY ORDERS AUTHORIZED (FULL HTF ALIGNMENT)'
                    : radarData.tradePermission === 'STRONG_SELL_AUTHORIZED'
                    ? '🔴 STRONG SELL ORDERS AUTHORIZED (FULL HTF ALIGNMENT)'
                    : '⚠️ TRADE PROHIBITED: MIXED MULTI-TIMEFRAME ORDER FLOW'}
                </h3>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="bg-slate-900/90 border border-slate-800 px-4 py-2 rounded-lg text-right">
                <span className="text-[10px] text-slate-400 block">ALIGNED TIERS</span>
                <span className="text-lg font-black text-cyan-400">
                  {radarData.alignmentScore}/4 TIERS
                </span>
              </div>
              <div className="bg-slate-900/90 border border-slate-800 px-4 py-2 rounded-lg text-right">
                <span className="text-[10px] text-slate-400 block">CONFLUENCE INDEX</span>
                <span className="text-lg font-black text-white">
                  {radarData.totalScore}%
                </span>
              </div>
            </div>
          </div>

          <div className="mt-3 pt-3 border-t border-slate-800/60 bg-slate-950/40 p-3 rounded-lg">
            <p className="text-xs text-slate-300 font-sans leading-relaxed">
              {radarData.narrative}
            </p>
          </div>
        </div>
      )}

      {/* 4 Timeframe Tier Cards Matrix */}
      {radarData && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {[radarData.tiers.h4, radarData.tiers.h1, radarData.tiers.m15, radarData.tiers.m5].map(
            (t: any, idx: number) => {
              const isTierBull = t.direction === 'BULLISH';
              return (
                <div
                  key={idx}
                  className={`p-4 rounded-xl border transition-all ${
                    isTierBull
                      ? 'bg-emerald-950/10 border-emerald-500/30'
                      : 'bg-rose-950/10 border-rose-500/30'
                  }`}
                >
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-bold text-slate-300 uppercase">
                      {t.name}
                    </span>
                    <span
                      className={`text-[10px] font-black px-2 py-0.5 rounded flex items-center gap-1 ${
                        isTierBull
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                          : 'bg-rose-500/20 text-rose-400 border border-rose-500/40'
                      }`}
                    >
                      {isTierBull ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                      {t.direction}
                    </span>
                  </div>

                  <p className="text-[11px] text-slate-400 leading-snug font-sans">
                    {t.keyFactor}
                  </p>

                  <div className="mt-3 pt-2 border-t border-slate-800/60 flex justify-between items-center text-[10px]">
                    <span className="text-slate-500">Weight:</span>
                    <span className="font-bold text-cyan-400">{t.score}/25 Pts</span>
                  </div>
                </div>
              );
            },
          )}
        </div>
      )}
    </div>
  );
};
