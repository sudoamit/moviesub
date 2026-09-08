import React from 'react';
interface TradingChartProps {
    symbol: string;
    timeframe: string;
    candles: any[];
    signal?: any;
    livePrice?: number;
    liveChangePercent?: number;
    isTradeActive?: boolean;
    onTimeframeChange?: (tf: string) => void;
    onSymbolChange?: (symbol: string) => void;
}
export declare const TradingChart: React.FC<TradingChartProps>;
export {};
