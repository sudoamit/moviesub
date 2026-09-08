import React from 'react';
import { ISignalSetup } from '@quant/shared';
interface TradeJournalProps {
    currentSymbol?: string;
    activeSignal?: ISignalSetup | null;
    livePrice?: number;
    onTradeClosedNotification?: (trade: any) => void;
}
export declare const TradeJournal: React.FC<TradeJournalProps>;
export {};
