'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  Activity,
  Zap,
  Shield,
  BarChart2,
  BookOpen,
  Layers,
  Grid2X2,
  PieChart,
  Wallet,
  Bell,
  Brain,
  Sparkles,
  Search,
  Sliders,
  ChevronDown,
  Clock,
  Compass,
  Cpu,
  BrainCircuit,
  FlaskConical,
  Menu,
  X,
  Wifi,
  WifiOff,
  AlertTriangle,
} from 'lucide-react';
import { MarketDataState } from '../hooks/useMarketContext';

export type NavGroup = 'terminal' | 'analyze' | 'trade' | 'research' | 'automation' | 'history';

export type NavTab =
  | 'terminal'
  | 'quant'
  | 'scanner'
  | 'multichart'
  | 'radar'
  | 'smt'
  | 'correlation'
  | 'macro'
  | 'options'
  | 'paper'
  | 'risk'
  | 'learning'
  | 'research'
  | 'backtest'
  | 'algo'
  | 'journal';

export type StrategyMode = 'SMC' | 'SAIYAN_OCC' | 'HYBRID';

export interface NavItemConfig {
  id: NavTab;
  label: string;
  icon: React.ReactNode;
  badge?: string;
  description?: string;
}

export const NAV_GROUPS: {
  id: NavGroup;
  label: string;
  defaultTab: NavTab;
  items: NavItemConfig[];
}[] = [
  {
    id: 'terminal',
    label: 'Terminal',
    defaultTab: 'terminal',
    items: [
      {
        id: 'terminal',
        label: 'Live Terminal',
        icon: <Activity className="w-4 h-4 text-cyan-400" />,
        description: 'Real-time SMC chart & execution cockpit',
      },
    ],
  },
  {
    id: 'analyze',
    label: 'Analyze',
    defaultTab: 'quant',
    items: [
      {
        id: 'quant',
        label: 'Quant Intelligence',
        icon: <BrainCircuit className="w-4 h-4 text-cyan-400" />,
        badge: 'v2.0',
        description: 'Deep market structure & bias metrics',
      },
      {
        id: 'scanner',
        label: 'SMC Scanner',
        icon: <Search className="w-4 h-4 text-emerald-400" />,
        description: 'Multi-market real-time setup scanner',
      },
      {
        id: 'multichart',
        label: 'Multi-Chart',
        icon: <Grid2X2 className="w-4 h-4 text-slate-300" />,
        description: 'Dual & quad split-view workspace',
      },
      {
        id: 'radar',
        label: 'Flow Radar',
        icon: <Compass className="w-4 h-4 text-cyan-400" />,
        badge: '4-Tier',
        description: 'Multi-timeframe liquidity stream',
      },
      {
        id: 'smt',
        label: 'SMT Divergence',
        icon: <Sliders className="w-4 h-4 text-indigo-400" />,
        description: 'Correlated index divergence detection',
      },
      {
        id: 'correlation',
        label: 'Correlation',
        icon: <PieChart className="w-4 h-4 text-amber-400" />,
        description: 'Asset correlation & beta matrix',
      },
      {
        id: 'macro',
        label: 'Macro Calendar',
        icon: <Clock className="w-4 h-4 text-slate-400" />,
        description: 'Economic events & VIX regime guard',
      },
    ],
  },
  {
    id: 'trade',
    label: 'Trade',
    defaultTab: 'paper',
    items: [
      {
        id: 'paper',
        label: 'Paper Trading',
        icon: <Wallet className="w-4 h-4 text-emerald-400" />,
        description: 'Real PostgreSQL paper execution desk',
      },
      {
        id: 'options',
        label: 'Options Suite',
        icon: <Layers className="w-4 h-4 text-cyan-400" />,
        badge: 'BSM',
        description: 'Greeks matrix & strike analyzer',
      },
      {
        id: 'risk',
        label: 'Risk Desk',
        icon: <Shield className="w-4 h-4 text-rose-400" />,
        description: 'Position sizing & max loss limits',
      },
    ],
  },
  {
    id: 'research',
    label: 'Research',
    defaultTab: 'learning',
    items: [
      {
        id: 'learning',
        label: 'AI Learning',
        icon: <Brain className="w-4 h-4 text-purple-400" />,
        badge: 'ML',
        description: 'Adaptive retraining & edge evaluation',
      },
      {
        id: 'research',
        label: 'Research Lab',
        icon: <FlaskConical className="w-4 h-4 text-emerald-400" />,
        badge: 'OOS',
        description: 'Out-of-sample hypothesis testing',
      },
      {
        id: 'backtest',
        label: 'Backtesting',
        icon: <BarChart2 className="w-4 h-4 text-amber-400" />,
        description: 'Institutional historical simulation',
      },
    ],
  },
  {
    id: 'automation',
    label: 'Automation',
    defaultTab: 'algo',
    items: [
      {
        id: 'algo',
        label: 'Algo Bots',
        icon: <Cpu className="w-4 h-4 text-cyan-400" />,
        badge: 'AUTO',
        description: 'Rule-based strategy bots & execution locks',
      },
    ],
  },
  {
    id: 'history',
    label: 'History',
    defaultTab: 'journal',
    items: [
      {
        id: 'journal',
        label: 'Journal',
        icon: <BookOpen className="w-4 h-4 text-slate-300" />,
        description: 'Audited execution journal & P&L review',
      },
    ],
  },
];

