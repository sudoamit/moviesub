'use client';

import React from 'react';
import { IScoreBreakdown, SignalGrade } from '@quant/shared';
import { ShieldCheck, Zap, Sparkles, CheckCircle2, TrendingUp, Compass, Target } from 'lucide-react';

interface ScoreGaugeProps {
  score: number;
  grade: SignalGrade;
  breakdown?: IScoreBreakdown;
}

export const ScoreGauge: React.FC<ScoreGaugeProps> = ({
  score,
  grade,
  breakdown,
}) => {
  const getGradeColor = (g: SignalGrade) => {
    switch (g) {
      case SignalGrade.A_PLUS:
        return 'text-emerald-400 border-emerald-500/50 bg-emerald-500/10 shadow-lg shadow-emerald-500/10';
      case SignalGrade.A:
        return 'text-cyan-400 border-cyan-500/50 bg-cyan-500/10 shadow-lg shadow-cyan-500/10';
      case SignalGrade.B:
        return 'text-amber-400 border-amber-500/50 bg-amber-500/10';
      case SignalGrade.C:
        return 'text-orange-400 border-orange-500/50 bg-orange-500/10';
      case SignalGrade.NO_TRADE:
      default:
        return 'text-rose-400 border-rose-500/50 bg-rose-500/10';
    }
  };

  // SVG Circular Gauge calculation
  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (score / 100) * circumference;

  return (
    <div className="bg-[#0B0F19] border border-slate-800 rounded-xl p-5 shadow-2xl space-y-4 font-mono relative overflow-hidden">
      {/* Glow highlight */}
      <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/5 rounded-full blur-2xl pointer-events-none" />

      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-cyan-400" />
          <h3 className="text-xs font-black uppercase tracking-wider text-slate-200">
            SMC CONFLUENCE RADAR
          </h3>
        </div>
        <span
          className={`text-xs font-black px-3 py-1 rounded-lg border uppercase tracking-wider ${getGradeColor(
            grade,
          )}`}
        >
          GRADE {grade}
        </span>
      </div>

      <div className="flex flex-col sm:flex-row items-center gap-5">
        {/* Radial Speedometer Gauge */}
        <div className="relative flex items-center justify-center shrink-0">
          <svg className="w-32 h-32 transform -rotate-90">
            <circle
              cx="64"
              cy="64"
              r={radius}
              stroke="currentColor"
              strokeWidth="8"
              className="text-slate-900"
              fill="transparent"
            />
            <circle
              cx="64"
              cy="64"
              r={radius}
              stroke="url(#gauge-gradient)"
              strokeWidth="8"
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="round"
              fill="transparent"
              className="transition-all duration-1000 ease-out"
            />
            <defs>
              <linearGradient
                id="gauge-gradient"
                x1="0%"
                y1="0%"
                x2="100%"
                y2="100%"
              >
                <stop offset="0%" stopColor="#06B6D4" />
                <stop offset="50%" stopColor="#10B981" />
                <stop offset="100%" stopColor="#3B82F6" />
              </linearGradient>
            </defs>
          </svg>
          <div className="absolute flex flex-col items-center justify-center text-center">
            <span className="text-3xl font-black text-white tracking-tight">{score}</span>
            <span className="text-[10px] text-cyan-400 font-bold uppercase tracking-wider">/ 100 PTS</span>
          </div>
        </div>

        {/* Breakdown progress metrics */}
        <div className="flex-1 w-full space-y-1.5 text-xs">
          {breakdown ? (
            <>
              <div>
                <div className="flex justify-between text-[10px] mb-0.5 font-bold">
                  <span className="text-slate-400">HTF Trend Bias Alignment</span>
                  <span className="text-cyan-400 font-bold">{breakdown.htfBias || 0}/20</span>
                </div>
                <div className="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden border border-slate-800">
                  <div
                    className="bg-cyan-500 h-full rounded-full transition-all duration-700 shadow-sm shadow-cyan-500/50"
                    style={{ width: `${((breakdown.htfBias || 0) / 20) * 100}%` }}
                  />
                </div>
              </div>

              <div>
                <div className="flex justify-between text-[10px] mb-0.5 font-bold">
                  <span className="text-slate-400">Liquidity Sweep Quality</span>
                  <span className="text-emerald-400 font-bold">{breakdown.liquiditySweep || 0}/15</span>
                </div>
                <div className="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden border border-slate-800">
                  <div
                    className="bg-emerald-500 h-full rounded-full transition-all duration-700 shadow-sm shadow-emerald-500/50"
                    style={{ width: `${((breakdown.liquiditySweep || 0) / 15) * 100}%` }}
                  />
                </div>
              </div>

              <div>
                <div className="flex justify-between text-[10px] mb-0.5 font-bold">
                  <span className="text-slate-400">BOS / CHoCH Breakout</span>
                  <span className="text-purple-400 font-bold">{breakdown.bos || 0}/15</span>
                </div>
                <div className="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden border border-slate-800">
                  <div
                    className="bg-purple-500 h-full rounded-full transition-all duration-700 shadow-sm shadow-purple-500/50"
                    style={{ width: `${((breakdown.bos || 0) / 15) * 100}%` }}
                  />
                </div>
              </div>

              <div>
                <div className="flex justify-between text-[10px] mb-0.5 font-bold">
                  <span className="text-slate-400">Order Block / FVG Zone</span>
                  <span className="text-amber-400 font-bold">{(breakdown.orderBlock || 0) + (breakdown.fvg || 0)}/15</span>
                </div>
                <div className="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden border border-slate-800">
                  <div
                    className="bg-amber-500 h-full rounded-full transition-all duration-700 shadow-sm shadow-amber-500/50"
                    style={{ width: `${(Math.min(15, (breakdown.orderBlock || 0) + (breakdown.fvg || 0)) / 15) * 100}%` }}
                  />
                </div>
              </div>

              <div>
                <div className="flex justify-between text-[10px] mb-0.5 font-bold">
                  <span className="text-slate-400">Displacement & Momentum</span>
                  <span className="text-indigo-400 font-bold">{breakdown.displacement || 0}/10</span>
                </div>
                <div className="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden border border-slate-800">
                  <div
                    className="bg-indigo-500 h-full rounded-full transition-all duration-700 shadow-sm shadow-indigo-500/50"
                    style={{ width: `${((breakdown.displacement || 0) / 10) * 100}%` }}
                  />
                </div>
              </div>

              <div>
                <div className="flex justify-between text-[10px] mb-0.5 font-bold">
                  <span className="text-slate-400">50% Premium / Discount Zone</span>
                  <span className="text-teal-400 font-bold">{breakdown.premiumDiscount || 0}/10</span>
                </div>
                <div className="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden border border-slate-800">
                  <div
                    className="bg-teal-500 h-full rounded-full transition-all duration-700 shadow-sm shadow-teal-500/50"
                    style={{ width: `${((breakdown.premiumDiscount || 0) / 10) * 100}%` }}
                  />
                </div>
              </div>

              <div>
                <div className="flex justify-between text-[10px] mb-0.5 font-bold">
                  <span className="text-slate-400">Volume & R:R Confirmation</span>
                  <span className="text-sky-400 font-bold">{(breakdown.volumeConfirmation || 0) + (breakdown.riskReward || 0) + (breakdown.indicatorAlignment || 0)}/15</span>
                </div>
                <div className="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden border border-slate-800">
                  <div
                    className="bg-sky-500 h-full rounded-full transition-all duration-700 shadow-sm shadow-sky-500/50"
                    style={{ width: `${(Math.min(15, (breakdown.volumeConfirmation || 0) + (breakdown.riskReward || 0) + (breakdown.indicatorAlignment || 0)) / 15) * 100}%` }}
                  />
                </div>
              </div>
            </>
          ) : (
            <div className="py-4 text-center text-slate-500 text-xs">
              Calculating real-time institutional confluence factors...
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
