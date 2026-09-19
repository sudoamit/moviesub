'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { ISignalSetup } from '@quant/shared';
import { MarketStreamProvider, useMarketStream } from '../context/MarketStreamContext';
import { Header, NavTab, StrategyMode } from '../components/Header';
import { MarketContextBar } from '../components/MarketContextBar';
import { OptionChainModal } from '../components/OptionChainModal';
import { AlertsManagerModal } from '../components/AlertsManagerModal';
import { AICopilotModal } from '../components/AICopilotModal';
import { TerminalWorkspace } from '../workspaces/TerminalWorkspace';
import { AnalyzeWorkspace } from '../workspaces/AnalyzeWorkspace';
import { TradeWorkspace } from '../workspaces/TradeWorkspace';
import { ResearchWorkspace } from '../workspaces/ResearchWorkspace';
import { AutomationWorkspace } from '../workspaces/AutomationWorkspace';
import { HistoryWorkspace } from '../workspaces/HistoryWorkspace';
import { useMarketContext } from '../hooks/useMarketContext';
import { useSignals } from '../hooks/useSignals';
import { usePaperTrading } from '../hooks/usePaperTrading';
import { ShieldAlert, CheckCircle2, Zap, Info, AlertTriangle, X } from 'lucide-react';

function DashboardContent() {
  const [activeTab, setActiveTab] = useState<NavTab>('terminal');
  const [selectedStrategy, setSelectedStrategy] = useState<StrategyMode>('SMC');
  const [isOptionChainModalOpen, setIsOptionChainModalOpen] = useState<boolean>(false);
  const [isAlertsModalOpen, setIsAlertsModalOpen] = useState<boolean>(false);
  const [isAICopilotModalOpen, setIsAICopilotModalOpen] = useState<boolean>(false);

  // Central Market Data & Chart Snapshot Hook
  const {
    selectedSymbol,
    selectedTimeframe,
    chartSnapshot,
    isDataUnavailable,
    currentTicker,
    marketDataState,
    setSelectedSymbol,
    setSelectedTimeframe,
  } = useMarketContext('NIFTY', '15m');

  // Central Signals & Scanner Hook
  const { signals, selectedSignal, isScanning, triggerScan, fetchSignals, setSelectedSignal } =
    useSignals(selectedSymbol, selectedTimeframe, selectedStrategy);

  // Central Backend-Authoritative Paper Trading & Execution Hook
  const {
    portfolio,
    activePositionForSymbol,
    activeExecutionForSymbol,
    isPlacingOrder,
    closePosition,
  } = usePaperTrading(selectedSymbol);

  const { activeToast, dismissToast, tickers, isConnected } = useMarketStream();

  // Load / Persist User Preferences & URL Path Routing
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const pathSegment = window.location.pathname.replace(/^\/+/, '').split('/')[0].toLowerCase();
      const pathToTabMap: Record<string, NavTab> = {
        terminal: 'terminal',
        quant: 'quant',
        scanner: 'scanner',
        multichart: 'multichart',
        radar: 'radar',
        smt: 'smt',
        correlation: 'correlation',
        macro: 'macro',
        analyze: 'quant',
        paper: 'paper',
        options: 'options',
        risk: 'risk',
        trade: 'paper',
        learning: 'learning',
        research: 'learning',
        backtest: 'backtest',
        algo: 'algo',
        automation: 'algo',
        journal: 'journal',
        history: 'journal',
      };

      if (pathSegment && pathToTabMap[pathSegment]) {
        setActiveTab(pathToTabMap[pathSegment]);
      } else {
        const savedTab = localStorage.getItem('quant_active_tab') as NavTab | null;
        if (savedTab) {
          setActiveTab(savedTab);
        }
      }

      const savedStrat = localStorage.getItem('quant_selected_strategy') as StrategyMode | null;
      if (savedStrat === 'SAIYAN_OCC' || savedStrat === 'HYBRID' || savedStrat === 'SMC') {
        setSelectedStrategy(savedStrat);
      }
    }
  }, []);

  const handleSelectStrategy = (strat: StrategyMode) => {
    setSelectedStrategy(strat);
    if (typeof window !== 'undefined') {
      localStorage.setItem('quant_selected_strategy', strat);
    }
    fetchSignals(selectedTimeframe, strat);
  };

  const handleSelectTab = (tab: NavTab) => {
    setActiveTab(tab);
    if (typeof window !== 'undefined') {
      localStorage.setItem('quant_active_tab', tab);
      window.history.pushState(null, '', `/${tab}`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  // Determine which workspace to render based on activeTab
  const isTerminal = activeTab === 'terminal';
  const isAnalyze =
    activeTab === 'quant' ||
    activeTab === 'scanner' ||
    activeTab === 'multichart' ||
    activeTab === 'radar' ||
    activeTab === 'smt' ||
    activeTab === 'correlation' ||
    activeTab === 'macro';
  const isTrade = activeTab === 'options' || activeTab === 'paper' || activeTab === 'risk';
  const isResearch =
    activeTab === 'learning' || activeTab === 'research' || activeTab === 'backtest';
  const isAutomation = activeTab === 'algo';
  const isHistory = activeTab === 'journal';

  return (
    <div className="min-h-screen bg-background text-slate-100 flex flex-col font-sans selection:bg-cyan-500 selection:text-slate-950">
      {/* 1. Global Grouped Header Navigation */}
      <Header
        activeTab={activeTab}
        onSelectTab={handleSelectTab}
        marketDataState={marketDataState}
        onTriggerScan={triggerScan}
        isScanning={isScanning}
        selectedStrategy={selectedStrategy}
        onSelectStrategy={handleSelectStrategy}
        onOpenAlertsModal={() => setIsAlertsModalOpen(true)}
        onOpenAICopilotModal={() => setIsAICopilotModalOpen(true)}
      />

      {/* 2. Authoritative Market Context Bar */}
      <MarketContextBar
        selectedSymbol={selectedSymbol}
        selectedTimeframe={selectedTimeframe}
        currentTicker={currentTicker}
        marketDataState={marketDataState}
        selectedStrategy={selectedStrategy}
        onSelectSymbol={setSelectedSymbol}
        onSelectTimeframe={setSelectedTimeframe}
        onSelectStrategy={handleSelectStrategy}
      />

      {/* 3. Main Product Workspace */}
      <main className="flex-1 p-3 sm:p-5 max-w-[1720px] mx-auto w-full">
        {isTerminal && (
          <TerminalWorkspace
            selectedSymbol={selectedSymbol}
            selectedTimeframe={selectedTimeframe}
            chartSnapshot={chartSnapshot}
            isDataUnavailable={isDataUnavailable}
            signals={signals}
            selectedSignal={selectedSignal}
            currentTicker={currentTicker}
            activePosition={activePositionForSymbol}
            activeExecution={activeExecutionForSymbol}
            onSelectSymbol={setSelectedSymbol}
            onSelectTimeframe={setSelectedTimeframe}
            onOpenOptionChain={() => setIsOptionChainModalOpen(true)}
            onClosePosition={closePosition}
          />
        )}

        {isAnalyze && (
          <AnalyzeWorkspace
            activeTab={activeTab}
            selectedSymbol={selectedSymbol}
            selectedSignal={selectedSignal}
            signals={signals}
            tickers={tickers}
            currentTicker={currentTicker}
            isScanning={isScanning}
            onSelectSymbol={setSelectedSymbol}
            onSelectSignal={(s) => {
              setSelectedSymbol(s.symbol);
              setSelectedSignal(s);
            }}
            onRefreshScan={triggerScan}
            onNavigateToTerminal={() => handleSelectTab('terminal')}
          />
        )}

        {isTrade && (
          <TradeWorkspace
            activeTab={activeTab}
            selectedSymbol={selectedSymbol}
            selectedSignal={selectedSignal}
            tickers={tickers}
            currentTicker={currentTicker}
          />
        )}

        {isResearch && <ResearchWorkspace activeTab={activeTab} selectedSymbol={selectedSymbol} />}

        {isAutomation && <AutomationWorkspace />}

        {isHistory && (
          <HistoryWorkspace
            selectedSymbol={selectedSymbol}
            selectedSignal={selectedSignal}
            livePrice={currentTicker.price}
          />
        )}
      </main>

      {/* 4. Unified Consolidated Toast Notification Surface (Requirement 18) */}
      {activeToast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-5 right-5 z-50 max-w-sm w-full animate-in slide-in-from-bottom-5 font-mono duration-200"
        >
          <div
            className={`p-4 rounded-xl border shadow-2xl backdrop-blur-md flex items-start justify-between gap-3 ${
              activeToast.type === 'error'
                ? 'bg-rose-950/95 border-rose-500/70 text-rose-200'
                : activeToast.type === 'success'
                  ? 'bg-emerald-950/95 border-emerald-500/70 text-emerald-200'
                  : activeToast.type === 'warning'
                    ? 'bg-amber-950/95 border-amber-500/70 text-amber-200'
                    : 'bg-surface-elevated/95 border-cyan-500/70 text-cyan-200'
            }`}
          >
            <div className="flex items-start gap-2.5">
              {activeToast.type === 'error' ? (
                <ShieldAlert className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
              ) : activeToast.type === 'success' ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
              ) : activeToast.type === 'warning' ? (
                <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              ) : (
                <Info className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5" />
              )}
              <div>
                <h4 className="font-bold text-xs uppercase tracking-wide">{activeToast.title}</h4>
                <p className="text-xs mt-1 text-slate-300 leading-snug">{activeToast.message}</p>
              </div>
            </div>

            <button
              type="button"
              onClick={dismissToast}
              aria-label="Dismiss Notification"
              className="text-slate-400 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Modals */}
      <OptionChainModal
        isOpen={isOptionChainModalOpen}
        onClose={() => setIsOptionChainModalOpen(false)}
        symbol={
          selectedSymbol === 'NIFTY' || selectedSymbol === 'BANKNIFTY' ? selectedSymbol : 'NIFTY'
        }
        spotPrice={
          tickers[
            selectedSymbol === 'NIFTY' || selectedSymbol === 'BANKNIFTY' ? selectedSymbol : 'NIFTY'
          ]?.price || currentTicker.price
        }
      />

      <AlertsManagerModal isOpen={isAlertsModalOpen} onClose={() => setIsAlertsModalOpen(false)} />

      {/* Footer */}
      <footer className="border-t border-surface-border bg-surface-subtle px-5 py-3 text-center text-xs text-slate-500 font-mono">
        QUANT INTELLIGENCE TRADING PLATFORM • REAL-TIME CANONICAL SMC EXECUTION ENGINE
      </footer>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <MarketStreamProvider>
      <DashboardContent />
    </MarketStreamProvider>
  );
}
