'use client';

import React, { useState, useEffect, useRef, KeyboardEvent } from 'react';
import {
  Activity,
  BrainCircuit,
  Search,
  Grid2X2,
  Compass,
  Sliders,
  PieChart,
  Clock,
  Wallet,
  Layers,
  Shield,
  Brain,
  FlaskConical,
  BarChart2,
  Cpu,
  BookOpen,
} from 'lucide-react';
import { NavGroupButton } from './NavGroupButton';
import { NavDropdown } from './NavDropdown';

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
        description: 'SMC chart & execution cockpit',
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
        description: 'Market structure & bias metrics',
      },
      {
        id: 'scanner',
        label: 'SMC Scanner',
        icon: <Search className="w-4 h-4 text-emerald-400" />,
        description: 'Multi-market setup scanner',
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
        description: 'Paper trading & execution desk',
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
        description: 'Position sizing & loss limits',
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
        description: 'Hypothesis testing & validation',
      },
      {
        id: 'backtest',
        label: 'Backtesting',
        icon: <BarChart2 className="w-4 h-4 text-amber-400" />,
        description: 'Historical simulation & performance',
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
        description: 'Strategy bots & automated execution',
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
        description: 'Execution journal & P&L review',
      },
    ],
  },
];

interface PrimaryNavigationProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  className?: string;
}

export const PrimaryNavigation: React.FC<PrimaryNavigationProps> = ({
  activeTab,
  onSelectTab,
  className = '',
}) => {
  const [openDropdownGroup, setOpenDropdownGroup] = useState<NavGroup | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef<{ [key in NavGroup]?: HTMLButtonElement | null }>({});
  const menuItemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const currentGroup =
    NAV_GROUPS.find((g) => g.items.some((i) => i.id === activeTab)) || NAV_GROUPS[0];

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpenDropdownGroup(null);
        setFocusedIndex(-1);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleGroupClick = (group: (typeof NAV_GROUPS)[number]) => {
    if (group.items.length === 1) {
      onSelectTab(group.items[0].id);
      setOpenDropdownGroup(null);
      setFocusedIndex(-1);
    } else {
      const willOpen = openDropdownGroup !== group.id;
      setOpenDropdownGroup(willOpen ? group.id : null);
      setFocusedIndex(willOpen ? 0 : -1);
    }
  };

  const handleTriggerKeyDown = (
    e: KeyboardEvent<HTMLButtonElement>,
    group: (typeof NAV_GROUPS)[number]
  ) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      if (group.items.length > 1) {
        e.preventDefault();
        setOpenDropdownGroup(group.id);
        setFocusedIndex(0);
        setTimeout(() => {
          menuItemRefs.current[0]?.focus();
        }, 10);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelectTab(group.items[0].id);
      }
    } else if (e.key === 'Escape') {
      if (openDropdownGroup) {
        e.preventDefault();
        setOpenDropdownGroup(null);
        setFocusedIndex(-1);
      }
    }
  };

  const handleMenuKeyDown = (
    e: KeyboardEvent<HTMLDivElement>,
    group: (typeof NAV_GROUPS)[number]
  ) => {
    const total = group.items.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = (focusedIndex + 1) % total;
      setFocusedIndex(next);
      menuItemRefs.current[next]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = (focusedIndex - 1 + total) % total;
      setFocusedIndex(prev);
      menuItemRefs.current[prev]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpenDropdownGroup(null);
      setFocusedIndex(-1);
      triggerRefs.current[group.id]?.focus();
    } else if (e.key === 'Tab') {
      setOpenDropdownGroup(null);
      setFocusedIndex(-1);
    }
  };

  return (
    <nav
      ref={dropdownRef}
      aria-label="Primary Navigation"
      className={`items-center gap-1 bg-surface-panel border border-surface-border rounded-xl p-1 text-xs font-mono relative ${className}`}
    >
      {NAV_GROUPS.map((group) => {
        const isGroupActive = currentGroup.id === group.id;
        const isDropdownOpen = openDropdownGroup === group.id;

        return (
          <div key={group.id} className="relative">
            <NavGroupButton
              groupId={group.id}
              label={group.label}
              hasDropdown={group.items.length > 1}
              isActive={isGroupActive}
              isOpen={isDropdownOpen}
              onClick={() => handleGroupClick(group)}
              onKeyDown={(e) => handleTriggerKeyDown(e, group)}
              buttonRef={(el) => {
                triggerRefs.current[group.id] = el;
              }}
            />

            {isDropdownOpen && group.items.length > 1 && (
              <NavDropdown
                groupId={group.id}
                groupLabel={group.label}
                items={group.items}
                activeTab={activeTab}
                focusedIndex={focusedIndex}
                onSelectTab={(tabId) => {
                  onSelectTab(tabId);
                  setOpenDropdownGroup(null);
                  setFocusedIndex(-1);
                  triggerRefs.current[group.id]?.focus();
                }}
                onKeyDown={(e) => handleMenuKeyDown(e, group)}
                itemRefs={menuItemRefs}
              />
            )}
          </div>
        );
      })}
    </nav>
  );
};
