'use client';

import React from 'react';
import { Brain, Bell, Search, Menu, X } from 'lucide-react';

interface HeaderActionsProps {
  onTriggerScan: () => void;
  isScanning: boolean;
  onOpenAlertsModal?: () => void;
  onOpenAICopilotModal?: () => void;
  isMobileMenuOpen: boolean;
  onToggleMobileMenu: () => void;
}

export const HeaderActions: React.FC<HeaderActionsProps> = ({
  onTriggerScan,
  isScanning,
  onOpenAlertsModal,
  onOpenAICopilotModal,
  isMobileMenuOpen,
  onToggleMobileMenu,
}) => {
  return (
    <div className="flex items-center gap-2">
      {/* AI Copilot Button */}
      {onOpenAICopilotModal && (
        <button
          type="button"
          onClick={onOpenAICopilotModal}
          aria-label="Open AI Copilot"
          className="hidden md:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface-panel hover:bg-surface-hover border border-surface-border text-purple-300 text-xs font-mono font-bold transition-colors shadow-sm"
        >
          <Brain className="w-3.5 h-3.5 text-purple-400" />
          <span>Copilot</span>
        </button>
      )}

      {/* Alerts Manager Button */}
      {onOpenAlertsModal && (
        <button
          type="button"
          onClick={onOpenAlertsModal}
          aria-label="Manage Alerts"
          className="hidden sm:flex p-1.5 rounded-lg bg-surface-panel hover:bg-surface-hover border border-surface-border text-slate-300 transition-colors shadow-sm"
        >
          <Bell className="w-4 h-4" />
        </button>
      )}

      {/* Trigger Scan Button */}
      <button
        type="button"
        onClick={onTriggerScan}
        disabled={isScanning}
        aria-label="Scan All Markets"
        className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs font-mono flex items-center gap-1.5 transition-colors active:scale-95 disabled:opacity-50 shadow-sm"
      >
        <Search className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`} />
        <span>{isScanning ? 'SCANNING' : 'SCAN'}</span>
      </button>

      {/* Mobile Drawer Hamburger Button */}
      <button
        type="button"
        onClick={onToggleMobileMenu}
        aria-expanded={isMobileMenuOpen}
        aria-label="Toggle Mobile Navigation Drawer"
        className="lg:hidden p-1.5 rounded-lg bg-surface-panel border border-surface-border text-slate-300 hover:text-white"
      >
        {isMobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
      </button>
    </div>
  );
};
