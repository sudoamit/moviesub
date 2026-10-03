'use client';

import React, { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import dynamic from 'next/dynamic';
import { ISignalSetup, ChartMarketSnapshot } from '@quant/shared';
import { ITickerInfo } from '../components/LiveTickerBar';
import { SignalSummaryCard } from '../components/SignalSummaryCard';
import { ScoreGauge } from '../components/ScoreGauge';
import { MTFHeatmap } from '../components/MTFHeatmap';
import { SmartStrikeCard } from '../components/SmartStrikeCard';
import { ExecutionTimeline } from '../components/ExecutionTimeline';
import { LivePositionTracker } from '../components/LivePositionTracker';
import { QuantIntelligencePanel } from '../components/QuantIntelligencePanel';
import { LabStrategiesCard } from '../components/LabStrategiesCard';
import { MarketObserverCard } from '../components/MarketObserverCard';
import { NiftyLabCard } from '../components/NiftyLabCard';
import { LessonsCard } from '../components/LessonsCard';
import { ReasoningCard } from '../components/ReasoningCard';
import { RiskWidget } from '../components/RiskWidget';
import { TradeJournal } from '../components/TradeJournal';
import { AuthoritativePosition, AlgoExecutionRecord } from '../hooks/usePaperTrading';

const TradingChart = dynamic(
  () => import('../components/TradingChart').then((mod) => mod.TradingChart),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-[520px] bg-surface-panel rounded-xl flex flex-col items-center justify-center text-slate-500 border border-surface-border animate-pulse font-mono">
        <div className="w-8 h-8 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin mb-3"></div>
        <p className="text-xs text-slate-400">Loading Trading Terminal Chart...</p>
      </div>
    ),
  },
);

import { StrategyMode } from '../components/Header';

type LowerTab = 'analysis' | 'lab' | 'journal';
const LOWER_TABS: Array<{ id: LowerTab; label: string; hint: string }> = [
  { id: 'analysis', label: 'Analysis', hint: 'reasoning, risk, quant' },
  { id: 'lab', label: 'AI lab', hint: 'strategies, lessons, observer' },
  { id: 'journal', label: 'Journal', hint: 'trade history' },
];

const SectionTitle: React.FC<{ title: string }> = ({ title }) => (
  <h2 className="text-sm font-semibold text-slate-300 tracking-wide">{title}</h2>
);

interface TerminalWorkspaceProps {
  selectedSymbol: string;
  selectedTimeframe: string;
  selectedStrategy?: StrategyMode;
  onSelectStrategy?: (strategy: StrategyMode) => void;
  chartSnapshot: ChartMarketSnapshot | null;
  isDataUnavailable: boolean;
  signals: ISignalSetup[];
  selectedSignal: ISignalSetup | null;
  currentTicker: ITickerInfo;
  activePosition: AuthoritativePosition | null;
  activeExecution: AlgoExecutionRecord | null;
  onSelectSymbol: (symbol: string) => void;
  onSelectTimeframe: (timeframe: string) => void;
  onOpenOptionChain: () => void;
  onClosePosition: (positionId: string) => void;
}

