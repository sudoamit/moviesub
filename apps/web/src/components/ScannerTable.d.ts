import React from 'react';
import { ISignalSetup } from '@quant/shared';
interface ScannerTableProps {
    signals: ISignalSetup[];
    selectedSymbol: string;
    onSelectSignal: (signal: ISignalSetup) => void;
    onRefreshScan: () => void;
    isScanning: boolean;
}
export declare const ScannerTable: React.FC<ScannerTableProps>;
export {};
