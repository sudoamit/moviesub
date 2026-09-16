'use client';

import React from 'react';
import { ISignalSetup } from '@quant/shared';
import { TradeJournal } from '../components/TradeJournal';

interface HistoryWorkspaceProps {
  selectedSymbol: string;
  selectedSignal: ISignalSetup | null;
  livePrice?: number;
}

export const HistoryWorkspace: React.FC<HistoryWorkspaceProps> = ({
  selectedSymbol,
  selectedSignal,
  livePrice,
}) => {
  return (
    <div className="space-y-5">
      <TradeJournal
        currentSymbol={selectedSymbol}
        activeSignal={selectedSignal}
        livePrice={livePrice}
      />
    </div>
  );
};
