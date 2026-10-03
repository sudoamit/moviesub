'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { FlaskConical, RefreshCw, Activity, Archive, Eye } from 'lucide-react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const REFRESH_MS = 60_000;

interface LabTrade {
  id: string;
  mode: 'SHADOW' | 'LIVE';
  side: 'LONG' | 'SHORT';
  entryTime: string;
  entryPrice: number;
  initialStop: number;
  currentStop: number;
  barsHeld: number;
  status: 'OPEN' | 'CLOSED';
  exitTime: string | null;
  exitPrice: number | null;
  exitReason: string | null;
  netR: number | null;
  predictedR: number | null;
  sizeMultiplier: number | null;
}

interface QualityModelInfo {
  strategyId: string;
  status: 'ACTIVE' | 'INACTIVE';
  trainedAt: string;
  examples: number;
  labExamples: number;
  validation: { reason: string; liftR: number; liftTStat: number; topHalfR: number; bottomHalfR: number; oosPredictions: number; skipRuleValidated: boolean };
}

interface LabStrategy {
  id: string;
  name: string;
  symbol: string;
  timeframe: string;
  status: 'SHADOW' | 'LIVE' | 'RETIRED';
  statusReason: string | null;
  leverage: number;
  riskPercentage: number;
  lastProcessedBarTime: string | null;
  promotedAt: string | null;
  retiredAt: string | null;
  backtestJson: {
    expectancyR: number;
    trades: number;
    tradesPerYear: number;
    winRate: number;
    maxDrawdownR: number;
    from: string;
    to: string;
    confirmation?: string;
    caveat?: string;
  };
  trades: LabTrade[];
  summary: { closedTrades: number; totalR: number; openTrade: LabTrade | null };
  /** The instrument's own capital (shared by its strategies): starting amount, live balance, shadow balance. */
  capital: { start: number; liveBalance: number; shadowBalance: number } | null;
  lifecycle: {
    rules: { minShadowTrades: number; minShadowCiLowR: number; minTradesForRetirement: number };
    rulesVersion: string;
    strategyVersion: string | null;
    /** UNVALIDATED | BACKTEST_VALIDATED | SHADOW_RUNNING | SHADOW_NOT_DISPROVEN | SHADOW_CONFIRMED | LIVE | RETIRED */
    evidenceState: string | null;
    evidence: {
      reason: string;
      checks: Array<{ name: string; passed: boolean; value: number | string | null; required: string }>;
      evidence: { current: { ciLowR: number; ciHighR: number; trades: number } };
    } | null;
    closedInCurrentMode: number;
    totalRInCurrentMode: number;
    drawdownR: number;
  };
}

const STATUS_STYLE: Record<LabStrategy['status'], string> = {
  SHADOW: 'bg-amber-950/70 text-amber-300 border-amber-700/70',
  LIVE: 'bg-emerald-950/70 text-emerald-300 border-emerald-700/70',
  RETIRED: 'bg-slate-800 text-slate-400 border-slate-700',
};

const fmtR = (r: number | null | undefined) =>
  r === null || r === undefined || !Number.isFinite(r) ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;
const fmtPx = (p: number | null | undefined) =>
  p === null || p === undefined ? '—' : p.toLocaleString(undefined, { maximumFractionDigits: 1 });
const fmtTime = (t: string | null) =>
  t ? new Date(t).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

/**
 * Strategies discovered by the strategy lab and run by the API (SHADOW -> LIVE -> RETIRED, automatic).
 * Everything shown comes from GET /api/lab/strategies; nothing is estimated in the browser.
 */
