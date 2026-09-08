import React from 'react';
export interface ITickerInfo {
    symbol: string;
    price: number;
    changePercent: number;
    changeAmount: number;
    high: number;
    low: number;
    volume: number;
    lastTickDir?: 'UP' | 'DOWN';
}
interface LiveTickerBarProps {
    tickers: Record<string, ITickerInfo>;
    selectedSymbol: string;
    onSelectSymbol: (symbol: string) => void;
}
export declare const LiveTickerBar: React.FC<LiveTickerBarProps>;
export {};
