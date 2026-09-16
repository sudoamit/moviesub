'use client';

import React from 'react';
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

interface TerminalWorkspaceProps {
  selectedSymbol: string;
  selectedTimeframe: string;
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
  chartSnapshot,
  isDataUnavailable,
  signals,
  selectedSignal,
  currentTicker,
  activePosition,
  activeExecution,
  onSelectSymbol,
  onSelectTimeframe,
  onOpenOptionChain,
  onClosePosition,
}) => {
  const isOptionsAsset = selectedSymbol === 'NIFTY' || selectedSymbol === 'BANKNIFTY';

  return (
    <div className="space-y-5">
      {/* Top Workspace Grid: Left Chart (65-70%) & Right Signal Summary (30-35%) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left: Chart & Options Strike Card */}
        <div className="lg:col-span-8 xl:col-span-8 space-y-4">
          <TradingChart
            symbol={selectedSymbol}
            timeframe={selectedTimeframe}
            snapshot={chartSnapshot}
            isDataUnavailable={isDataUnavailable}
            signal={selectedSignal}
            liveChangePercent={currentTicker.changePercent}
            isTradeActive={activePosition?.status === 'OPEN'}
            onTimeframeChange={onSelectTimeframe}
            onSymbolChange={onSelectSymbol}
          />

          {isOptionsAsset && (
            <SmartStrikeCard
              symbol={selectedSymbol}
              direction={selectedSignal?.direction === 'BEARISH' ? 'BEARISH' : 'BULLISH'}
              spotPrice={currentTicker.price}
              onOpenChain={onOpenOptionChain}
            />
          )}
        </div>

        {/* Right: Signal Summary & Institutional Gauges */}
        <div className="lg:col-span-4 xl:col-span-4 space-y-4">
          <SignalSummaryCard
            signal={selectedSignal}
            symbol={selectedSymbol}
            livePrice={currentTicker.price}
          />

          <ScoreGauge
            score={selectedSignal?.score || 0}
            grade={(selectedSignal?.grade as any) || 'NO_TRADE'}
            breakdown={selectedSignal?.scoreBreakdown}
          />

          <MTFHeatmap
            selectedSymbol={selectedSymbol}
            onSelectSymbol={onSelectSymbol}
            signals={signals}
          />
        </div>
      </div>

      {/* Middle: Backend-Authoritative Execution Timeline Desk */}
      <ExecutionTimeline
        symbol={selectedSymbol}
        signal={selectedSignal}
        position={activePosition}
        execution={activeExecution}
        onClosePosition={onClosePosition}
      />

      {/* Live Position Tracker (Historical & Portfolio Metrics) */}
      <LivePositionTracker
        symbol={selectedSymbol}
        signal={selectedSignal}
        livePrice={currentTicker.price ?? 0}
      />

      {/* Quant Intelligence Engine Panel */}
      <QuantIntelligencePanel
        currentSymbol={selectedSymbol}
        activeSignal={selectedSignal}
        livePrice={currentTicker.price}
      />

      {/* Supporting Analytics Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <ReasoningCard signal={selectedSignal} />
        <RiskWidget selectedSignal={selectedSignal} />
      </div>

      {/* Trade Journal & Audit History */}
      <TradeJournal
        currentSymbol={selectedSymbol}
        activeSignal={selectedSignal}
        livePrice={currentTicker.price}
      />
    </div>
  );
};
