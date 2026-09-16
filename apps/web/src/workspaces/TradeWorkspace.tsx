'use client';

import React from 'react';
import { NavTab } from '../components/Header';
import { ISignalSetup } from '@quant/shared';
import { ITickerInfo } from '../components/LiveTickerBar';
import { OptionsSuiteView } from '../components/OptionsSuiteView';
import { PaperTradingWidget } from '../components/PaperTradingWidget';
import { RiskWidget } from '../components/RiskWidget';
import { ReasoningCard } from '../components/ReasoningCard';

interface TradeWorkspaceProps {
  activeTab: NavTab;
  selectedSymbol: string;
  selectedSignal: ISignalSetup | null;
  tickers: Record<string, ITickerInfo>;
  currentTicker: ITickerInfo;
}

export const TradeWorkspace: React.FC<TradeWorkspaceProps> = ({
  activeTab,
  selectedSymbol,
  selectedSignal,
  tickers,
  currentTicker,
}) => {
  if (activeTab === 'options') {
    const isOptionAsset = selectedSymbol === 'NIFTY' || selectedSymbol === 'BANKNIFTY';
    const sym = isOptionAsset ? selectedSymbol : 'NIFTY';
    return (
      <div className="space-y-5">
        <OptionsSuiteView
          initialSymbol={sym}
          liveSpotPrice={tickers[sym]?.price || currentTicker.price}
        />
      </div>
    );
  }

  if (activeTab === 'paper') {
    return (
      <div className="space-y-5">
        <PaperTradingWidget
          currentSymbol={selectedSymbol}
          activeSignal={selectedSignal}
          livePrice={currentTicker.price}
        />
      </div>
    );
  }

  if (activeTab === 'risk') {
    return (
      <div className="space-y-5 max-w-4xl mx-auto">
        <RiskWidget selectedSignal={selectedSignal} />
        <ReasoningCard signal={selectedSignal} />
      </div>
    );
  }

  return null;
};