interface HeaderProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  marketDataState?: MarketDataState;
  onTriggerScan: () => void;
  isScanning: boolean;
  selectedStrategy: StrategyMode;
  onSelectStrategy: (strategy: StrategyMode) => void;
  onOpenAlertsModal?: () => void;
  onOpenAICopilotModal?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  onSelectTab,
  marketDataState,
  onTriggerScan,
  isScanning,
  selectedStrategy,
  onSelectStrategy,
  onOpenAlertsModal,
  onOpenAICopilotModal,
}) => {
  const [openDropdownGroup, setOpenDropdownGroup] = useState<NavGroup | null>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState<boolean>(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Determine which primary group contains the current activeTab
  const currentGroup =
    NAV_GROUPS.find((g) => g.items.some((i) => i.id === activeTab)) || NAV_GROUPS[0];

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpenDropdownGroup(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleGroupClick = (group: (typeof NAV_GROUPS)[number]) => {
    if (group.items.length === 1) {
      onSelectTab(group.items[0].id);
      setOpenDropdownGroup(null);
    } else {
      setOpenDropdownGroup(openDropdownGroup === group.id ? null : group.id);
    }
  };

  const status = marketDataState?.status || 'CONNECTED';

  return (
    <header className="border-b border-surface-border bg-surface-subtle/95 backdrop-blur-md sticky top-0 z-50 px-3 sm:px-6 py-2">
      <div className="flex items-center justify-between gap-4 max-w-[1720px] mx-auto">
        {/* Left: Brand & Strategy Engine */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-surface-elevated border border-surface-border flex items-center justify-center text-cyan-400">
              <Zap className="w-4 h-4 fill-cyan-400/20 text-cyan-400" />
            </div>
            <div>
              <div className="flex items-center gap-1.5 leading-none">
                <span className="text-sm font-bold tracking-tight text-white font-mono">
                  QUANT PLATFORM
                </span>
                <span className="text-[10px] font-semibold text-cyan-400 bg-cyan-950/80 border border-cyan-800/60 px-1 py-0.2 rounded font-mono">
                  v2.8
                </span>
              </div>
              <span className="text-[10px] text-slate-400 font-mono">
                Institutional Execution System
              </span>
            </div>
          </div>

          <div className="hidden md:block h-5 w-px bg-surface-border" />

          {/* Strategy Mode Switcher (Authoritative) */}
          <div
            role="radiogroup"
            aria-label="Strategy Mode"
            className="hidden sm:flex items-center bg-surface-panel border border-surface-border rounded-lg p-0.5 text-xs font-mono"
          >
            {(['SMC', 'SAIYAN_OCC', 'HYBRID'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={selectedStrategy === mode}
                onClick={() => onSelectStrategy(mode)}
                className={`px-2.5 py-1 rounded-md font-bold transition-colors ${
                  selectedStrategy === mode
                    ? 'bg-cyan-500 text-slate-950 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {mode === 'SMC' ? 'SMC' : mode === 'SAIYAN_OCC' ? 'SAIYAN' : 'HYBRID'}
              </button>
            ))}
          </div>
        </div>

        {/* Center: Grouped Navigation (Desktop) */}
        <nav
          ref={dropdownRef}
          aria-label="Main Navigation"
          className="hidden lg:flex items-center gap-1 bg-surface-panel border border-surface-border rounded-xl p-1 text-xs font-mono relative"
        >
          {NAV_GROUPS.map((group) => {
            const isGroupActive = currentGroup.id === group.id;
            const isDropdownOpen = openDropdownGroup === group.id;
            const activeChild = group.items.find((i) => i.id === activeTab);

            return (
              <div key={group.id} className="relative">
                <button
                  type="button"
                  aria-expanded={isDropdownOpen}
                  aria-haspopup={group.items.length > 1}
                  onClick={() => handleGroupClick(group)}
                  className={`px-3 py-1.5 rounded-lg font-bold transition-all flex items-center gap-1.5 ${
                    isGroupActive
                      ? 'bg-surface-elevated text-cyan-400 border border-cyan-500/30 shadow-sm'
                      : 'text-slate-300 hover:text-white hover:bg-surface-hover'
                  }`}
                >
                  <span>{group.label}</span>
                  {group.items.length > 1 && (
                    <ChevronDown
                      className={`w-3 h-3 text-slate-400 transition-transform ${
                        isDropdownOpen ? 'rotate-180' : ''
                      }`}
                    />
                  )}
                </button>

                {/* Dropdown Menu for Multi-Item Groups */}
                {isDropdownOpen && group.items.length > 1 && (
                  <div
                    role="menu"
                    className="absolute top-full left-0 mt-2 w-56 bg-surface-elevated border border-surface-border rounded-xl p-1.5 shadow-2xl z-50 animate-in fade-in slide-in-from-top-2 duration-150"
                  >
                    <div className="px-2 py-1 text-[10px] text-slate-400 uppercase tracking-wider font-semibold border-b border-surface-border mb-1">
                      {group.label} Tools
                    </div>
                    {group.items.map((item) => {
                      const isItemActive = activeTab === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            onSelectTab(item.id);
                            setOpenDropdownGroup(null);
                          }}
                          className={`w-full text-left px-2.5 py-2 rounded-lg text-xs font-mono transition-colors flex items-center justify-between ${
                            isItemActive
                              ? 'bg-cyan-500/20 text-cyan-300 font-bold'
                              : 'text-slate-300 hover:bg-surface-hover hover:text-white'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            {item.icon}
                            <span>{item.label}</span>
                          </div>
                          {item.badge && (
                            <span className="text-[9px] px-1 py-0.5 rounded font-black bg-cyan-950 text-cyan-400 border border-cyan-800">
                              {item.badge}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Right: Market State Badge & Action Triggers */}
        <div className="flex items-center gap-2.5">
          {/* Data State Indicator */}
          <div
            title={`Provider: ${marketDataState?.providerId || 'FEED'} | Provenance: ${marketDataState?.dataProvenance || 'LIVE'}`}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-panel border border-surface-border text-xs font-mono"
          >
            {status === 'CONNECTED' ? (
              <>
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                <span className="text-[11px] font-bold text-emerald-400">LIVE</span>
              </>
            ) : status === 'RECONNECTING' ? (
              <>
                <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping" />
                <span className="text-[11px] font-bold text-amber-400">CONNECTING</span>
              </>
            ) : status === 'DEGRADED' ? (
              <>
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-[11px] font-bold text-amber-400">DEGRADED</span>
              </>
            ) : (
              <>
                <WifiOff className="w-3.5 h-3.5 text-rose-400" />
                <span className="text-[11px] font-bold text-rose-400">UNAVAILABLE</span>
              </>
            )}
          </div>

          {/* AI Copilot Button */}
          {onOpenAICopilotModal && (
            <button
              type="button"
              onClick={onOpenAICopilotModal}
              aria-label="Open AI Copilot"
              className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface-panel hover:bg-surface-hover border border-surface-border text-purple-300 text-xs font-mono font-bold transition-colors"
            >
              <Brain className="w-3.5 h-3.5 text-purple-400" />
              <span>Copilot</span>
            </button>
          )}

          {/* Alerts Button */}
          {onOpenAlertsModal && (
            <button
              type="button"
              onClick={onOpenAlertsModal}
              aria-label="Manage Alerts"
              className="p-1.5 rounded-lg bg-surface-panel hover:bg-surface-hover border border-surface-border text-slate-300 transition-colors"
            >
              <Bell className="w-4 h-4" />
            </button>
          )}

          {/* Scan All Button */}
          <button
            type="button"
            onClick={onTriggerScan}
            disabled={isScanning}
            aria-label="Scan All Markets"
            className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs font-mono flex items-center gap-1.5 transition-colors active:scale-95 disabled:opacity-50"
          >
            <Search className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`} />
            <span>{isScanning ? 'SCANNING' : 'SCAN'}</span>
          </button>

          {/* Mobile Menu Hamburger */}
          <button
            type="button"
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            aria-label="Open Navigation Drawer"
            className="lg:hidden p-1.5 rounded-lg bg-surface-panel border border-surface-border text-slate-300"
          >
            {isMobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Secondary Contextual Submenu Bar (When an active group has sub-items) */}
      {currentGroup.items.length > 1 && (
        <div className="hidden lg:flex items-center gap-1 mt-2 pt-1.5 border-t border-surface-border/50 overflow-x-auto max-w-[1720px] mx-auto font-mono text-xs">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold mr-2 flex items-center gap-1">
            {currentGroup.label}:
          </span>
          {currentGroup.items.map((item) => {
            const isItemActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`px-2.5 py-1 rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap ${
                  isItemActive
                    ? 'bg-surface-elevated text-cyan-400 font-bold border border-surface-border'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-surface-hover'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.badge && (
                  <span className="text-[9px] px-1 rounded bg-cyan-950 text-cyan-400 border border-cyan-800 font-bold">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Mobile Navigation Drawer */}
      {isMobileMenuOpen && (
        <div className="lg:hidden mt-2 pt-2 border-t border-surface-border space-y-3 font-mono">
          {/* Strategy Mode for Mobile */}
          <div className="flex items-center justify-between bg-surface-panel p-1.5 rounded-lg border border-surface-border">
            <span className="text-xs text-slate-400">Strategy:</span>
            <div className="flex items-center gap-1 text-xs">
              {(['SMC', 'SAIYAN_OCC', 'HYBRID'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onSelectStrategy(mode)}
                  className={`px-2 py-0.5 rounded ${
                    selectedStrategy === mode
                      ? 'bg-cyan-500 text-slate-950 font-bold'
                      : 'text-slate-400'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {/* Grouped Links */}
          <div className="grid grid-cols-2 gap-2 max-h-80 overflow-y-auto p-1">
            {NAV_GROUPS.flatMap((group) => group.items).map((item) => {
              const isItemActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onSelectTab(item.id);
                    setIsMobileMenuOpen(false);
                  }}
                  className={`p-2 rounded-lg text-left text-xs transition-colors flex items-center gap-2 border ${
                    isItemActive
                      ? 'bg-surface-elevated border-cyan-500/40 text-cyan-300 font-bold'
                      : 'bg-surface-panel border-surface-border text-slate-300'
                  }`}
                >
                  {item.icon}
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </header>
  );
};
