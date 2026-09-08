import React from 'react';
interface OptionChainModalProps {
    symbol: string;
    isOpen: boolean;
    onClose: () => void;
    spotPrice?: number;
}
export declare const OptionChainModal: React.FC<OptionChainModalProps>;
export {};