export const TerminalWorkspace: React.FC<TerminalWorkspaceProps> = ({
  selectedSymbol,
  selectedTimeframe,
  selectedStrategy = 'SMC',
  onSelectStrategy,
  chartSnapshot,
  isDataUnavailable,
  signals,
  selectedSignal,
  currentTicker,
  activePosition,
  activeExecution,
  onSelectSymbol,
  onOpenOptionChain,
  onClosePosition,
}) => {
  const isOptionsAsset = selectedSymbol === 'NIFTY' || selectedSymbol === 'BANKNIFTY';
  const [tab, setTab] = useState<LowerTab>('analysis');
  const [showExecution, setShowExecution] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('quant_terminal_tab') as LowerTab | null;
      if (saved && LOWER_TABS.some((t) => t.id === saved)) setTab(saved);
    } catch {}
  }, []);

  const selectTab = (t: LowerTab) => {
    setTab(t);
    try {
      localStorage.setItem('quant_terminal_tab', t);
    } catch {}
  };

  return (
    <div className="space-y-6">
      {/* 1. Chart (left) and the current setup (right) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-8 space-y-5">
          {/* Symbol and timeframe are chosen once, in the market bar above */}
          <TradingChart
            symbol={selectedSymbol}
            timeframe={selectedTimeframe}
            snapshot={chartSnapshot}
            isDataUnavailable={isDataUnavailable}
            signal={selectedSignal}
            liveChangePercent={currentTicker.changePercent}
            isTradeActive={activePosition?.status === 'OPEN'}
          />

          {isOptionsAsset && (
            <SmartStrikeCard
              symbol={selectedSymbol}
              direction={selectedSignal?.direction === 'BEARISH' ? 'BEARISH' : 'BULLISH'}
              spotPrice={currentTicker.price}
              onOpenChain={onOpenOptionChain}
            />
          )}

          <MTFHeatmap selectedSymbol={selectedSymbol} onSelectSymbol={onSelectSymbol} signals={signals} />
        </div>

        <div className="lg:col-span-4 space-y-5">
          <SignalSummaryCard signal={selectedSignal} symbol={selectedSymbol} livePrice={currentTicker.price} />
          <ScoreGauge
            score={selectedSignal?.score || 0}
            grade={(selectedSignal?.grade as any) || 'NO_TRADE'}
            breakdown={selectedSignal?.scoreBreakdown}
          />
        </div>
      </div>

      {/* 2. Position */}
      <section className="space-y-3">
        <SectionTitle title="Position" />
        <LivePositionTracker
          symbol={selectedSymbol}
          timeframe={selectedTimeframe}
          selectedStrategy={selectedStrategy}
          onSelectStrategy={onSelectStrategy}
          signal={selectedSignal}
          livePrice={currentTicker.price ?? 0}
          activePosition={activePosition}
          activeExecution={activeExecution}
          onClosePosition={onClosePosition}
        />
        <button
          type="button"
          onClick={() => setShowExecution((v) => !v)}
          aria-expanded={showExecution}
          className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200 transition-colors"
        >
          <ChevronDown className={`w-4 h-4 transition-transform ${showExecution ? 'rotate-180' : ''}`} />
          {showExecution ? 'Hide execution details' : 'Show execution details (fill record and order lifecycle)'}
        </button>
        {showExecution && (
          <ExecutionTimeline
            symbol={selectedSymbol}
            signal={selectedSignal}
            position={activePosition}
            execution={activeExecution}
            onClosePosition={onClosePosition}
          />
        )}
      </section>

      {/* 3. Everything else, one topic at a time */}
      <section className="space-y-4">
        <div role="tablist" aria-label="Terminal sections" className="flex gap-1 border-b border-surface-border">
          {LOWER_TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              onClick={() => selectTab(t.id)}
              className={`px-4 py-2.5 -mb-px text-sm font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-cyan-400 text-white'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.label}
              <span className="ml-2 text-xs text-slate-500 hidden sm:inline">{t.hint}</span>
            </button>
          ))}
        </div>

        {tab === 'analysis' && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <ReasoningCard signal={selectedSignal} />
              <RiskWidget selectedSignal={selectedSignal} />
            </div>
            <QuantIntelligencePanel currentSymbol={selectedSymbol} activeSignal={selectedSignal} livePrice={currentTicker.price} />
          </div>
        )}

        {tab === 'lab' && (
          <div className="space-y-5">
            <LabStrategiesCard />
            <NiftyLabCard />
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 items-start">
              <LessonsCard />
              <MarketObserverCard />
            </div>
          </div>
        )}

        {tab === 'journal' && (
          <TradeJournal currentSymbol={selectedSymbol} activeSignal={selectedSignal} livePrice={currentTicker.price} />
        )}
      </section>
    </div>
  );
};
