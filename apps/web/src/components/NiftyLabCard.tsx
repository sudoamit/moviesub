'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { GraduationCap, RefreshCw } from 'lucide-react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const REFRESH_MS = 60_000;

interface Fit { trades: number; delta: number; thetaPerHour: number; cost: number; residualSd: number; modelBias: number | null }
interface Live { trades: number; realPriced: number; meanPoints: number; totalPoints: number; tStat: number; winRate: number; verdict: 'WATCHING' | 'CONFIRMED' | 'RETIRE'; reason: string }
interface Trade {
  id: string; date: string; side: number; signalTime: string; indexEntry: number; optionContract: string; optionEntry: number | null;
  status: 'OPEN' | 'CLOSED'; exitReason: string | null; indexPoints: number | null; optionPoints: number | null; modelPoints: number | null;
}
interface Summary {
  lastStudy: { ranAt: string; sessions: number; from: string; to: string; tested: number; passed: number; optionModel: unknown } | null;
  optionModel: { assumed: { delta: number; thetaPerHour: number; cost: number }; learned: Fit | null };
  conditions: Array<{ feature: string; trades: number; status: string; meaning: string | null }>;
  strategies: Array<{ id: string; name: string; status: 'WATCH' | 'RETIRED'; statusReason: string | null; study: any; live: Live; trades: Trade[] }>;
}

const pts = (v: number | null | undefined) => (typeof v === 'number' ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}` : '—');

export function NiftyLabCard() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/nifty-lab`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
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

  const learnedConditions = data?.conditions.filter((c) => c.status === 'LEARNED') ?? [];
  const maxCondTrades = data?.conditions.length ? Math.max(...data.conditions.map((c) => c.trades)) : 0;
  const m = data?.optionModel;

  return (
    <div className="bg-[#111827]/95 border border-slate-800 rounded-xl p-5 font-mono space-y-4 text-[11px]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-white text-xs font-black uppercase tracking-wider">
          <GraduationCap className="w-4 h-4 text-cyan-400" />
          NIFTY Intraday Lab
          <span className="text-[10px] text-slate-500 font-bold normal-case tracking-normal">
            study candidates forward-tested live with real option prices • watch only, no money
          </span>
        </div>
        <button onClick={load} disabled={loading} className="text-slate-400 hover:text-white disabled:opacity-50" title="Refresh">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && <p className="text-rose-400">NIFTY lab unavailable ({error}).</p>}
      {!error && !data && <p className="text-slate-500">Loading…</p>}

      {data && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <div className="bg-slate-900/80 border border-slate-800 rounded p-2">
              <span className="text-slate-400 font-bold uppercase text-[10px] block">Last study</span>
              {data.lastStudy ? (
                <span className="text-slate-300">
                  {data.lastStudy.tested} strategies on {data.lastStudy.sessions} sessions • <span className={data.lastStudy.passed ? 'text-emerald-400' : 'text-amber-300'}>{data.lastStudy.passed} passed</span> • {new Date(data.lastStudy.ranAt).toLocaleDateString()}
                </span>
              ) : (
                <span className="text-slate-500">not run yet (weekly)</span>
              )}
            </div>
            <div className="bg-slate-900/80 border border-slate-800 rounded p-2">
              <span className="text-slate-400 font-bold uppercase text-[10px] block">Option cost model</span>
              {m?.learned ? (
                <span className="text-slate-300">
                  learned from {m.learned.trades} real trades: delta {m.learned.delta.toFixed(2)}, decay {m.learned.thetaPerHour.toFixed(1)}/h, cost {m.learned.cost.toFixed(1)} pts
                  {m.learned.modelBias !== null && <span className="text-slate-500"> • assumed model was off by {pts(m.learned.modelBias)} pts/trade</span>}
                </span>
              ) : (
                <span className="text-slate-500">
                  assumed: delta {m?.assumed.delta}, decay {m?.assumed.thetaPerHour}/h, cost {m?.assumed.cost} pts • learned after 20 real trades
                </span>
              )}
            </div>
            <div className="bg-slate-900/80 border border-slate-800 rounded p-2">
              <span className="text-slate-400 font-bold uppercase text-[10px] block">Entry conditions learned</span>
              {learnedConditions.length ? (
                learnedConditions.map((c) => <div key={c.feature} className="text-emerald-300">{c.meaning}</div>)
              ) : (
                <span className="text-slate-500">none yet • {maxCondTrades}/60 trades needed</span>
              )}
            </div>
          </div>

          {data.strategies.length === 0 && <p className="text-slate-500">No watch strategies yet; the weekly study registers them.</p>}
          {data.strategies.map((st) => {
            const open = st.trades.find((t) => t.status === 'OPEN');
            const recent = st.trades.filter((t) => t.status === 'CLOSED').slice(0, 5);
            return (
              <div key={st.id} className={`border rounded p-2 space-y-1 ${st.status === 'RETIRED' ? 'border-slate-800 opacity-60' : 'border-slate-700'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                    st.live.verdict === 'CONFIRMED' ? 'bg-emerald-950/70 text-emerald-300 border-emerald-700/70'
                    : st.status === 'RETIRED' ? 'bg-slate-800 text-slate-400 border-slate-700'
                    : 'bg-amber-950/60 text-amber-300 border-amber-800/70'}`}>
                    {st.status === 'RETIRED' ? 'RETIRED' : st.live.verdict}
                  </span>
                  <span className="text-white font-bold">{st.name}</span>
                </div>
                <div className="text-slate-400">
                  study {pts(st.study?.full?.mean)} pts/trade over {st.study?.full?.trades ?? 0} trades (modelled) •
                  live <span className={st.live.meanPoints >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{pts(st.live.meanPoints)}</span> pts/trade over {st.live.trades} ({st.live.realPriced} real-priced) • {st.live.reason}
                </div>
                {open && (
                  <div className="text-cyan-300">
                    OPEN {open.side > 0 ? 'LONG' : 'SHORT'} {open.optionContract} @ {open.optionEntry ?? 'n/a'} (NIFTY {open.indexEntry.toFixed(1)}, {new Date(open.signalTime).toLocaleTimeString()})
                  </div>
                )}
                {recent.map((t) => (
                  <div key={t.id} className="text-slate-500">
                    {t.date} {t.side > 0 ? 'LONG' : 'SHORT'} {t.optionContract} • {t.exitReason} • NIFTY {pts(t.indexPoints)} • option <span className={(t.optionPoints ?? t.modelPoints ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{pts(t.optionPoints)}</span> (model {pts(t.modelPoints)})
                  </div>
                ))}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
