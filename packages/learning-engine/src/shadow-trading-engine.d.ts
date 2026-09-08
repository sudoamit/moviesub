import { Direction } from '@quant/shared';
import { ShadowTradeRecord, StrategyCandidate } from './types';
export declare class ShadowTradingEngine {
    private static activeShadowCandidates;
    private static shadowTrades;
    /**
     * Activates a validated candidate in shadow trading mode.
     */
    static activateCandidate(candidate: StrategyCandidate): void;
    /**
     * Deactivates a candidate from shadow trading.
     */
    static deactivateCandidate(candidateId: string): void;
    /**
     * Processes a live tick / candle to record shadow executions for active shadow candidates.
     */
    static recordShadowSignal(candidateId: string, symbol: string, direction: Direction, entryPrice: number, timeframe?: string): ShadowTradeRecord;
    /**
     * Closes a shadow trade upon exit trigger.
     */
    static closeShadowTrade(shadowTradeId: string, exitPrice: number, stopLossPrice: number): ShadowTradeRecord | undefined;
    /**
     * Evaluates aggregate shadow performance for a candidate.
     */
    static getShadowPerformance(candidateId: string): {
        tradeCount: number;
        expectancyR: number;
        winRate: number;
        maxDrawdownR: number;
        trades: ShadowTradeRecord[];
    };
    /**
     * Retrieves all active shadow candidates.
     */
    static getActiveCandidates(): StrategyCandidate[];
}
