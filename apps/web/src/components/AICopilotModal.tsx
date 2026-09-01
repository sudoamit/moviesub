'use client';

import React, { useState, useEffect } from 'react';
import {
  Brain,
  X,
  Sparkles,
  Zap,
  CheckCircle2,
  TrendingUp,
  TrendingDown,
  ShieldAlert,
  Layers,
  ArrowRight,
  RefreshCw,
  Award,
  FileText,
} from 'lucide-react';

interface AICopilotModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedSymbol: string;
}

export const AICopilotModal: React.FC<AICopilotModalProps> = ({
  isOpen,
  onClose,
  selectedSymbol,
}) => {
  const [activeTab, setActiveTab] = useState<'symbol_ai' | 'daily_briefing'>('symbol_ai');
  const [symbolData, setSymbolData] = useState<any>(null);
  const [briefingData, setBriefingData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const fetchAIAnalysis = async () => {
    try {
      setIsLoading(true);
      const [resSymbol, resBriefing] = await Promise.all([
        fetch(`http://localhost:3001/api/ai/market-summary/${selectedSymbol}`),
        fetch('http://localhost:3001/api/ai/daily-briefing'),
      ]);

      const dataSym = await resSymbol.json();
      const dataBrief = await resBriefing.json();

      setSymbolData(dataSym);
      setBriefingData(dataBrief);
    } catch (e) {
      console.error('Failed to load AI summary:', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchAIAnalysis();
    }
  }, [isOpen, selectedSymbol]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
      <div className="bg-[#111827] border border-cyan-500/40 rounded-2xl w-full max-w-3xl shadow-2xl overflow-hidden font-mono text-slate-200 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-800 bg-[#0B0F19]">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
              <Brain className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-black uppercase text-white flex items-center gap-2">
                DEEP SMC QUANTITATIVE COPILOT
                <span className="bg-cyan-500/20 text-cyan-300 text-[10px] px-2 py-0.5 rounded border border-cyan-500/30">
                  DETERMINISTIC AI
                </span>
              </h3>
              <p className="text-[11px] text-slate-400">Mathematical Smart Money Concept Reasoning & Institutional Briefing</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={fetchAIAnalysis}
              className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-cyan-300 transition-colors"
              title="Refresh AI Analysis"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-800 bg-slate-900/60 px-4 text-xs font-bold">
          <button
            onClick={() => setActiveTab('symbol_ai')}
            className={`py-3 px-4 border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'symbol_ai'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Zap className="w-4 h-4" />
            {selectedSymbol} Institutional Deep Dive
          </button>

          <button
            onClick={() => setActiveTab('daily_briefing')}
            className={`py-3 px-4 border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'daily_briefing'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileText className="w-4 h-4" />
            Daily Pre-Market Executive Briefing
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 space-y-5 overflow-y-auto flex-1">
          {isLoading ? (
            <div className="py-12 text-center text-xs text-slate-400 space-y-2">
              <RefreshCw className="w-6 h-6 text-cyan-400 animate-spin mx-auto" />
              <p>Analyzing order blocks, multi-timeframe liquidity sweeps, and market regime...</p>
            </div>
          ) : activeTab === 'symbol_ai' && symbolData ? (
            <div className="space-y-4">
              {/* Executive Summary Card */}
              <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-slate-400 uppercase font-bold">INSTITUTIONAL STRUCTURAL BIAS</span>
                  <span
                    className={`px-2.5 py-0.5 rounded text-xs font-black border ${
                      symbolData.bias === 'BULLISH'
                        ? 'bg-emerald-950 text-emerald-300 border-emerald-700'
                        : 'bg-rose-950 text-rose-300 border-rose-700'
                    }`}
                  >
                    {symbolData.bias} (Score: {symbolData.score}/100 • Grade {symbolData.grade})
                  </span>
                </div>
                <p className="text-xs text-slate-200 leading-relaxed font-sans">
                  {symbolData.executiveSummary}
                </p>
              </div>

              {/* Market Structure Narrative */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="bg-slate-900/80 border border-slate-800 p-3.5 rounded-xl space-y-1.5">
                  <span className="text-[10px] text-cyan-400 uppercase font-bold flex items-center gap-1">
                    <Layers className="w-3.5 h-3.5" />
                    MARKET STRUCTURE NARRATIVE
                  </span>
                  <p className="text-[11px] text-slate-300 leading-relaxed font-sans">
                    {symbolData.marketStructureNarrative}
                  </p>
                </div>

                <div className="bg-slate-900/80 border border-slate-800 p-3.5 rounded-xl space-y-1.5">
                  <span className="text-[10px] text-amber-400 uppercase font-bold flex items-center gap-1">
                    <Sparkles className="w-3.5 h-3.5" />
                    SMART MONEY FOOTPRINT
                  </span>
                  <p className="text-[11px] text-slate-300 leading-relaxed font-sans">
                    {symbolData.institutionalFootprint}
                  </p>
                </div>
              </div>

              {/* Risk Execution Plan */}
              {symbolData.riskParameters && (
                <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl space-y-2 text-xs">
                  <span className="text-[10px] text-slate-400 uppercase font-bold block">
                    RECOMMENDED EXECUTION PARAMETERS
                  </span>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div className="bg-slate-950 p-2 rounded border border-slate-800">
                      <span className="text-[9px] text-slate-500 block">OPTIMAL ENTRY</span>
                      <strong className="text-cyan-300">₹{symbolData.riskParameters.optimalEntry?.toFixed(2)}</strong>
                    </div>
                    <div className="bg-slate-950 p-2 rounded border border-slate-800">
                      <span className="text-[9px] text-slate-500 block">INVALIDATION SL</span>
                      <strong className="text-rose-400">₹{symbolData.riskParameters.invalidationStopLoss?.toFixed(2)}</strong>
                    </div>
                    <div className="bg-slate-950 p-2 rounded border border-slate-800">
                      <span className="text-[9px] text-slate-500 block">TARGET 2 (2.5R)</span>
                      <strong className="text-emerald-400">₹{symbolData.riskParameters.targets?.tp2?.toFixed(2)}</strong>
                    </div>
                    <div className="bg-slate-950 p-2 rounded border border-slate-800">
                      <span className="text-[9px] text-slate-500 block">RISK:REWARD</span>
                      <strong className="text-white">{symbolData.riskParameters.riskRewardRatio}</strong>
                    </div>
                  </div>
                </div>
              )}

              {/* Confirmed Checklist */}
              <div className="bg-slate-900/60 border border-slate-800 p-3.5 rounded-xl space-y-2">
                <span className="text-[10px] text-slate-400 uppercase font-bold block">
                  CONFIRMED INSTITUTIONAL CONFLUENCE CRITERIA ({symbolData.confirmedChecklist?.length || 0})
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {symbolData.confirmedChecklist?.map((item: string, idx: number) => (
                    <div key={idx} className="flex items-center gap-1.5 text-[11px] text-slate-300">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Daily Market Breadth */}
              {briefingData?.marketBreadth && (
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl text-center">
                    <span className="text-[10px] text-slate-400 block uppercase">ASSETS ANALYZED</span>
                    <strong className="text-xl text-white block mt-0.5">{briefingData.marketBreadth.totalAnalyzed}</strong>
                  </div>
                  <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl text-center">
                    <span className="text-[10px] text-slate-400 block uppercase">BULLISH ASSETS</span>
                    <strong className="text-xl text-emerald-400 block mt-0.5">{briefingData.marketBreadth.bullishAssets}</strong>
                  </div>
                  <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl text-center">
                    <span className="text-[10px] text-slate-400 block uppercase">BEARISH ASSETS</span>
                    <strong className="text-xl text-rose-400 block mt-0.5">{briefingData.marketBreadth.bearishAssets}</strong>
                  </div>
                </div>
              )}

              {/* Top High-Conviction Opportunities */}
              <div className="space-y-3">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                  TODAY'S HIGHEST CONFLUENCE SETUPS ({briefingData?.topOpportunities?.length || 0})
                </h4>

                {briefingData?.topOpportunities?.map((opp: any) => (
                  <div
                    key={opp.symbol}
                    className="p-3.5 rounded-xl bg-slate-900/90 border border-slate-800 space-y-2 text-xs"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 font-bold">
                        <span className="text-white text-sm">{opp.symbol}</span>
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] ${
                            opp.direction === 'BULLISH'
                              ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                              : 'bg-rose-950 text-rose-400 border border-rose-800'
                          }`}
                        >
                          {opp.direction}
                        </span>
                      </div>
                      <span className="text-cyan-300 font-bold">Score: {opp.score}/100 (Grade {opp.grade})</span>
                    </div>

                    <p className="text-[11px] text-slate-300 font-sans">{opp.summary}</p>

                    <div className="flex flex-wrap items-center gap-3 text-[10px] text-slate-400 pt-1 border-t border-slate-800">
                      <span>Entry: <strong className="text-white">₹{opp.optimalEntry?.toFixed(2)}</strong></span>
                      <span>SL: <strong className="text-rose-400">₹{opp.stopLoss?.toFixed(2)}</strong></span>
                      <span>TP2: <strong className="text-emerald-400">₹{opp.tp2?.toFixed(2)}</strong></span>
                      <span>R:R: <strong className="text-white">{opp.rr}</strong></span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
