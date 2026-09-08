import React from 'react';
import { ISignalSetup } from '@quant/shared';
interface MTFHeatmapProps {
    selectedSymbol: string;
    onSelectSymbol: (symbol: string) => void;
    signals?: ISignalSetup[];
}
export declare const MTFHeatmap: React.FC<MTFHeatmapProps>;
export {};
