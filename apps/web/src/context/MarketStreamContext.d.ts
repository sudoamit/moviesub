import React, { ReactNode } from 'react';
import { ISignalSetup } from '@quant/shared';
import { ITickerInfo } from '../components/LiveTickerBar';
interface ToastInfo {
    title: string;
    message: string;
    type?: 'info' | 'success' | 'warning' | 'error';
}
interface MarketStreamContextType {
    isConnected: boolean;
    tickers: Record<string, ITickerInfo>;
    signals: ISignalSetup[];
    isScanning: boolean;
    activeToast: ToastInfo | null;
    subscribeToSymbol: (symbol: string) => void;
    triggerScan: () => Promise<void>;
    dismissToast: () => void;
    showToast: (toast: ToastInfo) => void;
}
export declare const MarketStreamProvider: React.FC<{
    children: ReactNode;
}>;
export declare const useMarketStream: () => MarketStreamContextType;
export {};
