import React from 'react';
interface OptionsSuiteViewProps {
    initialSymbol?: string;
    onTradeOption?: (contract: any) => void;
    liveSpotPrice?: number;
}
export declare const OptionsSuiteView: React.FC<OptionsSuiteViewProps>;
export {};
