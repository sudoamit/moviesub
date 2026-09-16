'use client';

import React, { useState } from 'react';
import { Brand } from './header/Brand';
import { MarketStatusBadge } from './header/MarketStatusBadge';
import {
  PrimaryNavigation,
  NavGroup,
  NavTab,
  NavItemConfig,
  NAV_GROUPS,
} from './header/PrimaryNavigation';
import { HeaderActions } from './header/HeaderActions';
import { MobileNavDrawer } from './header/MobileNavDrawer';
import { MarketDataState } from '../hooks/useMarketContext';

export type { NavGroup, NavTab, NavItemConfig };
export { NAV_GROUPS };
export type StrategyMode = 'SMC' | 'SAIYAN_OCC' | 'HYBRID';

interface HeaderProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  marketDataState?: MarketDataState;
  onTriggerScan: () => void;
  isScanning: boolean;
  selectedStrategy?: StrategyMode;
  onSelectStrategy?: (strategy: StrategyMode) => void;
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
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState<boolean>(false);

  // Active group sub-item navigation
  const currentGroup =
    NAV_GROUPS.find((g) => g.items.some((i) => i.id === activeTab)) || NAV_GROUPS[0];

  return (
    <header className="border-b border-surface-border bg-surface-subtle/95 backdrop-blur-md sticky top-0 z-50 px-3 sm:px-6 py-2">
      <div className="flex items-center justify-between gap-3 max-w-[1720px] mx-auto">
        {/* Left: Brand */}
        <Brand />

        {/* Center: Primary Navigation (Desktop) */}
        <PrimaryNavigation
          activeTab={activeTab}
          onSelectTab={onSelectTab}
          className="hidden lg:flex"
        />

        {/* Right: Market Status & Action Triggers */}
        <div className="flex items-center gap-2.5">
          <MarketStatusBadge marketDataState={marketDataState} />

          <HeaderActions
            onTriggerScan={onTriggerScan}
            isScanning={isScanning}
            onOpenAlertsModal={onOpenAlertsModal}
            onOpenAICopilotModal={onOpenAICopilotModal}
            isMobileMenuOpen={isMobileMenuOpen}
            onToggleMobileMenu={() => setIsMobileMenuOpen((prev) => !prev)}
          />
        </div>
      </div>

      {/* Secondary Contextual Submenu Bar for Multi-Item Active Groups (Desktop) */}
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
                className={`px-2.5 py-1 rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 ${
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
      <MobileNavDrawer
        isOpen={isMobileMenuOpen}
        activeTab={activeTab}
        onSelectTab={onSelectTab}
        onClose={() => setIsMobileMenuOpen(false)}
      />
    </header>
  );
};
