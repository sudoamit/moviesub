import React from 'react';
export type NavTab = 'terminal' | 'quant' | 'learning' | 'research' | 'options' | 'multichart' | 'radar' | 'smt' | 'correlation' | 'paper' | 'algo' | 'macro' | 'scanner' | 'backtest' | 'journal' | 'risk';
export type StrategyMode = 'SMC' | 'SAIYAN_OCC' | 'HYBRID';
interface HeaderProps {
    activeTab: NavTab;
    onSelectTab: (tab: NavTab) => void;
    isConnected: boolean;
    onTriggerScan: () => void;
    isScanning: boolean;
    selectedStrategy?: StrategyMode;
    onSelectStrategy?: (strategy: StrategyMode) => void;
    onOpenAlertsModal?: () => void;
    onOpenAICopilotModal?: () => void;
}
export declare const Header: React.FC<HeaderProps>;
export {};
