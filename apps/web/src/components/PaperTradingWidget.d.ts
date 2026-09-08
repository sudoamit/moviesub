import React from 'react';
import { ISignalSetup } from '@quant/shared';
interface PaperTradingWidgetProps {
    currentSymbol: string;
    activeSignal: ISignalSetup | null;
    livePrice: number;
}
export declare const PaperTradingWidget: React.FC<PaperTradingWidgetProps>;
export {};
