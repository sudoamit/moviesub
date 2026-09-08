import React from 'react';
import { ISignalSetup } from '@quant/shared';
export interface QuantIntelligencePanelProps {
    currentSymbol: string;
    activeSignal: ISignalSetup | null;
    livePrice?: number;
}
export declare const QuantIntelligencePanel: React.FC<QuantIntelligencePanelProps>;
