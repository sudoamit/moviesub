'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Eye, RefreshCw } from 'lucide-react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const REFRESH_MS = 120_000;

type Scores = Record<string, { sentiment: number; importance: number }>;
interface Observation { takenAt: string; price: number; metrics: Record<string, any> }
interface ObserverStatus {
  newsScoring: string;
  nseSessionOpen: boolean;
  counts: Array<{ asset: string; kind: string; count: number }>;
  optionChains: Record<string, Observation | null>;
  volatility: Record<string, Observation | null>;
  newsTotal: number;
  newsScored: number;
  news: Array<{ id: string; source: string; title: string; url: string; publishedAt: string; scores: Scores | null; scoredAt: string | null }>;
}
interface Insight {
  asset: string;
  feature: string;
  horizon: '1h' | '1d';
  samples: number;
  needed: number;
  ic: number;
  tStat: number;
  status: 'COLLECTING' | 'NO_RELATIONSHIP' | 'LEARNED';
  meaning: string | null;
}

const fmt = (v: unknown, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export function MarketObserverCard() {
  const [status, setStatus] = useState<ObserverStatus | null>(null);
  const [insights, setInsights] = useState<Insight[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, i] = await Promise.all([fetch(`${API_BASE}/api/observer/status`), fetch(`${API_BASE}/api/observer/insights`)]);
      if (!s.ok) throw new Error(`HTTP ${s.status}`);
      setStatus(await s.json());
      if (i.ok) setInsights(await i.json());
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

  const learned = insights?.filter((x) => x.status === 'LEARNED') ?? [];
  const noRel = insights?.filter((x) => x.status === 'NO_RELATIONSHIP').length ?? 0;
  const collecting = insights?.filter((x) => x.status === 'COLLECTING') ?? [];
  const minProgress = collecting.length ? Math.min(...collecting.map((x) => x.samples)) : 0;
  const maxProgress = collecting.length ? Math.max(...collecting.map((x) => x.samples)) : 0;

  return (
    <div className="bg-[#111827]/95 border border-slate-800 rounded-xl p-5 font-mono space-y-4 text-[11px]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-white text-xs font-black uppercase tracking-wider">
          <Eye className="w-4 h-4 text-cyan-400" />
          AI Market Observer
          <span className="text-[10px] text-slate-500 font-bold normal-case tracking-normal">
            option chains, implied volatility & news • learns what predicts price (observe only, no trades)
          </span>
        </div>
        <button onClick={load} disabled={loading} className="text-slate-400 hover:text-white disabled:opacity-50" title="Refresh">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && <p className="text-rose-400">Observer unavailable ({error}).</p>}
      {!error && !status && <p className="text-slate-500">Loading…</p>}

      {status && (
        <>
          {/* What it has learned */}
          <div className="bg-slate-900/80 border border-slate-800 rounded p-2 space-y-1">
            <span className="text-slate-400 font-bold uppercase text-[10px]">What the AI has learned</span>
            {learned.length ? (
              learned.map((x) => (
                <div key={`${x.asset}-${x.feature}-${x.horizon}`} className="text-emerald-300">
                  {x.meaning} <span className="text-slate-500">(ρ {fmt(x.ic)}, t {fmt(x.tStat)}, {x.samples} samples)</span>
                </div>
              ))
            ) : (
              <div className="text-slate-300">
                Nothing proven yet.{' '}
                <span className="text-slate-500">
                  {noRel} input{noRel === 1 ? '' : 's'} tested with no relationship
                  {collecting.length > 0 && ` • ${collecting.length} still collecting (${minProgress}–${maxProgress} of ${collecting[0].needed} samples needed)`}
                </span>
              </div>
            )}
          </div>

          {/* Option chains */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {(['NIFTY', 'BANKNIFTY'] as const).map((a) => {
              const o = status.optionChains[a];
              const m = o?.metrics ?? {};
              return (
                <div key={a} className="bg-slate-900/80 border border-slate-800 rounded p-2">
                  <span className="text-white font-bold">{a} option chain</span>
                  {o ? (
                    <div className="text-slate-400 space-x-3">
                      <span>PCR <span className="text-slate-200">{fmt(m.pcrOi)}</span></span>
                      <span>max pain <span className="text-slate-200">{fmt(m.maxPain, 0)}</span></span>
                      <span>call wall <span className="text-rose-300">{fmt(m.callWall, 0)}</span></span>
                      <span>put wall <span className="text-emerald-300">{fmt(m.putWall, 0)}</span></span>
                      <span>ATM IV <span className="text-slate-200">{typeof m.atmIv === 'number' ? `${(m.atmIv * 100).toFixed(1)}%` : '—'}</span></span>
                      <span className="text-slate-500">{ago(o.takenAt)}</span>
                    </div>
                  ) : (
                    <div className="text-slate-500">{status.nseSessionOpen ? 'waiting for the first snapshot' : 'recorded during NSE hours (09:15–15:30 IST)'}</div>
                  )}
                </div>
              );
            })}
            {(['BTC', 'ETH'] as const).map((a) => {
              const o = status.volatility[a];
              return (
                <div key={a} className="bg-slate-900/80 border border-slate-800 rounded p-2">
                  <span className="text-white font-bold">{a} volatility & funding</span>
                  {o ? (
                    <div className="text-slate-400 space-x-3">
                      <span>DVOL <span className="text-slate-200">{fmt(o.metrics.dvol, 1)}</span></span>
                      <span>funding <span className="text-slate-200">{typeof o.metrics.fundingRate === 'number' ? `${(o.metrics.fundingRate * 100).toFixed(4)}%` : '—'}</span></span>
                      <span className="text-slate-500">{ago(o.takenAt)}</span>
                    </div>
                  ) : (
                    <div className="text-slate-500">waiting for the first snapshot</div>
                  )}
                </div>
              );
            })}
          </div>

          {/* News */}
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-slate-400">
              <span className="font-bold uppercase">News ({status.newsScored}/{status.newsTotal} scored)</span>
              <span className={status.newsScoring.startsWith('ON') ? 'text-emerald-400' : 'text-amber-400'}>Scoring: {status.newsScoring}</span>
            </div>
            {status.news.slice(0, 8).map((n) => {
              const entries = Object.entries(n.scores ?? {});
              return (
                <div key={n.id} className="flex flex-wrap gap-x-2 border-b border-slate-800/60 pb-1">
                  <span className="text-slate-500 w-16 shrink-0">{ago(n.publishedAt)}</span>
                  <a href={n.url} target="_blank" rel="noreferrer" className="text-slate-200 hover:text-cyan-300 flex-1 min-w-0 truncate">
                    {n.title}
                  </a>
                  {entries.map(([asset, s]) => (
                    <span key={asset} className={s.sentiment > 0.15 ? 'text-emerald-400' : s.sentiment < -0.15 ? 'text-rose-400' : 'text-slate-400'}>
                      {asset} {s.sentiment > 0 ? '+' : ''}{s.sentiment.toFixed(1)}
                    </span>
                  ))}
                  {!n.scoredAt && <span className="text-slate-600">unscored</span>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
