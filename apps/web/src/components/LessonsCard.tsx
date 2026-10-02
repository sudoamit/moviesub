'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Lightbulb, RefreshCw } from 'lucide-react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const REFRESH_MS = 300_000;

interface Lesson {
  id: string;
  kind: 'LAB' | 'NIFTY';
  strategyId: string;
  mistake: string;
  evidenceJson: { count: number; losses: number; share: number };
  fixDescription: string | null;
  status: 'ADOPTED' | 'REJECTED_BY_HISTORY' | 'NO_FIX_AVAILABLE';
  reason: string;
  childStrategyId: string | null;
  createdAt: string;
}
interface Summary {
  reviewed: number;
  losses: number;
  mistakes: Array<{ mistake: string; text: string; count: number }>;
  lessons: Lesson[];
}

const STATUS_STYLE: Record<Lesson['status'], string> = {
  ADOPTED: 'bg-emerald-950/70 text-emerald-300 border-emerald-700/70',
  REJECTED_BY_HISTORY: 'bg-slate-800 text-slate-300 border-slate-700',
  NO_FIX_AVAILABLE: 'bg-slate-800 text-slate-400 border-slate-700',
};
const STATUS_TEXT: Record<Lesson['status'], string> = {
  ADOPTED: 'FIX ADOPTED • trying it live',
  REJECTED_BY_HISTORY: 'NOT A REAL MISTAKE • history says bad luck',
  NO_FIX_AVAILABLE: 'NO FIX AVAILABLE',
};

export function LessonsCard() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/lessons`);
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

  return (
    <div className="bg-[#111827]/95 border border-slate-800 rounded-xl p-5 font-mono space-y-3 text-[11px]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-white text-xs font-black uppercase tracking-wider">
          <Lightbulb className="w-4 h-4 text-amber-300" />
          AI Lessons
          <span className="text-[10px] text-slate-500 font-bold normal-case tracking-normal">
            every closed trade is reviewed • repeated mistakes become fixes, tested on history before trying them live
          </span>
        </div>
        <button onClick={load} disabled={loading} className="text-slate-400 hover:text-white disabled:opacity-50" title="Refresh">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && <p className="text-rose-400">Lessons unavailable ({error}).</p>}
      {!error && !data && <p className="text-slate-500">Loading…</p>}
      {data && (
        <>
          <div className="text-slate-400">
            {data.reviewed} trades reviewed • {data.losses} losses
            {data.mistakes.length > 0 && (
              <span>
                {' '}• most common mistakes: {data.mistakes.slice(0, 4).map((m) => `${m.text} (${m.count})`).join(', ')}
              </span>
            )}
          </div>
          {data.lessons.length === 0 ? (
            <p className="text-slate-500">No lessons yet: a mistake must repeat (3+ times and 40%+ of a strategy&apos;s losses) before the AI acts on it.</p>
          ) : (
            data.lessons.map((l) => (
              <div key={l.id} className="border border-slate-800 rounded p-2 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${STATUS_STYLE[l.status]}`}>{STATUS_TEXT[l.status]}</span>
                  <span className="text-slate-500">{l.kind === 'NIFTY' ? 'NIFTY' : 'crypto'} • {new Date(l.createdAt).toLocaleDateString()}</span>
                </div>
                <div className="text-slate-200">
                  {l.strategyId}: <span className="text-amber-300">{data.mistakes.find((m) => m.mistake === l.mistake)?.text ?? l.mistake}</span> in {l.evidenceJson.count} of {l.evidenceJson.losses} losses
                  {l.fixDescription && <span className="text-slate-400"> → fix tried on history: {l.fixDescription}</span>}
                </div>
                <div className="text-slate-500">{l.reason}</div>
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}
