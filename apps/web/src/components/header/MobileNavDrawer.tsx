'use client';

import React from 'react';
import { NavTab, NAV_GROUPS } from './PrimaryNavigation';

interface MobileNavDrawerProps {
  isOpen: boolean;
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  onClose: () => void;
}

export const MobileNavDrawer: React.FC<MobileNavDrawerProps> = ({
  isOpen,
  activeTab,
  onSelectTab,
  onClose,
}) => {
  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-label="Mobile Navigation Menu"
      aria-modal="true"
      className="lg:hidden mt-2 pt-3 border-t border-surface-border space-y-4 font-mono animate-in fade-in slide-in-from-top-2 duration-150"
    >
      <div className="space-y-3 max-h-[70vh] overflow-y-auto px-1 pb-4">
        {NAV_GROUPS.map((group) => {
          const isGroupActive = group.items.some((i) => i.id === activeTab);
          return (
            <div key={group.id} className="space-y-1.5">
              <div className="flex items-center justify-between px-1 text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                <span>{group.label}</span>
                {isGroupActive && (
                  <span className="text-[9px] text-cyan-400 bg-cyan-950 border border-cyan-800 px-1 py-0.5 rounded font-black">
                    ACTIVE
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {group.items.map((item) => {
                  const isItemActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        onSelectTab(item.id);
                        onClose();
                      }}
                      className={`p-2 rounded-lg text-left text-xs transition-colors flex items-center justify-between border ${
                        isItemActive
                          ? 'bg-surface-elevated border-cyan-500/40 text-cyan-300 font-bold shadow-sm'
                          : 'bg-surface-panel border-surface-border text-slate-300 hover:text-white hover:bg-surface-hover'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {item.icon}
                        <span className="truncate">{item.label}</span>
                      </div>
                      {item.badge && (
                        <span className="text-[9px] px-1 py-0.2 rounded font-black bg-cyan-950 text-cyan-400 border border-cyan-800">
                          {item.badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
