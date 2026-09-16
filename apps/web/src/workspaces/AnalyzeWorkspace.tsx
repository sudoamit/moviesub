'use client';

import React from 'react';
import { NavTab } from '../components/Header';
import { ISignalSetup } from '@quant/shared';
import { ITickerInfo } from '../components/LiveTickerBar';
import { QuantIntelligencePanel } from '../components/QuantIntelligencePanel';
import { ScannerTable } from '../components/ScannerTable';
import { MTFHeatmap } from '../components/MTFHeatmap';
import { MultiChartGrid } from '../components/MultiChartGrid';
import { MTFFlowRadarWidget } from '../components/MTFFlowRadarWidget';
import { SMTDivergenceWidget } from '../components/SMTDivergenceWidget';
import { CorrelationMatrix } from '../components/CorrelationMatrix';
import { MacroCalendarWidget } from '../components/MacroCalendarWidget';

interface AnalyzeWorkspaceProps {
  activeTab: NavTab;
  selectedSymbol: string;
  selectedSignal: ISignalSetup | null;
  signals: ISignalSetup[];
  tickers: Record<string, ITickerInfo>;
  currentTicker: ITickerInfo;
  isScanning: boolean;
  onSelectSymbol: (symbol: string) => void;
  onSelectSignal: (signal: ISignalSetup) => void;
  onRefreshScan: () => void;
  onNavigateToTerminal: () => void;
}

export const AnalyzeWorkspace: React.FC<AnalyzeWorkspaceProps> = ({
  activeTab,
  selectedSymbol,
  selectedSignal,
  signals,
  tickers,
  currentTicker,
  isScanning,
  onSelectSymbol,
  onSelectSignal,
  onRefreshScan,
  onNavigateToTerminal,
}) => {
  if (activeTab === 'quant') {
    return (
      <div className="space-y-5">
        <QuantIntelligencePanel
          currentSymbol={selectedSymbol}
          activeSignal={selectedSignal}
          livePrice={currentTicker.price}
        />
      </div>
    );
  }

  if (activeTab === 'scanner') {
    return (
      <div className="space-y-5">
        <ScannerTable
          signals={signals}
          selectedSymbol={selectedSymbol}
          onSelectSignal={(s) => {
            onSelectSignal(s);
            onNavigateToTerminal();
          }}
          onRefreshScan={onRefreshScan}
          isScanning={isScanning}
        />
        <MTFHeatmap selectedSymbol={selectedSymbol} onSelectSymbol={onSelectSymbol} />
      </div>
    );
  }

  if (activeTab === 'multichart') {
    return (
      <div className="space-y-5">
        <MultiChartGrid signals={signals} tickers={tickers} />
      </div>
    );
  }

  if (activeTab === 'radar') {
    return (
      <div className="space-y-5">
        <MTFFlowRadarWidget symbol={selectedSymbol} />
      </div>
    );
  }

  if (activeTab === 'smt') {
    return (
      <div className="space-y-5">
        <SMTDivergenceWidget />
      </div>
    );
  }

  if (activeTab === 'correlation') {
    return (
      <div className="space-y-5">
        <CorrelationMatrix tickers={tickers} />
      </div>
    );
  }

  if (activeTab === 'macro') {
    return (
      <div className="space-y-5">
        <MacroCalendarWidget />
      </div>
    );
  }

  return null;
};
