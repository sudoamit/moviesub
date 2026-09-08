import React from 'react';
interface SmartStrikeCardProps {
    symbol: string;
    direction: 'BULLISH' | 'BEARISH';
    spotPrice: number;
    onOpenChain: () => void;
}
export declare const SmartStrikeCard: React.FC<SmartStrikeCardProps>;
export {};
