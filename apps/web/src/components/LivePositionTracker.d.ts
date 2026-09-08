import React from 'react';
import { ISignalSetup } from '@quant/shared';
interface LivePositionTrackerProps {
    symbol: string;
    signal: ISignalSetup | null;
    livePrice: number;
    onClosePosition?: (exitPrice: number, pnl: number, r: number, reason: string) => void;
}
export declare const LivePositionTracker: React.FC<LivePositionTrackerProps>;
export {};
