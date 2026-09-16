'use client';

import React from 'react';
import {
  Clock,
  WifiOff,
  Search,
  Database,
  ShieldAlert,
  Inbox,
  BarChart2,
  RefreshCw,
  Wallet,
  Brain,
  Layers,
} from 'lucide-react';

export type EmptyStateVariant = 'empty' | 'stale' | 'unavailable' | 'error' | 'loading';

export type EmptyStatePreset =
  | 'no-signal'
  | 'no-position'
  | 'no-trades'
  | 'no-market-data'
  | 'no-scan-results'
  | 'no-research-runs';

interface EmptyStateProps {
  preset?: EmptyStatePreset;
  title?: string;
  description?: string;
  variant?: EmptyStateVariant;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}

const PRESET_CONFIGS: Record<
  EmptyStatePreset,
  { title: string; description: string; variant: EmptyStateVariant; defaultIcon: React.ReactNode }
> = {
  'no-signal': {
    title: 'No Active Signal',
    description: 'Awaiting high-probability SMC structure confirmation or liquidity sweep setup.',
    variant: 'empty',
    defaultIcon: <Search className="w-6 h-6 text-slate-400" />,
  },
  'no-position': {
    title: 'No Open Position',
    description: 'Execution desk is standing by. Orders will appear when bot triggers or manual entry fills.',
    variant: 'empty',
    defaultIcon: <Wallet className="w-6 h-6 text-emerald-400" />,
  },
  'no-trades': {
    title: 'No Completed Trades',
    description: 'No closed trades recorded in this session. Audit log updates upon trade exit.',
    variant: 'empty',
    defaultIcon: <BarChart2 className="w-6 h-6 text-slate-400" />,
  },
  'no-market-data': {
    title: 'No Market Data Feed',
    description: 'Live ticker feed is disconnected or unavailable. Verifying WebSocket broker stream...',
    variant: 'unavailable',
    defaultIcon: <WifiOff className="w-6 h-6 text-rose-400" />,
  },
  'no-scan-results': {
    title: 'No Scan Results',
    description: 'No watchlist setups met the institutional score and risk filter criteria.',
    variant: 'empty',
    defaultIcon: <Layers className="w-6 h-6 text-amber-400" />,
  },
  'no-research-runs': {
    title: 'No Research Runs',
    description: 'Launch a parameter sweep or walk-forward test to evaluate quantitative strategies.',
    variant: 'empty',
    defaultIcon: <Brain className="w-6 h-6 text-purple-400" />,
  },
};

export const EmptyState: React.FC<EmptyStateProps> = ({
  preset,
  title,
  description,
  variant = 'empty',
  actionLabel,
  onAction,
  className = '',
}) => {
  const presetConfig = preset ? PRESET_CONFIGS[preset] : null;

  const effectiveTitle = title || presetConfig?.title || 'No Data Available';
  const effectiveDescription =
    description || presetConfig?.description || 'No records found for the current query.';
  const effectiveVariant = presetConfig?.variant || variant;

  const getIcon = () => {
    if (presetConfig?.defaultIcon) return presetConfig.defaultIcon;
    switch (effectiveVariant) {
      case 'stale':
        return <Clock className="w-6 h-6 text-amber-400" />;
      case 'unavailable':
        return <WifiOff className="w-6 h-6 text-rose-400" />;
      case 'error':
        return <ShieldAlert className="w-6 h-6 text-rose-400" />;
      case 'loading':
        return <RefreshCw className="w-6 h-6 text-cyan-400 animate-spin" />;
      case 'empty':
      default:
        return <Inbox className="w-6 h-6 text-slate-500" />;
    }
  };

  const getBorderColor = () => {
    switch (effectiveVariant) {
      case 'stale':
        return 'border-amber-500/30 bg-amber-950/20';
      case 'unavailable':
      case 'error':
        return 'border-rose-500/30 bg-rose-950/20';
      case 'loading':
        return 'border-cyan-500/30 bg-cyan-950/20';
      case 'empty':
      default:
        return 'border-surface-border bg-surface-panel/60';
    }
  };

  return (
    <div
      role="status"
      aria-label={effectiveTitle}
      className={`terminal-panel p-6 flex flex-col items-center justify-center text-center font-mono ${getBorderColor()} ${className}`}
    >
      <div className="w-12 h-12 rounded-xl bg-surface-panel border border-surface-border flex items-center justify-center mb-3 shadow-inner">
        {getIcon()}
      </div>

      <h3 className="text-sm font-bold text-white mb-1.5 uppercase tracking-wide">
        {effectiveTitle}
      </h3>
      <p className="text-xs text-slate-400 max-w-md leading-relaxed">{effectiveDescription}</p>

      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-4 px-3 py-1.5 rounded-lg bg-surface-elevated hover:bg-surface-hover border border-surface-border text-cyan-300 hover:text-white text-xs font-bold transition-colors shadow-sm"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
};
