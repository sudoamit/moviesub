import React from 'react';
import { ISignalSetup } from '@quant/shared';
interface MultiChartGridProps {
    signals: ISignalSetup[];
    tickers: Record<string, any>;
}
export declare const MultiChartGrid: React.FC<MultiChartGridProps>;
export {};
