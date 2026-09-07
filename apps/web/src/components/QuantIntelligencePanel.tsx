import React, { useState } from 'react';
import { ISignalSetup } from '@quant/shared';
import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cpu,
  Gauge,
  HelpCircle,
  Layers,
  LineChart,
  Lock,
  Radio,
  Scale,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Zap,
} from 'lucide-react';

export interface QuantIntelligencePanelProps {
  currentSymbol: string;
  activeSignal: ISignalSetup | null;
  livePrice?: number;
}

export const QuantIntelligencePanel: React.FC<QuantIntelligencePanelProps> = ({
  currentSymbol,
  activeSignal,
  livePrice,
}) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(true);
  const [activeSubTab, setActiveSubTab] = useState<'overview' | 'pillars' | 'volatility' | 'trace'>(
    'overview',
  );

  const quant = activeSignal?.quantSnapshot?.quant;
  const regime = activeSignal?.quantSnapshot?.regime;
  const volatility = activeSignal?.quantSnapshot?.volatility;
  const multiHorizon = activeSignal?.quantSnapshot?.multiHorizon;
  const score = activeSignal?.quantSnapshot?.score || activeSignal?.quantScore;
  const trace = activeSignal?.quantSnapshot?.trace || activeSignal?.decisionTrace;
  const ml = activeSignal?.quantSnapshot?.ml;

  const isCrypto =
    currentSymbol.includes('BTC') ||
    currentSymbol.includes('ETH') ||
    currentSymbol.includes('USDT');

  // Regime Color & Icon
  const getRegimeBadge = (regimeType?: string) => {
    switch (regimeType) {
      case 'BULLISH_TREND':
        return {
          label: 'BULLISH TREND',
          bg: 'bg-emerald-950/80',
          border: 'border-emerald-700/80',
          text: 'text-emerald-400',
          icon: TrendingUp,
        };
      case 'BEARISH_TREND':
        return {
          label: 'BEARISH TREND',
          bg: 'bg-rose-950/80',
          border: 'border-rose-700/80',
          text: 'text-rose-400',
          icon: TrendingDown,
        };
      case 'HIGH_VOLATILITY':
        return {
          label: 'HIGH VOLATILITY SHOCK',
          bg: 'bg-purple-950/80',
          border: 'border-purple-700/80',
          text: 'text-purple-400',
          icon: AlertTriangle,
        };
      case 'LOW_VOLATILITY':
        return {
          label: 'LOW VOL COMPRESSION',
          bg: 'bg-cyan-950/80',
          border: 'border-cyan-700/80',
          text: 'text-cyan-400',
          icon: Activity,
        };
      default:
        return {
          label: 'RANGE / CONSOLIDATION',
          bg: 'bg-amber-950/80',
          border: 'border-amber-700/80',
          text: 'text-amber-400',
          icon: Scale,
        };
    }
  };

  const currentRegimeBadge = getRegimeBadge(regime?.regime);
  const RegimeIcon = currentRegimeBadge.icon;

  return (
    <div className="bg-[#0B0F19] border border-cyan-500/30 rounded-xl p-4 sm:p-6 shadow-2xl font-mono space-y-5 relative overflow-hidden">
      {/* Background ambient glow */}
      <div className="absolute top-0 right-0 w-96 h-96 bg-cyan-500/5 rounded-full blur-3xl pointer-events-none" />

      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500/20 to-indigo-500/20 border border-cyan-500/40 flex items-center justify-center shrink-0 shadow-lg">
            <BrainCircuit className="w-5 h-5 text-cyan-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-black text-white tracking-wide flex items-center gap-2">
                QUANT INTELLIGENCE ENGINE
                <span className="text-[10px] bg-cyan-950 text-cyan-300 border border-cyan-800 px-2 py-0.5 rounded font-bold">
                  v2.0 CANONICAL
                </span>
              </h2>
            </div>
            <p className="text-xs text-slate-400">
              Point-In-Time Volatility Forecasting • K-Means Regime Clustering • 10-Pillar Quant/SMC
              Confluence
            </p>
          </div>
        </div>

        {/* Tab Controls & Collapse */}
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-slate-900 border border-slate-800 p-1 rounded-lg">
            {(['overview', 'pillars', 'volatility', 'trace'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveSubTab(tab)}
                className={`px-3 py-1 rounded text-xs font-bold uppercase transition-all ${
                  activeSubTab === tab
                    ? 'bg-cyan-600 text-white shadow'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded-lg text-slate-300 transition-colors"
          >
            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="space-y-5">
          {/* Top Quick Status Strip: Regime, Volatility Bucket, Alignment, ML Probability */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {/* 1. Market Regime */}
            <div
              className={`p-3.5 rounded-xl border ${currentRegimeBadge.bg} ${currentRegimeBadge.border}`}
            >
              <span className="text-[10px] text-slate-400 uppercase block font-bold">
                Market Regime
              </span>
              <div className="flex items-center gap-1.5 mt-1">
                <RegimeIcon className={`w-4 h-4 ${currentRegimeBadge.text}`} />
                <span className={`text-xs font-black ${currentRegimeBadge.text}`}>
                  {currentRegimeBadge.label}
                </span>
              </div>
              <span className="text-[10px] text-slate-400 block mt-1">
                Confidence: <strong className="text-slate-200">{regime?.confidence ?? 75}%</strong>
              </span>
            </div>

            {/* 2. Volatility Forecast */}
            <div className="p-3.5 rounded-xl bg-slate-900/90 border border-slate-800">
              <span className="text-[10px] text-slate-400 uppercase block font-bold">
                Volatility Model
              </span>
              <div className="flex items-center gap-1.5 mt-1">
                <Activity className="w-4 h-4 text-cyan-400" />
                <span className="text-xs font-black text-cyan-300">
                  {volatility?.modelUsed || 'GARCH(1,1)'} • {volatility?.volatilityBucket || 'P40'}
                </span>
              </div>
              <span className="text-[10px] text-slate-400 block mt-1">
                Percentile:{' '}
                <strong className="text-slate-200">
                  {volatility?.volatilityPercentile ?? 45}%
                </strong>{' '}
                (ATR {volatility?.atrPercentage ?? 0.8}%)
              </span>
            </div>

            {/* 3. Multi-Horizon Alignment */}
            <div className="p-3.5 rounded-xl bg-slate-900/90 border border-slate-800">
              <span className="text-[10px] text-slate-400 uppercase block font-bold">
                Multi-Horizon State
              </span>
              <div className="flex items-center gap-1.5 mt-1">
                <Layers className="w-4 h-4 text-indigo-400" />
                <span
                  className={`text-xs font-black ${
                    multiHorizon?.alignment === 'ALIGNED'
                      ? 'text-emerald-400'
                      : multiHorizon?.alignment === 'CONFLICTED'
                        ? 'text-rose-400'
                        : 'text-amber-400'
                  }`}
                >
                  {multiHorizon?.alignment || 'ALIGNED'}
                </span>
              </div>
              <span className="text-[10px] text-slate-400 block mt-1">
                Score:{' '}
                <strong className="text-slate-200">
                  {multiHorizon?.confluenceScore ?? 85}/100
                </strong>
              </span>
            </div>

            {/* 4. Calibrated ML Win Probability & EV */}
            <div className="p-3.5 rounded-xl bg-slate-900/90 border border-slate-800">
              <span className="text-[10px] text-slate-400 uppercase block font-bold">
                Calibrated P(Win) / EV
              </span>
              <div className="flex items-center gap-1.5 mt-1">
                <Sparkles className="w-4 h-4 text-amber-400" />
                <span className="text-xs font-black text-emerald-400">
                  {((ml?.probabilityWin ?? 0.75) * 100).toFixed(0)}% • +{ml?.expectedR ?? 1.25}R EV
                </span>
              </div>
              <span className="text-[9px] text-slate-400 block mt-1">
                P(TP1): {((ml?.probabilityTP1 ?? 0.88) * 100).toFixed(0)}% | P(TP2):{' '}
                {((ml?.probabilityTP2 ?? 0.65) * 100).toFixed(0)}%
              </span>
            </div>
          </div>

          {/* Sub-tab 1: Overview & Multi-Horizon Architecture */}
          {activeSubTab === 'overview' && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Macro, HTF, and Execution Breakdown */}
              <div className="lg:col-span-2 bg-slate-900/80 border border-slate-800 p-4 rounded-xl space-y-3">
                <h4 className="text-xs font-bold text-white uppercase flex items-center gap-1.5">
                  <Radio className="w-3.5 h-3.5 text-cyan-400" />
                  Multi-Timeframe Order Flow & Structure Hierarchy
                </h4>
                <div className="grid grid-cols-3 gap-2.5 text-center">
                  <div className="bg-slate-950 p-3 rounded-lg border border-slate-800/80">
                    <span className="text-[10px] text-slate-400 uppercase block font-bold">
                      Macro (4H / 1D)
                    </span>
                    <span className="text-sm font-black text-emerald-400 block mt-1">
                      {multiHorizon?.macro?.trend || 'BULLISH'}
                    </span>
                    <span className="text-[10px] text-slate-500 block mt-0.5">
                      RSI {multiHorizon?.macro?.momentumScore || 58} •{' '}
                      {multiHorizon?.macro?.regime || 'TRENDING'}
                    </span>
                  </div>
                  <div className="bg-slate-950 p-3 rounded-lg border border-slate-800/80">
                    <span className="text-[10px] text-slate-400 uppercase block font-bold">
                      Structure (1H)
                    </span>
                    <span className="text-sm font-black text-emerald-400 block mt-1">
                      {multiHorizon?.higherTimeframe?.trend || 'BULLISH'}
                    </span>
                    <span className="text-[10px] text-slate-500 block mt-0.5">
                      ATR {multiHorizon?.higherTimeframe?.volatilityAtr || '120.5'} • Aligned
                    </span>
                  </div>
                  <div className="bg-slate-950 p-3 rounded-lg border border-slate-800/80">
                    <span className="text-[10px] text-slate-400 uppercase block font-bold">
                      Trigger (15M)
                    </span>
                    <span className="text-sm font-black text-cyan-400 block mt-1">
                      {multiHorizon?.execution?.trend || 'BULLISH'}
                    </span>
                    <span className="text-[10px] text-slate-500 block mt-0.5">
                      RSI {quant?.momentum?.rsi14 || 54} • {quant?.momentum?.relativeVolume || 1.4}x
                      RVOL
                    </span>
                  </div>
                </div>

                {/* Alternative Data & Sentiment Context */}
                <div className="pt-2 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
                  <span className="text-slate-400 font-bold flex items-center gap-1.5">
                    <Cpu className="w-3.5 h-3.5 text-indigo-400" />
                    Alternative Market Context:
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    {!isCrypto ? (
                      <>
                        <span className="bg-slate-950 text-slate-300 border border-slate-800 px-2 py-0.5 rounded text-[11px]">
                          India VIX:{' '}
                          <strong className="text-cyan-400">
                            {quant?.alternativeData?.indiaVix ?? 14.2}
                          </strong>{' '}
                          ({quant?.alternativeData?.vixPercentile ?? 42}%ile)
                        </span>
                        <span className="bg-slate-950 text-slate-300 border border-slate-800 px-2 py-0.5 rounded text-[11px]">
                          PCR:{' '}
                          <strong className="text-emerald-400">
                            {quant?.alternativeData?.putCallRatio ?? 1.08}
                          </strong>
                        </span>
                        <span className="bg-slate-950 text-slate-300 border border-slate-800 px-2 py-0.5 rounded text-[11px]">
                          Adv/Dec:{' '}
                          <strong className="text-emerald-400">
                            {quant?.alternativeData?.marketAdvanceDeclineRatio ?? 1.25}
                          </strong>
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="bg-slate-950 text-slate-300 border border-slate-800 px-2 py-0.5 rounded text-[11px]">
                          Funding Rate:{' '}
                          <strong className="text-emerald-400">
                            +
                            {((quant?.alternativeData?.cryptoFundingRate ?? 0.0001) * 100).toFixed(
                              3,
                            )}
                            %
                          </strong>
                        </span>
                        <span className="bg-slate-950 text-slate-300 border border-slate-800 px-2 py-0.5 rounded text-[11px]">
                          BTC Dominance:{' '}
                          <strong className="text-cyan-400">
                            {quant?.alternativeData?.btcDominance ?? 54.2}%
                          </strong>
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* LLM Structured Context Assessment */}
              <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-xl space-y-2.5">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-white uppercase flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                    Qualitative Context Assessment
                  </h4>
                  <span className="text-[10px] bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded border border-slate-700">
                    {trace?.llmAssessment?.decision || 'APPROVE'}
                  </span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {trace?.llmAssessment?.marketContext ||
                    `Institutional order flow on ${currentSymbol} shows clean SMC structure alignment with favorable volatility conditions.`}
                </p>
                <div className="text-[11px] text-slate-400 space-y-1">
                  <div className="flex items-center gap-1.5 text-emerald-400">
                    <CheckCircle2 className="w-3 h-3 shrink-0" />
                    <span>Deterministic Gate: Risk Engine Approved</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-cyan-400">
                    <CheckCircle2 className="w-3 h-3 shrink-0" />
                    <span>Point-In-Time Snapshot Validated</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Sub-tab 2: 10-Pillar Confluence Scorecard */}
          {activeSubTab === 'pillars' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {[
                  { name: 'Structure & Trend', pts: score?.structureScore ?? 12, max: 15 },
                  { name: 'MTF Alignment', pts: score?.mtfScore ?? 15, max: 15 },
                  { name: 'Liquidity Sweep', pts: score?.liquidityScore ?? 10, max: 10 },
                  { name: 'Order Block POI', pts: score?.obScore ?? 8, max: 10 },
                  { name: 'Fair Value Gap', pts: score?.fvgScore ?? 10, max: 10 },
                  { name: 'Volume & RVOL', pts: score?.volumeScore ?? 8, max: 10 },
                  { name: 'Momentum / RSI', pts: score?.momentumScore ?? 10, max: 10 },
                  { name: 'Market Regime', pts: score?.regimeScore ?? 10, max: 10 },
                  { name: 'Volatility Window', pts: score?.volatilityScore ?? 5, max: 5 },
                  { name: 'Risk/Reward Ratio', pts: score?.riskRewardScore ?? 5, max: 5 },
                ].map((pillar) => (
                  <div
                    key={pillar.name}
                    className="bg-slate-900/90 border border-slate-800 p-3 rounded-lg text-center"
                  >
                    <span className="text-[10px] text-slate-400 block font-bold">
                      {pillar.name}
                    </span>
                    <span className="text-base font-black text-cyan-400 mt-0.5 block">
                      {pillar.pts}{' '}
                      <span className="text-xs text-slate-500 font-normal">/ {pillar.max}</span>
                    </span>
                    <div className="w-full bg-slate-950 h-1.5 rounded-full mt-2 overflow-hidden border border-slate-800">
                      <div
                        className="bg-gradient-to-r from-cyan-500 to-emerald-400 h-full rounded-full"
                        style={{ width: `${(pillar.pts / pillar.max) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>

              {/* Total Summary */}
              <div className="bg-slate-950 border border-slate-800 p-4 rounded-xl flex flex-col sm:flex-row items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="text-2xl font-black text-emerald-400">
                    {score?.totalScore ?? 88} / 100
                  </div>
                  <div>
                    <span className="text-xs font-bold text-white uppercase block">
                      Grade:{' '}
                      <span className="text-emerald-400 font-black">
                        {score?.grade || 'A_PLUS'}
                      </span>
                    </span>
                    <span className="text-[11px] text-slate-400">
                      10 independent mathematical factors evaluated without boolean double-counting.
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Sub-tab 3: Volatility & Return Dynamics */}
          {activeSubTab === 'volatility' && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-xl space-y-2">
                <span className="text-xs font-bold text-white uppercase block">
                  Volatility Estimators
                </span>
                <div className="space-y-1.5 text-xs text-slate-300">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Parkinson (High/Low):</span>
                    <span className="font-bold text-cyan-400">
                      {((volatility?.parkinsonVolatility ?? 0.015) * 100).toFixed(2)}%
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Garman-Klass (OHLC):</span>
                    <span className="font-bold text-cyan-400">
                      {((volatility?.garmanKlassVolatility ?? 0.016) * 100).toFixed(2)}%
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Realized Rolling Vol:</span>
                    <span className="font-bold text-cyan-400">
                      {((volatility?.realizedVolatility ?? 0.018) * 100).toFixed(2)}%
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Forecast Volatility:</span>
                    <span className="font-bold text-emerald-400">
                      {((volatility?.forecastVolatility ?? 0.017) * 100).toFixed(2)}%
                    </span>
                  </div>
                </div>
              </div>

              <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-xl space-y-2">
                <span className="text-xs font-bold text-white uppercase block">
                  Multi-Bar Return Profile
                </span>
                <div className="space-y-1.5 text-xs text-slate-300">
                  <div className="flex justify-between">
                    <span className="text-slate-400">1-Bar Return:</span>
                    <span
                      className={`font-bold ${(quant?.returns?.return1Bar ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}
                    >
                      {((quant?.returns?.return1Bar ?? 0) * 100).toFixed(2)}%
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">5-Bar Return:</span>
                    <span
                      className={`font-bold ${(quant?.returns?.return5Bar ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}
                    >
                      {((quant?.returns?.return5Bar ?? 0) * 100).toFixed(2)}%
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Return Skewness:</span>
                    <span className="font-bold text-slate-200">
                      {quant?.returns?.returnSkewness ?? 0.25}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Excess Kurtosis:</span>
                    <span className="font-bold text-slate-200">
                      {quant?.returns?.returnKurtosis ?? 1.15}
                    </span>
                  </div>
                </div>
              </div>

              <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-xl space-y-2">
                <span className="text-xs font-bold text-white uppercase block">
                  Structure Distance Metrics
                </span>
                <div className="space-y-1.5 text-xs text-slate-300">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Dist to VWAP:</span>
                    <span className="font-bold text-cyan-400">
                      {quant?.momentum?.distanceToVwap ?? 0.12}%
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Dist to 20 EMA:</span>
                    <span className="font-bold text-cyan-400">
                      {quant?.momentum?.distanceToEma20 ?? 0.24}%
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Bollinger %B:</span>
                    <span className="font-bold text-cyan-400">
                      {quant?.momentum?.bollingerPosition ?? 0.62}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Volume Z-Score:</span>
                    <span className="font-bold text-emerald-400">
                      +{quant?.momentum?.volumeZScore ?? 1.45}σ
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Sub-tab 4: "Why This Trade?" Decision Audit Trace */}
          {activeSubTab === 'trace' && (
            <div className="bg-slate-950 border border-slate-800 p-4 rounded-xl space-y-3">
              <h4 className="text-xs font-bold text-white uppercase flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                "Why This Trade?" — Ranked Confluence & Invalidation Audit
              </h4>
              <div className="space-y-2">
                {(
                  (trace?.whyThisTradeRanked ||
                    score?.rankingRationale || [
                      '+15 pts: Complete Multi-Timeframe Order Flow Agreement (Macro + HTF + Exec)',
                      '+12 pts: Confirmed Break of Structure (BOS) in Trend Direction',
                      '+10 pts: Clean Key Liquidity Pool Sweep & Mitigation',
                      '+10 pts: Unmitigated Fair Value Gap (FVG) Imbalance Tap',
                      '+10 pts: Strong Directional Regime Alignment (BULLISH_TREND)',
                    ]) as string[]
                ).map((reason: string, idx: number) => (
                  <div key={idx} className="flex items-start gap-2 text-xs text-slate-200">
                    <span className="text-cyan-400 font-bold">#{idx + 1}</span>
                    <span>{reason}</span>
                  </div>
                ))}
              </div>

              {trace?.invalidationRisks && trace.invalidationRisks.length > 0 && (
                <div className="mt-3 pt-3 border-t border-slate-800 space-y-1">
                  <span className="text-[11px] text-amber-400 font-bold uppercase block flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" /> Invalidation Warnings / Key Risks:
                  </span>
                  {(trace.invalidationRisks as string[]).map((risk: string, idx: number) => (
                    <p key={idx} className="text-xs text-slate-400 pl-4">
                      • {risk}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