export const LabStrategiesCard: React.FC = () => {
  const [strategies, setStrategies] = useState<LabStrategy[] | null>(null);
  const [quality, setQuality] = useState<Record<string, QualityModelInfo>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [res, qRes] = await Promise.all([fetch(`${API_BASE}/api/lab/strategies`), fetch(`${API_BASE}/api/lab/quality`)]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStrategies(await res.json());
      if (qRes.ok) {
        const models: QualityModelInfo[] = await qRes.json();
        setQuality(Object.fromEntries(models.map((m) => [m.strategyId, m])));
      }
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="bg-[#111827]/95 border border-slate-800 rounded-xl p-5 font-mono space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-white text-xs font-black uppercase tracking-wider">
          <FlaskConical className="w-4 h-4 text-cyan-400" />
          AI Lab Strategies
          <span className="text-[10px] text-slate-500 font-bold normal-case tracking-normal">
            discovered & validated by the strategy lab • shadow → live → retired (automatic)
          </span>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="text-slate-400 hover:text-white disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && <p className="text-xs text-rose-400">Lab strategies unavailable ({error}).</p>}
      {!error && strategies && strategies.length === 0 && (
        <p className="text-xs text-slate-400">No validated strategies registered. The lab only registers strategies that pass its tests.</p>
      )}
      {!error && !strategies && <p className="text-xs text-slate-500">Loading…</p>}

      {strategies?.map((s) => {
        const bt = s.backtestJson;
        const lc = s.lifecycle;
        const open = s.summary.openTrade;
        const closed = s.trades.filter((t) => t.status === 'CLOSED').slice(0, 8);
        const shadowProgress = Math.min(1, lc.closedInCurrentMode / lc.rules.minShadowTrades);
        return (
          <div key={s.id} className="border border-slate-800 rounded-lg p-4 space-y-3 bg-slate-950/40">
            {/* Header */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-white text-sm font-black">{s.name}</span>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${STATUS_STYLE[s.status]}`}>
                  {s.status === 'SHADOW' ? <Eye className="inline w-3 h-3 mr-1" /> : s.status === 'LIVE' ? <Activity className="inline w-3 h-3 mr-1" /> : <Archive className="inline w-3 h-3 mr-1" />}
                  {s.status}
                </span>
              </div>
              <span className="text-[10px] text-slate-500">
                {s.symbol} • {s.timeframe} • {s.riskPercentage}% risk • {s.leverage}x • last bar {fmtTime(s.lastProcessedBarTime)}
              </span>
            </div>
            {s.statusReason && <p className="text-[11px] text-slate-400">{s.statusReason}</p>}

            {/* Instrument capital (compounding) */}
            {s.capital && s.status !== 'RETIRED' && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] bg-slate-900/80 border border-slate-800 rounded p-2">
                <span className="text-slate-400 font-bold uppercase text-[10px]">{s.symbol.replace('USDT_PERP', '')} capital</span>
                <span className="text-slate-400">start <span className="text-slate-200">₹{s.capital.start.toLocaleString('en-IN')}</span></span>
                <span className="text-slate-400">
                  {s.status === 'LIVE' ? 'live balance' : 'live balance (not trading yet)'}{' '}
                  <span className={s.capital.liveBalance >= s.capital.start ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>₹{Math.round(s.capital.liveBalance).toLocaleString('en-IN')}</span>
                </span>
                <span className="text-slate-400">
                  shadow balance <span className={s.capital.shadowBalance >= s.capital.start ? 'text-emerald-300' : 'text-rose-300'}>₹{Math.round(s.capital.shadowBalance).toLocaleString('en-IN')}</span>
                </span>
                <span className="text-slate-400">
                  risk per trade {s.riskPercentage}% (₹{Math.round((s.capital.liveBalance * s.riskPercentage) / 100).toLocaleString('en-IN')} now)
                </span>
              </div>
            )}

            {/* Backtest reference vs current mode */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
              <div className="bg-slate-900/80 border border-slate-800 rounded p-2">
                <span className="text-slate-500 block text-[10px] uppercase font-bold">Backtest edge</span>
                <span className="text-cyan-300 font-black">{fmtR(bt.expectancyR)}</span>
                <span className="text-slate-500"> /trade • {bt.trades} trades</span>
              </div>
              <div className="bg-slate-900/80 border border-slate-800 rounded p-2">
                <span className="text-slate-500 block text-[10px] uppercase font-bold">Backtest frequency / worst DD</span>
                <span className="text-slate-200 font-bold">{bt.tradesPerYear.toFixed(0)}/yr</span>
                <span className="text-slate-500"> • DD {bt.maxDrawdownR.toFixed(1)}R</span>
              </div>
              <div className="bg-slate-900/80 border border-slate-800 rounded p-2">
                <span className="text-slate-500 block text-[10px] uppercase font-bold">{s.status === 'RETIRED' ? 'Result' : `${s.status.toLowerCase()} result`}</span>
                <span className={`font-black ${lc.totalRInCurrentMode >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{fmtR(lc.totalRInCurrentMode)}</span>
                <span className="text-slate-500">
                  {' '}over {lc.closedInCurrentMode} closed trade{lc.closedInCurrentMode === 1 ? '' : 's'}
                  {open ? ' • 1 open' : ''}
                </span>
              </div>
              <div className="bg-slate-900/80 border border-slate-800 rounded p-2">
                <span className="text-slate-500 block text-[10px] uppercase font-bold">Expectancy 95% CI ({s.status.toLowerCase()})</span>
                <span className="text-slate-200 font-bold">
                  {lc.evidence && lc.closedInCurrentMode > 1
                    ? `${fmtR(lc.evidence.evidence.current.ciLowR)} … ${fmtR(lc.evidence.evidence.current.ciHighR)}`
                    : '—'}
                </span>
                <span className="text-slate-500"> • promote only if the low end &gt; {lc.rules.minShadowCiLowR}R</span>
              </div>
            </div>

            {/* Trade-quality model */}
            {(() => {
              const q = quality[s.id];
              if (!q) return <p className="text-[11px] text-slate-500">Trade-quality model: not trained yet.</p>;
              return (
                <div className="text-[11px] bg-slate-900/80 border border-slate-800 rounded p-2 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-slate-400 font-bold uppercase text-[10px]">Trade-quality model</span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${q.status === 'ACTIVE' ? 'bg-emerald-950/70 text-emerald-300 border-emerald-700/70' : 'bg-slate-800 text-slate-400 border-slate-700'}`}>{q.status}</span>
                    <span className="text-slate-500">trained {fmtTime(q.trainedAt)} on {q.examples} trades ({q.labExamples} from shadow/live)</span>
                  </div>
                  <div className="text-slate-300">
                    {q.validation.reason}
                    {q.status === 'ACTIVE' && (
                      <span className="text-slate-400">
                        {' '}• out of sample: top half {fmtR(q.validation.topHalfR)} vs bottom half {fmtR(q.validation.bottomHalfR)} • live sizing 0.5×–1.5×, skipping {q.validation.skipRuleValidated ? 'on' : 'off (not proven)'}
                      </span>
                    )}
                    {q.status === 'INACTIVE' && <span className="text-slate-400"> • no effect on trades</span>}
                  </div>
                </div>
              );
            })()}

            {/* Promotion progress (shadow only) */}
            {s.status === 'SHADOW' && (
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] text-slate-400">
                  <span>
                    Evidence: <span className="text-slate-200 font-bold">{lc.evidenceState ?? 'not assessed yet'}</span> • {lc.closedInCurrentMode}/{lc.rules.minShadowTrades} shadow trades of version {lc.strategyVersion ?? '—'}
                  </span>
                  <span>~{Math.max(0, Math.ceil(((lc.rules.minShadowTrades - lc.closedInCurrentMode) / Math.max(bt.tradesPerYear, 1)) * 12))} months at the backtest rate</span>
                </div>
                <div className="h-1.5 bg-slate-800 rounded">
                  <div className="h-1.5 bg-amber-400 rounded" style={{ width: `${shadowProgress * 100}%` }} />
                </div>
                {lc.evidence && (
                  <div className="text-[10px] text-slate-400">
                    {lc.evidence.reason}
                    <span className="text-slate-500">
                      {' '}• checks: {lc.evidence.checks.map((c) => `${c.passed ? '✓' : '✗'} ${c.name}`).join('  ')} ({lc.rulesVersion})
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Open trade */}
            <div className="text-[11px]">
              {open ? (
                <div className="flex flex-wrap gap-x-4 gap-y-1 bg-slate-900/80 border border-slate-800 rounded p-2">
                  <span className="text-white font-bold">{open.mode} {open.side}</span>
                  <span className="text-slate-400">entry <span className="text-slate-200">{fmtPx(open.entryPrice)}</span></span>
                  <span className="text-slate-400">initial stop <span className="text-rose-300">{fmtPx(open.initialStop)}</span></span>
                  <span className="text-slate-400">trailing stop <span className="text-amber-300">{fmtPx(open.currentStop)}</span></span>
                  <span className="text-slate-400">{open.barsHeld} bars held • opened {fmtTime(open.entryTime)}</span>
                  {open.predictedR !== null && (
                    <span className="text-slate-400">model predicts <span className="text-cyan-300">{fmtR(open.predictedR)}</span> • size {open.sizeMultiplier?.toFixed(2)}×</span>
                  )}
                </div>
              ) : (
                <span className="text-slate-500">No open trade — waiting for the next signal at a {s.timeframe} close.</span>
              )}
            </div>

            {/* Recent closed trades */}
            {closed.length > 0 && (
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-slate-500 text-left">
                    <th className="font-bold py-1">Closed</th>
                    <th className="font-bold">Mode</th>
                    <th className="font-bold">Side</th>
                    <th className="font-bold">Entry</th>
                    <th className="font-bold">Exit</th>
                    <th className="font-bold">Reason</th>
                    <th className="font-bold text-right">Predicted</th>
                    <th className="font-bold text-right">Size</th>
                    <th className="font-bold text-right">Net R</th>
                  </tr>
                </thead>
                <tbody>
                  {closed.map((t) => (
                    <tr key={t.id} className="border-t border-slate-800/80 text-slate-300">
                      <td className="py-1">{fmtTime(t.exitTime)}</td>
                      <td>{t.mode}</td>
                      <td>{t.side}</td>
                      <td>{fmtPx(t.entryPrice)}</td>
                      <td>{fmtPx(t.exitPrice)}</td>
                      <td>{t.exitReason}</td>
                      <td className="text-right text-cyan-300">{fmtR(t.predictedR)}</td>
                      <td className="text-right">{t.sizeMultiplier !== null ? `${t.sizeMultiplier.toFixed(2)}×` : '—'}</td>
                      <td className={`text-right font-bold ${(t.netR ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{fmtR(t.netR)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {bt.caveat && <p className="text-[10px] text-slate-500 leading-relaxed">Note: {bt.caveat}</p>}
          </div>
        );
      })}
    </div>
  );
};
