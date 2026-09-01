'use client';

import React, { useState, useEffect } from 'react';
import {
  Calendar,
  Activity,
  AlertTriangle,
  ShieldAlert,
  Clock,
  ExternalLink,
  Zap,
  CheckCircle2,
  TrendingUp,
  TrendingDown,
  Info,
} from 'lucide-react';

export const MacroCalendarWidget: React.FC = () => {
  const [calendarData, setCalendarData] = useState<any>(null);
  const [vixData, setVixData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const fetchMacroData = async () => {
    try {
      setIsLoading(true);
      const [resCal, resVix] = await Promise.all([
        fetch('http://localhost:3001/api/macro-events/calendar'),
        fetch('http://localhost:3001/api/macro-events/vix-regime'),
      ]);

      const dCal = await resCal.json();
      const dVix = await resVix.json();

      setCalendarData(dCal);
      setVixData(dVix);
    } catch (e) {
      console.error('Failed to load macro events:', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchMacroData();
  }, []);

  return (
    <div className="space-y-5 font-mono">
      {/* Header Strip & India VIX Volatility Guard Banner */}
      <div className="bg-[#111827]/95 backdrop-blur-md border border-cyan-500/30 rounded-xl p-5 shadow-2xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
              <Calendar className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-xs font-black uppercase tracking-wider text-white flex items-center gap-2">
                HIGH-IMPACT ECONOMIC CALENDAR & VOLATILITY GUARD
                <span className="bg-cyan-500/20 text-cyan-300 text-[9px] px-2 py-0.5 rounded border border-cyan-500/30">
                  MACRO SHIELD
                </span>
              </h3>
              <p className="text-[11px] text-slate-400">RBI Policy, US Fed FOMC, Inflation & Nifty Heavyweight Earnings Catalysts</p>
            </div>
          </div>

          {vixData && (
            <div className="flex items-center gap-3 bg-slate-900 border border-slate-800 px-3.5 py-1.5 rounded-xl text-xs">
              <div>
                <span className="text-[10px] text-slate-400 block font-bold">INDIA VIX REGIME:</span>
                <span className="text-sm font-black text-emerald-400">{vixData.currentVIX} pts ({vixData.changePercent}%)</span>
              </div>
              <div className="h-6 w-px bg-slate-800" />
              <div>
                <span className="text-[9px] text-slate-500 block uppercase">SL BUFFER</span>
                <span className="text-xs font-bold text-cyan-300">{vixData.stopLossBufferMultiplier}x ATR</span>
              </div>
            </div>
          )}
        </div>

        {/* Volatility Regime Advisory Card */}
        {vixData && (
          <div className="p-3.5 rounded-xl bg-slate-900/90 border border-slate-800 flex items-start gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 shrink-0">
              <CheckCircle2 className="w-5 h-5" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-black text-white uppercase">
                  REGIME: {vixData.regime?.replace(/_/g, ' ')}
                </span>
                <span className="bg-emerald-950 text-emerald-300 text-[9px] px-2 py-0.5 rounded border border-emerald-700 font-bold">
                  OPTIMAL SMC CONDITIONS
                </span>
              </div>
              <p className="text-xs text-slate-300 font-sans leading-relaxed">
                {vixData.recommendedStrategy}
              </p>
            </div>
          </div>
        )}

        {/* Macro Events Timeline Ledger */}
        <div className="space-y-3 pt-2">
          <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center justify-between">
            <span>UPCOMING HIGH-IMPACT MARKET CATALYSTS ({calendarData?.events?.length || 0})</span>
            <span className="text-[10px] text-amber-400 flex items-center gap-1 font-bold">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
              {calendarData?.highImpactCount || 0} High-Impact Risk Events
            </span>
          </h4>

          <div className="space-y-3">
            {calendarData?.events?.map((ev: any) => {
              const eventDate = new Date(ev.scheduledTime);
              const isHigh = ev.impact === 'HIGH';

              return (
                <div
                  key={ev.id}
                  className={`p-4 rounded-xl border transition-all ${
                    isHigh
                      ? 'bg-slate-900/90 border-slate-800 hover:border-amber-500/50'
                      : 'bg-slate-900/60 border-slate-800'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-800/80 pb-2.5">
                    <div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[9px] font-black px-2 py-0.5 rounded border ${
                            isHigh
                              ? 'bg-rose-950 text-rose-300 border-rose-700'
                              : 'bg-amber-950 text-amber-300 border-amber-700'
                          }`}
                        >
                          {ev.impact} IMPACT
                        </span>
                        <span className="text-xs font-black text-white">{ev.title}</span>
                      </div>
                      <span className="text-[10px] text-slate-400 mt-1 block">
                        Category: <strong className="text-slate-200">{ev.category}</strong> • Country: <strong className="text-slate-200">{ev.country}</strong>
                      </span>
                    </div>

                    <div className="text-right text-xs">
                      <span className="text-cyan-300 font-bold block">
                        {eventDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </span>
                      <span className="text-[10px] text-slate-500 block">
                        {eventDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} IST
                      </span>
                    </div>
                  </div>

                  <div className="py-2.5 grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                    <div>
                      <span className="text-[10px] text-slate-500 block">FORECAST / CONSENSUS:</span>
                      <strong className="text-white text-xs">{ev.forecast || 'N/A'}</strong>
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-500 block">PREVIOUS FIGURE:</span>
                      <strong className="text-slate-300 text-xs">{ev.previous || 'N/A'}</strong>
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-500 block">AFFECTED ASSETS:</span>
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {ev.affectedInstruments?.map((sym: string) => (
                          <span
                            key={sym}
                            className="bg-cyan-500/10 text-cyan-300 text-[9px] px-1.5 py-0.5 rounded border border-cyan-500/20 font-bold"
                          >
                            {sym}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 text-[11px] text-slate-300 font-sans flex items-start gap-2">
                    <Info className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
                    <span><strong className="text-cyan-400 font-mono">Institutional Advisory:</strong> {ev.advisoryNote}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
