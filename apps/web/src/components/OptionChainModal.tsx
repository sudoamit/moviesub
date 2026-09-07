'use client';

import React, { useState, useEffect } from 'react';
import { X, Layers, RefreshCw, BarChart2, ShieldCheck, Flame, Target, Zap } from 'lucide-react';

interface OptionChainModalProps {
  symbol: string;
  isOpen: boolean;
  onClose: () => void;
  spotPrice?: number;
}

export const OptionChainModal: React.FC<OptionChainModalProps> = ({
  symbol,
  isOpen,
  onClose,
  spotPrice,
}) => {
  const [data, setData] = useState<any | null>(null);
  const [selectedExpiry, setSelectedExpiry] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);

  const fetchOptionChain = async (exp?: string, silent = false) => {
    try {
      if (!silent && !data) setLoading(true);
      const url = `http://localhost:3001/api/options/chain?symbol=${symbol}${exp ? `&expiryDate=${exp}` : ''}${spotPrice && spotPrice > 0 ? `&spotPrice=${spotPrice}` : ''}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json) {
        setData(json);
        if (!selectedExpiry && json.selectedExpiry) {
          setSelectedExpiry(json.selectedExpiry);
        }
      }
    } catch {
      // ignore network errors
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchOptionChain(selectedExpiry, false);
      const interval = setInterval(() => {
        fetchOptionChain(selectedExpiry, true);
      }, 1500);
      return () => clearInterval(interval);
    }
  }, [isOpen, symbol, selectedExpiry, spotPrice]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6 font-mono animate-in fade-in">
      <div className="bg-[#0f172a] border border-cyan-500/50 rounded-2xl w-full max-w-5xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="p-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-slate-900/90">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-cyan-500/10 border border-cyan-500/30 rounded-xl text-cyan-400">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-black text-white">{symbol} OPTION CHAIN MATRIX</h3>
                {data && (
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-950 text-emerald-300 border border-emerald-700 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                    SPOT: ₹{Number(data.spotPrice).toFixed(2)}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Live Black-Scholes Greeks, Open Interest Build-Up & Tuesday Weekly Expiries
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {data?.availableExpiries && (
              <select
                value={selectedExpiry || data.selectedExpiry}
                onChange={(e) => setSelectedExpiry(e.target.value)}
                className="bg-slate-800 border border-slate-700 text-cyan-300 text-xs px-2.5 py-1.5 rounded-lg font-bold outline-none cursor-pointer"
              >
                {data.availableExpiries.map((exp: any) => (
                  <option
                    key={exp.dateString}
                    value={exp.dateString}
                    className="bg-slate-900 text-white"
                  >
                    {exp.formattedLabel}
                  </option>
                ))}
              </select>
            )}

            <button
              onClick={() => fetchOptionChain(selectedExpiry)}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-all text-xs flex items-center gap-1"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-900/50 text-slate-400 hover:text-rose-300 transition-all"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Analytics Header Summary Strip (GEX, Max Pain, PCR & Hedging Levels) */}
        {data && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 p-3 bg-slate-950/80 border-b border-slate-800 text-xs">
            <div className="bg-slate-900/90 p-2 rounded-lg border border-slate-800">
              <span className="text-[10px] text-slate-400 block uppercase">UNDERLYING SPOT</span>
              <span className="text-sm font-black text-white mt-0.5 block">
                ₹{Number(data.spotPrice).toFixed(2)}
              </span>
              <span className="text-[9px] text-slate-500 block">ATM: ₹{data.atmStrike}</span>
            </div>

            <div className="bg-slate-900/90 p-2 rounded-lg border border-slate-800">
              <span className="text-[10px] text-amber-400 block uppercase font-bold flex items-center gap-1">
                <Target className="w-3 h-3 text-amber-400" /> MAX PAIN STRIKE
              </span>
              <span className="text-sm font-black text-amber-300 mt-0.5 block">
                ₹{data.maxPain}
              </span>
              <span className="text-[9px] text-amber-500/90 block">MM Minimum Payout Level</span>
            </div>

            <div className="bg-slate-900/90 p-2 rounded-lg border border-slate-800">
              <span className="text-[10px] text-purple-400 block uppercase font-bold flex items-center gap-1">
                <Zap className="w-3 h-3 text-purple-400" /> GAMMA FLIP LEVEL
              </span>
              <span className="text-sm font-black text-purple-300 mt-0.5 block">
                ₹{data.gammaFlipLevel || data.atmStrike}
              </span>
              <span className="text-[9px] text-purple-400/90 block">Zero-Gamma Threshold</span>
            </div>

            <div className="bg-slate-900/90 p-2 rounded-lg border border-slate-800">
              <span className="text-[10px] text-cyan-400 block uppercase font-bold">
                NET GAMMA (GEX)
              </span>
              <span
                className={`text-sm font-black mt-0.5 block ${(data.netGammaExposure || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}
              >
                {(data.netGammaExposure || 0) >= 0 ? '+' : ''}₹{data.netGammaExposure || 0} Cr
              </span>
              <span className="text-[9px] text-slate-500 block">
                {(data.netGammaExposure || 0) >= 0
                  ? 'Dampening (Long γ)'
                  : 'Accelerating (Short γ)'}
              </span>
            </div>

            <div className="bg-slate-900/90 p-2 rounded-lg border border-slate-800">
              <span className="text-[10px] text-slate-400 block uppercase">
                PUT-CALL RATIO (PCR)
              </span>
              <span
                className={`text-sm font-black mt-0.5 block ${
                  data.pcr > 1 ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {data.pcr} ({data.pcr > 1.2 ? 'BULLISH' : data.pcr < 0.8 ? 'BEARISH' : 'NEUTRAL'})
              </span>
              <span className="text-[9px] text-slate-500 block">Sentiment Bias</span>
            </div>

            <div className="bg-slate-900/90 p-2 rounded-lg border border-slate-800">
              <span className="text-[10px] text-slate-400 block uppercase">
                TOTAL OPEN INTEREST
              </span>
              <div className="flex items-center justify-between text-[11px] mt-0.5">
                <span className="text-emerald-400 font-bold font-mono">
                  C: {(data.totalCallOI / 100000).toFixed(1)}L
                </span>
                <span className="text-rose-400 font-bold font-mono">
                  P: {(data.totalPutOI / 100000).toFixed(1)}L
                </span>
              </div>
              <span className="text-[9px] text-slate-500 block">Weekly Expiry Open Contracts</span>
            </div>
          </div>
        )}

        {/* Main Option Chain Table with Visual OI & Volume Distribution Bars */}
        <div className="flex-1 overflow-auto p-3">
          {loading ? (
            <div className="py-20 text-center text-slate-500 text-sm animate-pulse">
              Streaming real-time Option Chain strikes and OI analytics...
            </div>
          ) : data ? (
            <table className="w-full text-xs border-collapse min-w-[920px]">
              <thead>
                <tr className="bg-slate-900 text-slate-400 uppercase text-[10px] tracking-wider border-b border-slate-800 sticky top-0 z-10">
                  {/* CALLS HEADER */}
                  <th
                    className="py-2 px-2 text-center bg-emerald-950/40 text-emerald-300 font-bold border-r border-slate-800"
                    colSpan={5}
                  >
                    CALL OPTIONS (CE) — RESISTANCE
                  </th>

                  {/* STRIKE & GEX HEADER */}
                  <th
                    className="py-2 px-3 text-center bg-slate-950 font-black text-white border-r border-slate-800"
                    colSpan={1}
                  >
                    STRIKE & GEX
                  </th>

                  {/* PUTS HEADER */}
                  <th
                    className="py-2 px-2 text-center bg-rose-950/40 text-rose-300 font-bold"
                    colSpan={5}
                  >
                    PUT OPTIONS (PE) — SUPPORT
                  </th>
                </tr>
                <tr className="bg-slate-950 text-slate-400 text-[9px] border-b border-slate-800 sticky top-7 z-10">
                  <th className="py-1.5 px-2 text-left">OI Visual</th>
                  <th className="py-1.5 px-2 text-left">OI (Qty)</th>
                  <th className="py-1.5 px-2 text-left">IV %</th>
                  <th className="py-1.5 px-2 text-right">Delta</th>
                  <th className="py-1.5 px-2 text-right text-emerald-400 border-r border-slate-800">
                    Call LTP (₹)
                  </th>

                  <th className="py-1.5 px-3 text-center text-white bg-slate-900">STRIKE</th>

                  <th className="py-1.5 px-2 text-left text-rose-400 border-l border-slate-800">
                    Put LTP (₹)
                  </th>
                  <th className="py-1.5 px-2 text-left">Delta</th>
                  <th className="py-1.5 px-2 text-right">IV %</th>
                  <th className="py-1.5 px-2 text-right">OI (Qty)</th>
                  <th className="py-1.5 px-2 text-right">OI Visual</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {data.strikes.map((s: any) => {
                  const isATM = s.isATM;
                  const isMaxPain = s.strikePrice === data.maxPain;
                  const isGammaFlip = s.strikePrice === (data.gammaFlipLevel || data.atmStrike);
                  const isCallITM = data.spotPrice > s.strikePrice;
                  const isPutITM = data.spotPrice < s.strikePrice;

                  // Visual OI Bar Percent relative to max
                  const maxOI =
                    Math.max(...data.strikes.map((x: any) => Math.max(x.call.oi, x.put.oi))) ||
                    100000;
                  const callBarPct = Math.min(100, Math.max(5, (s.call.oi / maxOI) * 100));
                  const putBarPct = Math.min(100, Math.max(5, (s.put.oi / maxOI) * 100));

                  return (
                    <tr
                      key={s.strikePrice}
                      className={`hover:bg-slate-800/40 transition-colors ${
                        isATM
                          ? 'bg-cyan-950/40 ring-1 ring-cyan-500/50'
                          : isMaxPain
                            ? 'bg-amber-950/20'
                            : isGammaFlip
                              ? 'bg-purple-950/20'
                              : ''
                      }`}
                    >
                      {/* CALL OI VISUAL BAR */}
                      <td
                        className={`py-2 px-2 text-[10px] w-24 ${isCallITM ? 'bg-emerald-950/20' : ''}`}
                      >
                        <div className="w-full bg-slate-900 rounded h-2 overflow-hidden flex items-center justify-end">
                          <div
                            className="bg-gradient-to-l from-emerald-400 to-teal-600 h-2 rounded"
                            style={{ width: `${callBarPct}%` }}
                            title={`Call OI: ${s.call.oi.toLocaleString()}`}
                          />
                        </div>
                      </td>

                      {/* CALL OI & OI CHANGE */}
                      <td
                        className={`py-2 px-2 text-[10px] ${isCallITM ? 'bg-emerald-950/20' : ''}`}
                      >
                        <span className="text-slate-200 font-bold">
                          {(s.call.oi / 1000).toFixed(1)}k
                        </span>
                        {s.call.oiChange !== 0 && (
                          <span
                            className={`block text-[8px] ${s.call.oiChange > 0 ? 'text-emerald-400' : 'text-rose-400'}`}
                          >
                            {s.call.oiChange > 0 ? '+' : ''}
                            {(s.call.oiChange / 1000).toFixed(1)}k
                          </span>
                        )}
                      </td>

                      {/* CALL IV */}
                      <td
                        className={`py-2 px-2 text-[10px] text-slate-400 ${isCallITM ? 'bg-emerald-950/20' : ''}`}
                      >
                        {s.call.iv}%
                      </td>

                      {/* CALL Delta */}
                      <td
                        className={`py-2 px-2 text-[10px] text-right text-slate-300 ${isCallITM ? 'bg-emerald-950/20' : ''}`}
                      >
                        {s.call.delta.toFixed(2)}
                      </td>

                      {/* CALL LTP */}
                      <td
                        className={`py-2 px-2 text-right font-bold text-emerald-400 border-r border-slate-800 ${isCallITM ? 'bg-emerald-950/30' : ''}`}
                      >
                        ₹{s.call.ltp.toFixed(2)}
                      </td>

                      {/* STRIKE PRICE & KEY HEDGING LEVELS (Center) */}
                      <td
                        className={`py-2 px-3 text-center ${
                          isATM
                            ? 'bg-cyan-500 text-slate-950 font-black'
                            : isMaxPain
                              ? 'bg-amber-950 text-amber-300 font-black border-y border-amber-500/50'
                              : isGammaFlip
                                ? 'bg-purple-950 text-purple-300 font-black border-y border-purple-500/50'
                                : 'bg-slate-900/90 text-white font-bold'
                        }`}
                      >
                        <div className="flex flex-col items-center">
                          <span className="text-xs">{s.strikePrice}</span>
                          {isATM && (
                            <span className="text-[8px] bg-slate-950 text-cyan-300 px-1 rounded uppercase font-black">
                              ATM
                            </span>
                          )}
                          {isMaxPain && !isATM && (
                            <span className="text-[8px] bg-amber-500 text-slate-950 px-1 rounded uppercase font-black">
                              MAX PAIN
                            </span>
                          )}
                          {isGammaFlip && !isATM && (
                            <span className="text-[8px] bg-purple-500 text-white px-1 rounded uppercase font-black">
                              γ FLIP
                            </span>
                          )}
                        </div>
                      </td>

                      {/* PUT LTP */}
                      <td
                        className={`py-2 px-2 text-left font-bold text-rose-400 border-l border-slate-800 ${isPutITM ? 'bg-rose-950/30' : ''}`}
                      >
                        ₹{s.put.ltp.toFixed(2)}
                      </td>

                      {/* PUT Delta */}
                      <td
                        className={`py-2 px-2 text-[10px] text-slate-300 ${isPutITM ? 'bg-rose-950/20' : ''}`}
                      >
                        {s.put.delta.toFixed(2)}
                      </td>

                      {/* PUT IV */}
                      <td
                        className={`py-2 px-2 text-[10px] text-right text-slate-400 ${isPutITM ? 'bg-rose-950/20' : ''}`}
                      >
                        {s.put.iv}%
                      </td>

                      {/* PUT OI & OI CHANGE */}
                      <td
                        className={`py-2 px-2 text-[10px] text-right ${isPutITM ? 'bg-rose-950/20' : ''}`}
                      >
                        <span className="text-slate-200 font-bold">
                          {(s.put.oi / 1000).toFixed(1)}k
                        </span>
                        {s.put.oiChange !== 0 && (
                          <span
                            className={`block text-[8px] ${s.put.oiChange > 0 ? 'text-emerald-400' : 'text-rose-400'}`}
                          >
                            {s.put.oiChange > 0 ? '+' : ''}
                            {(s.put.oiChange / 1000).toFixed(1)}k
                          </span>
                        )}
                      </td>

                      {/* PUT OI VISUAL BAR */}
                      <td
                        className={`py-2 px-2 text-[10px] w-24 ${isPutITM ? 'bg-rose-950/20' : ''}`}
                      >
                        <div className="w-full bg-slate-900 rounded h-2 overflow-hidden flex items-center justify-start">
                          <div
                            className="bg-gradient-to-r from-rose-400 to-amber-600 h-2 rounded"
                            style={{ width: `${putBarPct}%` }}
                            title={`Put OI: ${s.put.oi.toLocaleString()}`}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}
        </div>
      </div>
    </div>
  );
};
