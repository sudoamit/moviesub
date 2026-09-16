'use client';

import React from 'react';
import { WifiOff, AlertTriangle, RefreshCw, Clock } from 'lucide-react';
import { MarketDataState } from '../../hooks/useMarketContext';

interface MarketStatusBadgeProps {
  marketDataState?: MarketDataState;
  className?: string;
}

export const MarketStatusBadge: React.FC<MarketStatusBadgeProps> = ({
  marketDataState,
  className = '',
}) => {
  const status = marketDataState?.status || 'CONNECTED';
  const isStale = marketDataState?.isStale;
  const latencyMs = marketDataState?.latencyMs;
  const provider = marketDataState?.providerId || 'FEED';
  const provenance = marketDataState?.dataProvenance || 'LIVE';

  if (status === 'UNAVAILABLE') {
    return (
      <div
        role="status"
        aria-label="Market Data Unavailable"
        title={`Provider: ${provider} | Provenance: ${provenance} | Status: Unavailable`}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-panel border border-rose-500/30 text-xs font-mono ${className}`}
      >
        <WifiOff className="w-3.5 h-3.5 text-rose-400 shrink-0" />
        <span className="text-[11px] font-bold text-rose-400">UNAVAILABLE</span>
      </div>
    );
  }

  if (status === 'DEGRADED') {
    return (
      <div
        role="status"
        aria-label="Market Data Degraded"
        title={`Provider: ${provider} | Provenance: ${provenance} | Status: Degraded`}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-panel border border-amber-500/30 text-xs font-mono ${className}`}
      >
        <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
        <span className="text-[11px] font-bold text-amber-400">DEGRADED</span>
      </div>
    );
  }

  if (status === 'RECONNECTING') {
    return (
      <div
        role="status"
        aria-label="Market Data Reconnecting"
        title={`Provider: ${provider} | Provenance: ${provenance} | Status: Reconnecting`}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-panel border border-amber-500/30 text-xs font-mono ${className}`}
      >
        <RefreshCw className="w-3.5 h-3.5 text-amber-400 animate-spin shrink-0" />
        <span className="text-[11px] font-bold text-amber-400">CONNECTING</span>
      </div>
    );
  }

  if (isStale || status === 'STALE') {
    const ageStr = latencyMs ? `${(latencyMs / 1000).toFixed(1)}s old` : 'Stale Feed';
    return (
      <div
        role="status"
        aria-label="Market Data Connected Stale"
        title={`Provider: ${provider} | Provenance: ${provenance} | Data is ${ageStr}`}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-panel border border-amber-500/40 text-xs font-mono ${className}`}
      >
        <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
        <span className="text-[11px] font-bold text-amber-400">STALE · {ageStr}</span>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-label="Market Data Connected Fresh"
      title={`Provider: ${provider} | Provenance: ${provenance} | Status: Live Fresh Feed`}
      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-panel border border-surface-border text-xs font-mono ${className}`}
    >
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
      </span>
      <span className="text-[11px] font-bold text-emerald-400">CONNECTED · FRESH</span>
    </div>
  );
};
